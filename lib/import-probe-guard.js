'use strict';
// Bounded liveness-probe policy for the admin account-import path.
//
// 2026-10 upstream sits behind a Turnstile session gate; hammering the
// settings endpoint with candidate cookies is exactly the traffic shape that
// gets an egress IP challenged harder. This guard caps how many probes can run
// in a window and backs off exponentially after repeated *systemic* failures
// (challenge, rate limit, upstream 5xx, network). A definite 401 is an answer,
// not an outage: it resets the streak so one stale paste does not throttle the
// next valid import.
//
// All knobs are env-overridable, matching the hot-fix pattern used elsewhere
// for upstream-facing logic.

const envInt = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

const SYSTEMIC_REASONS = new Set([
  'turnstile_challenge',
  'rate_limited',
  'upstream_error',
  'network_error',
  'timeout',
]);

class ImportProbeGuard {
  constructor(opts = {}) {
    this.failureThreshold = envInt('SAKANA_IMPORT_PROBE_FAIL_THRESHOLD', 3, { min: 1, max: 100 });
    this.baseBackoffMs = envInt('SAKANA_IMPORT_PROBE_BACKOFF_MS', 2000, { min: 0, max: 60 * 60 * 1000 });
    this.maxBackoffMs = envInt('SAKANA_IMPORT_PROBE_BACKOFF_MAX_MS', 60000, { min: 0, max: 60 * 60 * 1000 });
    this.windowMs = envInt('SAKANA_IMPORT_PROBE_WINDOW_MS', 60000, { min: 1000, max: 60 * 60 * 1000 });
    this.maxPerWindow = envInt('SAKANA_IMPORT_PROBE_MAX_PER_WINDOW', 20, { min: 1, max: 1000 });
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.failures = 0;
    this.blockedUntil = 0;
    this.window = [];
    this.lastReason = '';
  }

  _prune(now) {
    const cutoff = now - this.windowMs;
    if (this.window.length && this.window[0] <= cutoff) {
      this.window = this.window.filter(at => at > cutoff);
    }
  }

  /**
   * Ask permission to probe. Returns {allowed:true, windowRemaining} or
   * {allowed:false, reason:'backoff'|'throttled', retryAfterMs}.
   * A permitted probe is counted in the window immediately.
   */
  begin() {
    const now = this.now();
    this._prune(now);
    if (now < this.blockedUntil) {
      return { allowed: false, reason: 'backoff', retryAfterMs: Math.max(1, this.blockedUntil - now) };
    }
    if (this.window.length >= this.maxPerWindow) {
      const oldest = this.window[0];
      return { allowed: false, reason: 'throttled', retryAfterMs: Math.max(1, oldest + this.windowMs - now) };
    }
    this.window.push(now);
    return { allowed: true };
  }

  /** Record one probe outcome. `reason` is the probe's classification. */
  record({ ok = false, reason = 'network_error' } = {}) {
    const now = this.now();
    if (ok || reason === 'invalid_session' || reason === 'ok') {
      this.failures = 0;
      this.blockedUntil = 0;
      this.lastReason = ok ? '' : reason;
      return this.snapshot();
    }
    if (!SYSTEMIC_REASONS.has(reason)) {
      this.lastReason = reason;
      return this.snapshot();
    }
    this.failures += 1;
    this.lastReason = reason;
    if (this.failures >= this.failureThreshold) {
      const exponent = Math.min(30, this.failures - this.failureThreshold);
      const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** exponent));
      this.blockedUntil = Math.max(this.blockedUntil, now + delay);
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      failures: this.failures,
      blockedForMs: Math.max(0, this.blockedUntil - this.now()),
      windowRemaining: Math.max(0, this.maxPerWindow - this.window.length),
      lastReason: this.lastReason,
    };
  }
}

module.exports = { ImportProbeGuard };