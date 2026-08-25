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
  pool: isBun ? "process" : "thread", // explicit process|thread option
  maxTasksPerWorker: 0, // 0 = unlimited, else recycle after N tasks
  maxRSSBytes: 0, // 0 = disabled, else recycle if RSS exceeds
};

const WorkerState = {
  STARTING: "starting",
  IDLE: "idle",
  BUSY: "busy",
  STOPPING: "stopping",
};

/**
 * Hardened process pool for Bun (fork) with explicit state machine,
 * ready gating, single permanent handler, monotonic IDs, and graceful shutdown.
 * @private
 */
class BunForkPool {
  constructor(maxWorkers, opts = {}) {
    this.maxWorkers = maxWorkers;
    this.maxTasksPerWorker = opts.maxTasksPerWorker ?? WORKER_POOL_DEFAULT_OPTS.maxTasksPerWorker;
    this.maxRSSBytes = opts.maxRSSBytes ?? WORKER_POOL_DEFAULT_OPTS.maxRSSBytes;
    this.workers = []; // { child, id, state, currentTask, ready, tasksRun, rss }
    this.queue = []; // { id, filepath, serializedOptions, resolve, reject }
    this.nextWorkerId = 0;
    this.nextTaskId = 0;
    this._terminating = false;
    this._timers = new Set();
    debug("BunForkPool created maxWorkers=%d maxTasksPerWorker=%s maxRSS=%s", maxWorkers, this.maxTasksPerWorker, this.maxRSSBytes);
  }

