/**
 * A worker process.  Consumes {@link module:reporters/parallel-buffered} reporter.
 * @module worker
 * @private
 */

"use strict";

/**
 * @typedef {import('../types.d.ts').BufferedEvent} BufferedEvent
 * @typedef {import('../types.d.ts').MochaOptions} MochaOptions
 */

let createInvalidArgumentTypeError, createInvalidArgumentValueError;
try {
  ({
    createInvalidArgumentTypeError,
    createInvalidArgumentValueError,
  } = require("../errors.cjs"));
} catch {
  ({
    createInvalidArgumentTypeError,
    createInvalidArgumentValueError,
  } = require("../errors.js"));
}
const { Piscina } = require("piscina");
const Mocha = require("../mocha.cjs");
const {
  handleRequires,
  validateLegacyPlugin,
} = require("../cli/run-helpers.cjs");
const d = require("debug");
const debug = d.debug(`mocha:parallel:worker:${process.pid}`);
const isDebugEnabled = d.enabled(`mocha:parallel:worker:${process.pid}`);
const { serialize } = require("./serializer.js");
const { setInterval, clearInterval } = global;

let rootHooks;

if (!Piscina.isWorkerThread) {
  throw new Error(
    "This script is intended to be run as a worker (by Piscina).",
  );
}

const { threadId } = require("node:worker_threads");
// Piscina threads share PID but need unique IDs for Mocha's per-worker fixtures
// threadId starts at 1, but Mocha expects 0-based IDs (as workerpool did with counter 0,1,2)
process.env.MOCHA_WORKER_ID = String(threadId - 1);

/**
 * Initializes some stuff on the first call to {@link run}.
 *
 * Handles `--require` and `--ui`.  Does _not_ handle `--reporter`,
 * as only the `Buffered` reporter is used.
 *
 * **This function only runs once per worker**; it overwrites itself with a no-op
 * before returning.
 *
 * @param {MochaOptions} argv - Command-line options
 */
let bootstrap = async (argv) => {
  // globalSetup and globalTeardown do not run in workers
  const plugins = await handleRequires(argv.require, {
    ignoredPlugins: ["mochaGlobalSetup", "mochaGlobalTeardown"],
  });
  validateLegacyPlugin(argv, "ui", Mocha.interfaces);

  rootHooks = plugins.rootHooks;
  bootstrap = () => {};
  debug("bootstrap(): finished with args: %O", argv);
};

/**
 * Runs a single test file in a worker thread.
 * @param {string} filepath - Filepath of test file
 * @param {string} [serializedOptions] - **Serialized** options. This string will be eval'd!
 * @see https://npm.im/serialize-javascript
 * @returns {Promise<{failures: number, events: BufferedEvent[]}>} - Test
 * failure count and list of events.
 */
async function run(filepath, serializedOptions = "{}") {
  if (!filepath) {
    throw createInvalidArgumentTypeError(
      'Expected a non-empty "filepath" argument',
      "file",
      "string",
    );
  }

  debug("run(): running test file %s", filepath);

  if (typeof serializedOptions !== "string") {
    throw createInvalidArgumentTypeError(
      "run() expects second parameter to be a string which was serialized by the `serialize-javascript` module",
      "serializedOptions",
      "string",
    );
  }
  let argv;
  try {
    argv = eval("(" + serializedOptions + ")");
  } catch {
    throw createInvalidArgumentValueError(
      "run() was unable to deserialize the options",
      "serializedOptions",
      serializedOptions,
    );
  }

  const opts = Object.assign({ ui: "bdd" }, argv, {
    // if this was true, it would cause infinite recursion.
    parallel: false,
    // this doesn't work in parallel mode
    forbidOnly: true,
    // it's useful for a Mocha instance to know if it's running in a worker process.
    isWorker: true,
  });

  await bootstrap(opts);

  opts.rootHooks = rootHooks;

  const mocha = new Mocha(opts).addFile(filepath);

  try {
    await mocha.loadFilesAsync();
  } catch (err) {
    debug("run(): could not load file %s: %s", filepath, err);
    throw err;
  }

  return new Promise((resolve, reject) => {
    let debugInterval;
    /* istanbul ignore next */
    if (isDebugEnabled) {
      debugInterval = setInterval(() => {
        debug("run(): still running %s...", filepath);
      }, 5000).unref();
    }
    mocha.run((result) => {
      // Runner adds these; if we don't remove them, we'll get a leak.
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");

      try {
        const serialized = serialize(result);
        debug(
          "run(): completed run with %d test failures; returning to main process",
          typeof result.failures === "number" ? result.failures : 0,
        );
        resolve(serialized);
      } catch (err) {
        // TODO: figure out exactly what the sad path looks like here.
        // rejection should only happen if an error is "unrecoverable"
        debug("run(): serialization failed; rejecting: %O", err);
        reject(err);
      } finally {
        clearInterval(debugInterval);
      }
    });
  });
}

// Piscina worker: export run for piscina.run({filepath, serializedOptions})
// Support both piscina (single object arg) and direct (filepath, serializedOptions)
async function piscinaHandler(task) {
  if (task && typeof task === "object" && "filepath" in task) {
    return run(task.filepath, task.serializedOptions);
  }
  // fallback for direct call with two args (should not happen via piscina)
  return run(task, arguments[1]);
}
module.exports = piscinaHandler;
module.exports.run = run;
module.exports.default = piscinaHandler;

debug("started Piscina worker thread");

// for testing
exports.run = run;
