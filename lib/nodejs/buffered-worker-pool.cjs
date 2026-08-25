/**
 * A wrapper around a third-party child process worker pool implementation.
 * Used by {@link module:buffered-runner}.
 * @private
 * @module buffered-worker-pool
 */

"use strict";

/**
 * @typedef {import('../types.d.ts').MochaOptions} MochaOptions
 * @typedef {import('../types.d.ts').SerializedWorkerResult} SerializedWorkerResult
 */

const serializeJavascript = require("serialize-javascript");
const { Piscina } = require("piscina");
const os = require("node:os");
const { deserialize } = require("./serializer.js");
const debug = require("debug")("mocha:parallel:buffered-worker-pool");
let createInvalidArgumentTypeError;
try {
  ({ createInvalidArgumentTypeError } = require("../errors.cjs"));
} catch {
  ({ createInvalidArgumentTypeError } = require("../errors.js"));
}

const WORKER_PATH = require.resolve("./worker.cjs");
const cpus = os.cpus().length;
const isBun = !!process.versions.bun || typeof Bun !== "undefined";
const WORKER_POOL_DEFAULT_OPTS = {
  maxWorkers: Math.max(1, cpus - 1),
};

/**
 * A mapping of Mocha `Options` objects to serialized values.
 *
 * This is helpful because we tend to same the same options over and over
 * over IPC.
 * @type {WeakMap<MochaOptions,string>}
 */
let optionsCache = new WeakMap();

/**
 * A wrapper around Piscina worker pool (used for both Node and Bun).
 * Previously Bun used BunForkPool (fork), now both use Piscina thread pool.
 * @private
 */
class BufferedWorkerPool {
  /**
   * Creates an underlying worker pool instance; determines max worker count
   * @param {Partial<WorkerPoolOptions>} [opts] - Options
   */
  constructor(opts = {}) {
    const maxWorkers = Math.max(
      1,
      typeof opts.maxWorkers === "undefined"
        ? WORKER_POOL_DEFAULT_OPTS.maxWorkers
        : opts.maxWorkers,
    );

    /* istanbul ignore next */
    if (cpus < 2) {
      debug(
        "not enough CPU cores available to run multiple jobs; avoid --parallel on this machine",
      );
    } else if (maxWorkers >= cpus) {
      debug(
        "%d concurrent job(s) requested, but only %d core(s) available",
        maxWorkers,
        cpus,
      );
    }
    /* istanbul ignore next */
    debug(
      "run(): starting worker pool of max size %d, using node args: %s (isBun=%s)",
      maxWorkers,
      process.execArgv.join(" "),
      isBun,
    );

    let counter = 0;
    const onCreateWorker = ({ forkOpts }) => {
      return {
        forkOpts: {
          ...forkOpts,
          env: { ...process.env, MOCHA_WORKER_ID: counter++ },
        },
      };
    };

    this.options = {
      ...WORKER_POOL_DEFAULT_OPTS,
      ...opts,
      maxWorkers,
      onCreateWorker,
    };
    // Use Piscina for both Node and Bun (piscina works on Bun via worker_threads)
    debug("using Piscina pool (isBun=%s)", isBun);
    this._pool = new Piscina({
      filename: WORKER_PATH,
      maxThreads: maxWorkers,
      minThreads: 0,
      idleTimeout: 5000,
      execArgv: process.execArgv,
    });
  }

  /**
   * Terminates all workers in the pool.
   * @param {boolean} [force] - Whether to force-kill workers. By default, lets workers finish their current task before termination.
   * @private
   * @returns {Promise<void>}
   */
  async terminate(force = false) {
    /* istanbul ignore next */
    debug("terminate(): terminating with force = %s", force);
    if (force) {
      return this._pool.destroy();
    }
    return this._pool.close();
  }

  /**
   * Adds a test file run to the worker pool queue for execution by a worker process.
   *
   * Handles serialization/deserialization.
   *
   * @param {string} filepath - Filepath of test
   * @param {MochaOptions} [options] - Options for Mocha instance
   * @private
   * @returns {Promise<SerializedWorkerResult>}
   */
  async run(filepath, options = {}) {
    if (!filepath || typeof filepath !== "string") {
      throw createInvalidArgumentTypeError(
        "Expected a non-empty filepath",
        "filepath",
        "string",
      );
    }
    const serializedOptions = BufferedWorkerPool.serializeOptions(options);
    const result = await this._pool.run({ filepath, serializedOptions });
    return deserialize(result);
  }

  /**
   * Returns stats about the state of the worker processes in the pool.
   *
   * Used for debugging.
   *
   * @private
   */
  stats() {
    const totalWorkers = this._pool.threads.length;
    const pendingTasks = this._pool.queueSize;
    const busyWorkers = pendingTasks > 0 ? totalWorkers : Math.min(totalWorkers, 1);
    return {
      totalWorkers,
      busyWorkers,
      idleWorkers: totalWorkers - busyWorkers,
      pendingTasks,
    };
  }

  /**
   * Instantiates a {@link WorkerPool}.
   * @private
   */
  static create(...args) {
    return new BufferedWorkerPool(...args);
  }

  /**
   * Given Mocha options object `opts`, serialize into a format suitable for
   * transmission over IPC.
   *
   * @param {MochaOptions} [opts] - Mocha options
   * @private
   * @returns {string} Serialized options
   */
  static serializeOptions(opts = {}) {
    if (!optionsCache.has(opts)) {
      const serialized = serializeJavascript(opts, {
        unsafe: true, // this means we don't care about XSS
        ignoreFunction: true, // do not serialize functions
      });
      optionsCache.set(opts, serialized);
      /* istanbul ignore next */
      debug(
        "serializeOptions(): serialized options %O to: %s",
        opts,
        serialized,
      );
    }
    return optionsCache.get(opts);
  }

  /**
   * Resets internal cache of serialized options objects.
   *
   * For testing/debugging
   * @private
   */
  static resetOptionsCache() {
    optionsCache = new WeakMap();
  }
}

exports.BufferedWorkerPool = BufferedWorkerPool;