  _createWorker() {
    const { fork } = require("node:child_process");
    const id = this.nextWorkerId++;
    const env = { ...process.env, MOCHA_WORKER_ID: String(id) };
    const child = fork(WORKER_BUN_PATH, [], {
      execArgv: process.execArgv,
      env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    const worker = {
      child,
      id,
      state: WorkerState.STARTING,
      currentTask: null,
      ready: false,
      tasksRun: 0,
      _onMessage: null,
    };
    // Single permanent handler per child
    const onMessage = (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.ready) {
        worker.ready = true;
        worker.state = WorkerState.IDLE;
        debug("Bun worker %d ready", id);
        this._processQueue();
        return;
      }
      if (!worker.currentTask) return;
      const task = worker.currentTask;
      if (!msg.id || msg.id !== task.id) return;
      worker.currentTask = null;
      worker.tasksRun++;
      // Check recycling via maxTasksPerWorker or RSS
      const shouldRecycle =
        (this.maxTasksPerWorker > 0 && worker.tasksRun >= this.maxTasksPerWorker) ||
        (this.maxRSSBytes > 0 && this._getWorkerRSS(worker) > this.maxRSSBytes);
      if (shouldRecycle) {
        debug("Bun worker %d recycling after %d tasks", id, worker.tasksRun);
        this._stopWorker(worker, false);
      } else {
        worker.state = WorkerState.IDLE;
      }
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
    child.on("message", onMessage);
    child.on("error", (err) => {
      debug("Bun worker %d error: %O", id, err);
      if (worker.currentTask) {
        const task = worker.currentTask;
        worker.currentTask = null;
        task.reject(err);
      }
    });
    child.on("disconnect", () => {
      debug("Bun worker %d disconnect", id);
      // Don't reject here — wait for exit to get code/signal for a better error message
      if (worker.state !== WorkerState.STOPPING) {
        worker.state = WorkerState.STOPPING;
      }
    });
    child.on("exit", (code, signal) => {
      debug("Bun worker %d exit code=%s signal=%s state=%s", id, code, signal, worker.state);
      const idx = this.workers.indexOf(worker);
      if (idx !== -1) this.workers.splice(idx, 1);
      child.off("message", onMessage);
      if (worker.currentTask) {
        const task = worker.currentTask;
        worker.currentTask = null;
        const err = new Error(`Worker process died (code=${code} signal=${signal}) while running ${task.filepath}`);
        err.code = code;
        err.signal = signal;
        task.reject(err);
      }
      if (!this._terminating && this.queue.length > 0 && this.workers.length < this.maxWorkers) {
        this._createWorker();
      }
      this._processQueue();
    });
    // Handle spawn failure (e.g., bad execArgv)
    child.on("spawn", () => debug("Bun worker %d spawn ok", id));
    child.on("error", (err) => {
      // Spawn error: reject any queued tasks that would have gone to this worker
      debug("Bun worker %d spawn error %O", id, err);
      if (worker.currentTask) {
        worker.currentTask.reject(err);
        worker.currentTask = null;
      }
    });
    this.workers.push(worker);
    return worker;
  }

  _getWorkerRSS(worker) {
    try {
      // Approximate via process.memoryUsage in worker would need IPC; for now use 0
      return 0;
    } catch { return 0; }
  }

  _stopWorker(worker, force = false) {
    if (worker.state === WorkerState.STOPPING) return;
    worker.state = WorkerState.STOPPING;
    worker.busy = false;
    const child = worker.child;
    if (force) {
      try { child.kill("SIGKILL"); } catch {}
      return;
    }
    try { child.send({ cmd: "exit" }); } catch {}
    const t1 = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 1000);
    t1.unref();
    this._timers.add(t1);
    const t2 = setTimeout(() => { try { if (!child.killed) child.kill("SIGKILL"); } catch {} }, 3000);
    t2.unref();
    this._timers.add(t2);
    child.on("exit", () => { clearTimeout(t1); clearTimeout(t2); this._timers.delete(t1); this._timers.delete(t2); });
  }

  exec(method, args) {
    if (method !== "run") return Promise.reject(new Error(`Unsupported method ${method}`));
    const [filepath, serializedOptions] = args;
    return new Promise((resolve, reject) => {
      this.queue.push({ id: `bun-${this.nextTaskId++}`, filepath, serializedOptions, resolve, reject });
      this._processQueue();
    });
  }

  _processQueue() {
    while (this.queue.length > 0) {
      // Prefer idle ready workers, else starting workers are not yet dispatchable
      let worker = this.workers.find((w) => w.state === WorkerState.IDLE && w.ready);
      if (!worker && this.workers.length < this.maxWorkers) {
        const w = this._createWorker();
        // New worker is STARTING, not yet ready — wait for ready message before dispatch
        // So we don't dispatch to it this iteration; next _processQueue after ready will
        if (w.state === WorkerState.STARTING) return;
        worker = w;
      }
      if (!worker) return;
      const task = this.queue.shift();
      worker.state = WorkerState.BUSY;
      worker.currentTask = task;
      // Use the permanent handler already attached; just send
      try {
        worker.child.send({ cmd: "run", id: task.id, filepath: task.filepath, serializedOptions: task.serializedOptions });
      } catch (err) {
        worker.state = WorkerState.IDLE;
        worker.currentTask = null;
        task.reject(err);
        this._processQueue();
      }
    }
  }

  async terminate(force = false) {
    debug("BunForkPool terminate force=%s workers=%d queued=%d", force, this.workers.length, this.queue.length);
    this._terminating = true;
    // Reject queued tasks
    const queued = [...this.queue]; this.queue = [];
    for (const t of queued) t.reject(new Error(`Worker pool terminated while running ${t.filepath}`));
    const workers = [...this.workers]; this.workers = [];
    // Clear any pending timers
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    await Promise.all(workers.map((w) => new Promise((resolve) => {
      const child = w.child;
      let done = false;
      const onExit = () => { if (!done) { done = true; resolve(); } };
      child.on("exit", onExit);
      child.on("disconnect", onExit);
      let t1, t2;
      if (force) {
        try { child.kill("SIGKILL"); } catch {}
      } else {
        try { child.send({ cmd: "exit" }); } catch {}
        t1 = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 1000);
        t1.unref(); this._timers.add(t1);
        t2 = setTimeout(() => { try { if (!child.killed) child.kill("SIGKILL"); } catch {} if (!done) resolve(); }, 3000);
        t2.unref(); this._timers.add(t2);
      }
      // Force kill fallback
      const tf = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} if (!done) resolve(); }, force ? 1000 : 4000);
      tf.unref(); this._timers.add(tf);
      child.on("exit", () => {
        if (t1) clearTimeout(t1);
        if (t2) clearTimeout(t2);
        clearTimeout(tf);
        this._timers.delete(t1);
        this._timers.delete(t2);
        this._timers.delete(tf);
      });
    })));
    // Ensure no orphans: clear all timers
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this._terminating = false;
  }

  stats() {
    return {
      totalWorkers: this.workers.length,
      busyWorkers: this.workers.filter((w) => w.state === WorkerState.BUSY).length,
      idleWorkers: this.workers.filter((w) => w.state === WorkerState.IDLE).length,
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

    // Explicit pool option: 'process' (fork) or 'thread' (Piscina). Default: Bun -> process, Node -> thread
    const poolType = opts.pool || opts.workerType || WORKER_POOL_DEFAULT_OPTS.pool;
    const maxTasksPerWorker = opts.maxTasksPerWorker ?? WORKER_POOL_DEFAULT_OPTS.maxTasksPerWorker;
    const maxRSSBytes = opts.maxRSSBytes ?? WORKER_POOL_DEFAULT_OPTS.maxRSSBytes;

    this.options = {
      ...WORKER_POOL_DEFAULT_OPTS,
      ...opts,
      maxWorkers,
      pool: poolType,
      maxTasksPerWorker,
      maxRSSBytes,
    };
    // For process pools we still need onCreateWorker for MOCHA_WORKER_ID via env (BunForkPool uses monotonic counter)
    // For thread pools, MOCHA_WORKER_ID is set via threadId in worker.cjs
    if (poolType === "process") {
      debug("using BunForkPool (process) isBun=%s maxTasksPerWorker=%s", isBun, maxTasksPerWorker);
      this._pool = new BunForkPool(maxWorkers, { maxTasksPerWorker, maxRSSBytes });
    } else {
      debug("using Piscina pool (thread) isBun=%s", isBun);
      this._pool = new Piscina({
        filename: WORKER_PATH,
        maxThreads: maxWorkers,
        minThreads: 0,
        idleTimeout: 5000,
        execArgv: process.execArgv,
      });
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
    debug("terminate(): terminating with force = %s pool=%s", force, this.options.pool);
    if (this.options.pool === "process") {
      return this._pool.terminate(force);
    }
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
    if (this.options.pool === "process") {
      result = await this._pool.exec("run", [filepath, serializedOptions]);
    } else {
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
    if (this.options.pool === "process") {
      return this._pool.stats();
    }
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
