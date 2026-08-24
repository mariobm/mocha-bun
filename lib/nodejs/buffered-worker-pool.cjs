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
const WORKER_BUN_PATH = require.resolve("./worker-bun.cjs");
const cpus = os.cpus().length;

/**
 * A mapping of Mocha `Options` objects to serialized values.
 *
 * This is helpful because we tend to same the same options over and over
 * over IPC.
 * @type {WeakMap<MochaOptions,string>}
 */
let optionsCache = new WeakMap();

const isBun = !!process.versions.bun || typeof Bun !== "undefined";
const WORKER_POOL_DEFAULT_OPTS = {
  maxWorkers: Math.max(1, cpus - 1),
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
    this.workers = []; // { child, busy, id, currentTask }
    this.queue = []; // { id, filepath, serializedOptions, resolve, reject }
    this.taskIdCounter = 0;
    this._terminating = false;
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
    const worker = { child, busy: false, id: this.workers.length, currentTask: null };
    child.on("exit", (code, signal) => {
      debug("Bun worker %d exited code=%s signal=%s", worker.id, code, signal);
      const idx = this.workers.indexOf(worker);
      if (idx !== -1) this.workers.splice(idx, 1);
      // If worker died while running a task, reject that task so Promise.allSettled can resolve
      if (worker.currentTask) {
        const task = worker.currentTask;
        worker.currentTask = null;
        // Remove the message listener that was waiting for this task
        if (worker._onMessage) {
          try { worker.child.off("message", worker._onMessage); } catch {}
        }
        const err = new Error(
          `Worker process died (code=${code} signal=${signal}) while running ${task.filepath}`,
        );
        err.code = code;
        err.signal = signal;
        task.reject(err);
      }
      // Replace dead worker to keep pool at desired size if there are pending tasks
      if (!this._terminating && this.queue.length > 0 && this.workers.length < this.maxWorkers) {
        this._createWorker();
      }
      // Continue processing queue — dispatch as many as possible to restore throughput
      this._processQueue();
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
    // Dispatch as many tasks as possible up to maxWorkers to restore throughput after a death
    while (this.queue.length > 0) {
      let worker = this.workers.find((w) => !w.busy);
      if (!worker && this.workers.length < this.maxWorkers) {
        worker = this._createWorker();
      }
      if (!worker) return; // all busy and at max
      const task = this.queue.shift();
      worker.busy = true;
      worker.currentTask = task;
      const onMessage = (msg) => {
        if (!msg || msg.id !== task.id) return;
        worker.child.off("message", onMessage);
        worker._onMessage = null;
        worker.busy = false;
        worker.currentTask = null;
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
      worker._onMessage = onMessage;
      worker.child.on("message", onMessage);
      worker.child.send({
        cmd: "run",
        id: task.id,
        filepath: task.filepath,
        serializedOptions: task.serializedOptions,
      });
    }
  }

  async terminate(force = false) {
    debug("BunForkPool terminate force=%s workers=%d", force, this.workers.length);
    this._terminating = true;
    const workers = [...this.workers];
    this.workers = [];
    // Reject any still-queued tasks that will never run
    const queued = [...this.queue];
    this.queue = [];
    for (const t of queued) {
      t.reject(new Error(`Worker pool terminated while running ${t.filepath}`));
    }
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
    if (isBun) {
      debug("using BunForkPool");
      this._pool = new BunForkPool(maxWorkers, onCreateWorker);
    } else {
      debug("using Piscina pool");
      // Piscina is thread-based; map Mocha's maxWorkers to maxThreads
      this._pool = new Piscina({
        filename: WORKER_PATH,
        maxThreads: maxWorkers,
        minThreads: 0,
        idleTimeout: 5000,
        execArgv: process.execArgv,
        // Pass execArgv and other options; MOCHA_WORKER_ID handled via threadId in worker
      });
      // Patch piscina to have workerpool-like stats/terminate for BufferedWorkerPool compatibility
      // Piscina uses .threads (Worker[]), .queueSize, .completed etc.
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
    if (isBun) {
      return this._pool.terminate(force);
    }
    // Piscina: destroy vs close
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
    let result;
    if (isBun) {
      result = await this._pool.exec("run", [filepath, serializedOptions]);
    } else {
      // Piscina: worker exports `run` (or default) that takes {filepath, serializedOptions}
      result = await this._pool.run({ filepath, serializedOptions });
    }
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
    if (isBun) {
      return this._pool.stats();
    }
    // Piscina stats mapping to workerpool-like shape
    const totalWorkers = this._pool.threads.length;
    const pendingTasks = this._pool.queueSize;
    // Piscina doesn't expose busy/idle directly; estimate via utilization
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
