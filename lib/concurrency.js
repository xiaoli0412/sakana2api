// High-Performance Concurrency Limiter & Async Request Queue
// Protects upstream sessions under 100+ burst concurrent requests by
// queuing and smoothly dispatching across the account pool.

const envInt = (name, fallback, min = 0) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

const DEFAULT_MAX_CONCURRENT = envInt('MAX_CONCURRENT_PER_ACCOUNT', 6, 1);
const DEFAULT_QUEUE_TIMEOUT = envInt('QUEUE_TIMEOUT_MS', 60000, 0);
const DEFAULT_MAX_QUEUE = envInt('QUEUE_MAX_SIZE', envInt('MAX_QUEUE_LENGTH', 1000, 0), 0);
const { abortError } = require('./abort');


function queueFullError(limit) {
  const error = new Error(`request queue full (max ${limit})`);
  error.code = 'QUEUE_FULL';
  return error;
}

class ConcurrencyManager {
  constructor(options = {}) {
    const numberOption = (names, fallback, min = 0) => {
      for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(options, name) && Number.isFinite(Number(options[name]))) {
          return Math.max(min, Number(options[name]));
        }
      }
      return fallback;
    };
    this.maxConcurrentPerAccount = numberOption(['maxConcurrentPerAccount'], DEFAULT_MAX_CONCURRENT, 1);
    this.queueTimeoutMs = numberOption(['queueTimeoutMs'], DEFAULT_QUEUE_TIMEOUT, 0);
    this.maxQueue = numberOption(['maxQueue', 'maxQueueSize', 'queueMax', 'maxQueueLength'], DEFAULT_MAX_QUEUE, 0);
    this.queue = [];
    this.inFlight = 0;
    this.peakInFlight = 0;
    this.totalHandled = 0;
    this.totalQueued = 0;
    this.totalTimeout = 0;
    this.totalAborted = 0;
    this.totalRejected = 0;
    this.closed = false;
  }

  get stats() {
    return {
      inFlight: this.inFlight,
      peakInFlight: this.peakInFlight,
      queueLength: this.queue.length,
      maxQueue: this.maxQueue,
      totalHandled: this.totalHandled,
      totalQueued: this.totalQueued,
      totalTimeout: this.totalTimeout,
      totalAborted: this.totalAborted,
      totalRejected: this.totalRejected,
    };
  }

  _capacity(accountPool) {
    const activeCount = accountPool
      ? (typeof accountPool.activeCount === 'function'
        ? accountPool.activeCount()
        : (accountPool.accounts || []).filter(a => a.state === 'active').length)
      : 0;
    return Math.max(1, (activeCount || 1) * this.maxConcurrentPerAccount);
  }

  _settleQueued(item, action, error = null) {
    if (!item || item.settled) return false;
    item.settled = true;
    clearTimeout(item.timer);
    item.signal?.removeEventListener?.('abort', item.onAbort);
    const index = this.queue.indexOf(item);
    if (index !== -1) this.queue.splice(index, 1);
    if (action === 'resolve') {
      this.inFlight++;
      if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
      item.resolve();
    } else {
      item.reject(error);
    }
    return true;
  }

  _drainOne() {
    while (this.queue.length) {
      const item = this.queue.shift();
      if (!item || item.settled) continue;
      item.settled = true;
      clearTimeout(item.timer);
      item.signal?.removeEventListener?.('abort', item.onAbort);
      this.inFlight++;
      if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
      item.resolve();
      return true;
    }
    return false;
  }

  /**
   * Acquire an execution slot with timeout and cancellation protection.
   * `options.signal` may be an AbortSignal; the legacy one-argument form is
   * unchanged.
   */
  async acquire(accountPool, options = {}) {
    if (this.closed) throw Object.assign(new Error('server is shutting down'), { code: 'SERVER-SHUTDOWN' });
    this.totalHandled++;
    const signal = options?.signal || options?.abortSignal || (typeof options?.aborted === 'boolean' ? options : null);
    if (signal?.aborted) {
      this.totalAborted++;
      throw abortError(signal.reason);
    }

    const maxCapacity = this._capacity(accountPool);
    if (this.inFlight < maxCapacity) {
      this.inFlight++;
      if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
      return;
    }

    if (this.queue.length >= this.maxQueue) {
      this.totalRejected++;
      throw queueFullError(this.maxQueue);
    }

    this.totalQueued++;
    return new Promise((resolve, reject) => {
      const item = {
        resolve,
        reject,
        signal,
        settled: false,
        enqueuedAt: Date.now(),
        timer: null,
        onAbort: null,
      };
      item.onAbort = () => {
        if (!this._settleQueued(item, 'reject', abortError(signal.reason))) return;
        this.totalAborted++;
      };
      item.timer = setTimeout(() => {
        const timeoutError = abortError({ code: 'REQUEST-TIMEOUT' });
        timeoutError.message = `request queue timeout (${this.queueTimeoutMs}ms, queue length: ${this.queue.length})`;
        if (!this._settleQueued(item, 'reject', timeoutError)) return;
        this.totalTimeout++;
      }, this.queueTimeoutMs);
      this.queue.push(item);
      if (signal?.addEventListener) signal.addEventListener('abort', item.onAbort, { once: true });
      if (signal?.aborted) item.onAbort();
    });
  }

  close(error = Object.assign(new Error('server is shutting down'), { code: 'SERVER-SHUTDOWN' })) {
    if (this.closed) return;
    this.closed = true;
    for (const item of [...this.queue]) this._settleQueued(item, 'reject', error);
    this.queue.length = 0;
  }

  stop(error) { this.close(error); }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this._drainOne();
  }
}

const concurrencyManager = new ConcurrencyManager();

module.exports = { ConcurrencyManager, concurrencyManager };
