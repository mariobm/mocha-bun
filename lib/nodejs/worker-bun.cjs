/**
 * Bun-native worker process. Mirrors lib/nodejs/worker.cjs but uses
 * process.on('message') instead of workerpool for IPC.
 * @private
 * @module worker-bun
 */

"use strict";

const {
  createInvalidArgumentTypeError,
  createInvalidArgumentValueError,
} = require("../errors.cjs");
const Mocha = require("../mocha.cjs");
const {
  handleRequires,
  validateLegacyPlugin,
} = require("../cli/run-helpers.cjs");
const d = require("debug");
const debug = d.debug(`mocha:parallel:worker-bun:${process.pid}`);
const isDebugEnabled = d.enabled(`mocha:parallel:worker-bun:${process.pid}`);
const { serialize } = require("./serializer.js");
const _globalWB = typeof globalThis !== "undefined" ? globalThis : global;
const { setInterval, clearInterval } = _globalWB;

let rootHooks;

let bootstrap = async (argv) => {
  const plugins = await handleRequires(argv.require, {
    ignoredPlugins: ["mochaGlobalSetup", "mochaGlobalTeardown"],
  });
  validateLegacyPlugin(argv, "ui", Mocha.interfaces);
  rootHooks = plugins.rootHooks;
  bootstrap = () => {};
  debug("bootstrap(): finished with args: %O", argv);
};

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
    parallel: false,
    forbidOnly: true,
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
    if (isDebugEnabled) {
      debugInterval = setInterval(() => {
        debug("run(): still running %s...", filepath);
      }, 5000).unref();
    }
    mocha.run((result) => {
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
        debug("run(): serialization failed; rejecting: %O", err);
        reject(err);
      } finally {
        clearInterval(debugInterval);
      }
    });
  });
}

// Bun pool protocol: parent sends {cmd:'run', id, filepath, serializedOptions}
// child replies {id, result} or {id, error:{message,stack,code}}
if (process.send) {
  process.on("message", async (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.cmd === "run") {
      const { id, filepath, serializedOptions } = msg;
      try {
        const result = await run(filepath, serializedOptions);
        if (process.send) process.send({ id, result });
      } catch (err) {
        if (process.send)
          process.send({
            id,
            error: {
              message: err.message,
              stack: err.stack,
              code: err.code,
              name: err.name,
            },
          });
      }
    } else if (msg.cmd === "exit") {
      process.exit(0);
    }
  });
  // Signal ready (useful for pool to know worker is initialized)
  if (process.send) process.send({ ready: true });
  debug("started Bun worker process, waiting for messages");
} else {
  debug("worker-bun started without IPC (process.send not available)");
}

exports.run = run;
