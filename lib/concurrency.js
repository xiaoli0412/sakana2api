// High-Performance Concurrency Limiter & Async Request Queue
// Protects upstream sessions under 100+ burst concurrent requests by
// queuing and smoothly dispatching across the account pool.

class ConcurrencyManager {
  constructor(options = {}) {
    this.maxConcurrentPerAccount = options.maxConcurrentPerAccount || parseInt(process.env.MAX_CONCURRENT_PER_ACCOUNT || '6', 10);
    this.queueTimeoutMs = options.queueTimeoutMs || parseInt(process.env.QUEUE_TIMEOUT_MS || '60000', 10);
    this.queue = [];
    this.inFlight = 0;
    this.peakInFlight = 0;
    this.totalHandled = 0;
    this.totalQueued = 0;
    this.totalTimeout = 0;
  }

  get stats() {
    return {
      inFlight: this.inFlight,
      peakInFlight: this.peakInFlight,
      queueLength: this.queue.length,
      totalHandled: this.totalHandled,
      totalQueued: this.totalQueued,
      totalTimeout: this.totalTimeout,
    };
  }

  /**
   * Acquire an execution slot with timeout protection.
   * If pool has capacity, resolves immediately.
   * Otherwise queues the request until a slot frees up.
   */
  async acquire(accountPool) {
    this.totalHandled++;
    const activeAccounts = accountPool ? accountPool.accounts.filter(a => a.state === 'active') : [];
    const maxCapacity = Math.max(1, (activeAccounts.length || 1) * this.maxConcurrentPerAccount);

    // If current in-flight is below total pool capacity, grant immediately
    if (this.inFlight < maxCapacity) {
      this.inFlight++;
      if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
      return;
    }

    // Otherwise enqueue
    this.totalQueued++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex(item => item.resolve === resolve);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          this.totalTimeout++;
          reject(new Error(`request queue timeout (${this.queueTimeoutMs}ms, queue length: ${this.queue.length})`));
        }
      }, this.queueTimeoutMs);

      this.queue.push({
        resolve: () => {
          clearTimeout(timer);
          this.inFlight++;
          if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        enqueuedAt: Date.now(),
      });
    });
  }

  /**
   * Release execution slot and wake up next waiting request.
   */
  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next && next.resolve) {
        next.resolve();
      }
    }
  }
}

const concurrencyManager = new ConcurrencyManager();

module.exports = { ConcurrencyManager, concurrencyManager };
