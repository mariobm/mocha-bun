/**
 * A wrapper around a third-party child process worker pool implementation.
 * Used by {@link module:buffered-runner}.
 * @private
 * @module buffered-worker-pool
 */

"use strict";

/**
 * @typedef {import('workerpool').WorkerPoolOptions} WorkerPoolOptions
 * @typedef {import('../types.d.ts').MochaOptions} MochaOptions
 * @typedef {import('../types.d.ts').SerializedWorkerResult} SerializedWorkerResult
 */

const serializeJavascript = require("serialize-javascript");
const workerpool = require("workerpool");
const { deserialize } = require("./serializer.js");
const debug = require("debug")("mocha:parallel:buffered-worker-pool");
let createInvalidArgumentTypeError;
try {
  ({ createInvalidArgumentTypeError } = require("../errors.cjs"));
} catch {
  ({ createInvalidArgumentTypeError } = require("../errors.js"));
}

const WORKER_PATH = require.resolve("./worker.cjs");
const WORKER_BUN_PATH = require.resolve("./worker-bun.cjs");

/**
 * A mapping of Mocha `Options` objects to serialized values.
 *
 * This is helpful because we tend to same the same options over and over
 * over IPC.
 * @type {WeakMap<MochaOptions,string>}
 */
let optionsCache = new WeakMap();

/**
 * These options are passed into the [workerpool](https://npm.im/workerpool) module.
 * @type {Partial<WorkerPoolOptions>}
 */
const isBun = !!process.versions.bun || typeof Bun !== "undefined";
const WORKER_POOL_DEFAULT_OPTS = {
  // use child processes, not worker threads! On Bun, threads are more reliable
  workerType: isBun ? "thread" : "process",
  // ensure the same flags sent to `node` for this `mocha` invocation are passed
  // along to children (only for process workers)
  forkOpts: { execArgv: process.execArgv },
  maxWorkers: workerpool.cpus - 1,
};

/**
 * Bun-native pool using fork with message passing (no workerpool).
 * Reuses workers, queues tasks, respects maxWorkers.
 * @private
 */
class BunForkPool {
  constructor(maxWorkers, onCreateWorker) {
    this.maxWorkers = maxWorkers;
    this.onCreateWorker = onCreateWorker;
    this.workers = []; // { child, busy, id }
    this.queue = []; // { id, filepath, serializedOptions, resolve, reject }
    this.taskIdCounter = 0;
    debug("BunForkPool created with maxWorkers=%d", maxWorkers);
  }

  _createWorker() {
    const { fork } = require("node:child_process");
    const extra = this.onCreateWorker
      ? this.onCreateWorker({ forkOpts: {} })
      : { forkOpts: {} };
    const env = (extra.forkOpts && extra.forkOpts.env) || {
      ...process.env,
      MOCHA_WORKER_ID: this.workers.length,
    };
    const child = fork(WORKER_BUN_PATH, [], {
      execArgv: process.execArgv,
      env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    const worker = { child, busy: false, id: this.workers.length };
    child.on("exit", (code, signal) => {
      debug("Bun worker %d exited code=%s signal=%s", worker.id, code, signal);
      const idx = this.workers.indexOf(worker);
      if (idx !== -1) this.workers.splice(idx, 1);
      // fail any pending tasks that were assigned to this worker? For now, just process queue
    });
    child.on("error", (err) => {
      debug("Bun worker error: %O", err);
    });
    this.workers.push(worker);
    return worker;
  }

  exec(method, args) {
    // method is expected to be "run"
    if (method !== "run") {
      return Promise.reject(new Error(`Unsupported method ${method} for Bun pool`));
    }
    const [filepath, serializedOptions] = args;
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: `bun-${this.taskIdCounter++}`,
        filepath,
        serializedOptions,
        resolve,
        reject,
      });
      this._processQueue();
    });
  }

  _processQueue() {
    if (this.queue.length === 0) return;
    let worker = this.workers.find((w) => !w.busy);
    if (!worker && this.workers.length < this.maxWorkers) {
      worker = this._createWorker();
    }
    if (!worker) return; // all busy and at max
    const task = this.queue.shift();
    worker.busy = true;
    const onMessage = (msg) => {
      if (!msg || msg.id !== task.id) return;
      worker.child.off("message", onMessage);
      worker.busy = false;
      if (msg.error) {
        const err = new Error(msg.error.message);
        err.stack = msg.error.stack;
        err.code = msg.error.code;
        err.name = msg.error.name;
        task.reject(err);
      } else {
        task.resolve(msg.result);
      }
      this._processQueue();
    };
    worker.child.on("message", onMessage);
    worker.child.send({
      cmd: "run",
      id: task.id,
      filepath: task.filepath,
      serializedOptions: task.serializedOptions,
    });
  }

  async terminate(force = false) {
    debug("BunForkPool terminate force=%s workers=%d", force, this.workers.length);
    const workers = [...this.workers];
    this.workers = [];
    this.queue = [];
    await Promise.all(
      workers.map((w) => {
        return new Promise((resolve) => {
          w.child.on("exit", resolve);
          if (force) {
            w.child.kill("SIGKILL");
          } else {
            try {
              w.child.send({ cmd: "exit" });
              // give it a moment to exit gracefully, then kill
              setTimeout(() => {
                try {
                  w.child.kill("SIGTERM");
                } catch {}
              }, 500).unref();
            } catch {
              w.child.kill("SIGTERM");
            }
          }
          // fallback: force kill after 2s
          setTimeout(() => {
            try {
              if (!w.child.killed) w.child.kill("SIGKILL");
            } catch {}
            resolve();
          }, 2000).unref();
        });
      }),
    );
  }

  stats() {
    return {
      totalWorkers: this.workers.length,
      busyWorkers: this.workers.filter((w) => w.busy).length,
      idleWorkers: this.workers.filter((w) => !w.busy).length,
      pendingTasks: this.queue.length,
    };
  }
}

/**
 * A wrapper around a third-party worker pool implementation.
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
    if (workerpool.cpus < 2) {
      // TODO: decide whether we should warn
      debug(
        "not enough CPU cores available to run multiple jobs; avoid --parallel on this machine",
      );
    } else if (maxWorkers >= workerpool.cpus) {
      // TODO: decide whether we should warn
      debug(
        "%d concurrent job(s) requested, but only %d core(s) available",
        maxWorkers,
        workerpool.cpus,
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
          // adds an incremental id to all workers, which can be useful to allocate resources for each process
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
    if (isBun) {
      debug("using BunForkPool");
      this._pool = new BunForkPool(maxWorkers, onCreateWorker);
    } else {
      this._pool = workerpool.pool(WORKER_PATH, this.options);
    }
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
    return this._pool.terminate(force);
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
    const result = await this._pool.exec("run", [filepath, serializedOptions]);
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
    return this._pool.stats();
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
