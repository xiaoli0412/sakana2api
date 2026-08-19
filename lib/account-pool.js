// Multi-account pool: manages N distinct Sakana accounts, round-robins
// requests with least-in-flight load balancing, auto-harvests new sessions via auto-session,
// detects rate-limits with automatic cooldown recovery, and replenishes/refreshes the pool in the background.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POOL_FILE = path.join(__dirname, '..', 'account_pool.json');
const SESSION_FILE = path.join(__dirname, '..', 'session.json');
const MIN_POOL = parseInt(process.env.ACCOUNT_POOL_MIN || '50', 10);
const MAX_POOL = parseInt(process.env.ACCOUNT_POOL_MAX || '50', 10);
const REFRESH_INTERVAL = parseInt(process.env.ACCOUNT_REFRESH_MS || String(20 * 60 * 1000), 10);
const REPLENISH_INTERVAL = parseInt(process.env.ACCOUNT_REPLENISH_MS || '90000', 10);
// cf_clearance lives ~30min. Refresh accounts BEFORE the cookie dies (20min
// cycle renders 30min-stale accounts refreshable only every other cycle,
// leaving a window where requests intermittently 403 — the classic flaky
// upload symptom). 15min staleness keeps headroom for slow cycles.
const STALE_MS = parseInt(process.env.ACCOUNT_STALE_MS || String(15 * 60 * 1000), 10);
const COOLDOWN_MS = parseInt(process.env.RATE_LIMIT_COOLDOWN_MS || String(10 * 60 * 1000), 10); // 10m auto cooldown
const HARVEST_RETRIES = parseInt(process.env.HARVEST_RETRIES || '3', 10);

/**
 * Stable identity key for a session: uid + email + sakana-chat session cookie.
 * Two entries are the same account only when ALL THREE agree. This protects
 * the pool against identity pollution (a shared browser profile's IndexedDB
 * identity being stamped onto every refreshed account) which previously
 * collapsed distinct live sessions into one entry.
 */
function sessionKey(sess) {
  if (!sess || typeof sess !== 'object') return '';
  const uid = ((sess.uid || '') + '').trim();
  const email = ((sess.email || '') + '').trim();
  const ses = ((sess.cookieHeader || '').match(/sakana-chat=([^;]+)/) || [])[1] || '';
  return `${uid}#${email}#${ses}`;
}

class AccountPool {
  constructor(file = POOL_FILE, sessionFile = SESSION_FILE, opts = {}) {
    this.file = file;
    this.sessionFile = sessionFile;
    this.minPool = opts.minPool || MIN_POOL;
    this.maxPool = opts.maxPool || MAX_POOL;
    this.accounts = []; // { id, email, uid, cookieHeader, cookies, savedAt, state, refreshes, inFlight, successCount, errorCount }
    this.nextIdx = 0;
    this.load();
    this.backgroundTimer = null;
    this.replenishTimer = null;
    this.replenishing = false;
    this.lastHarvestAt = 0;
    this.lastHarvestError = '';
  }

  load() {
    try { this.accounts = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { this.accounts = []; }

    // Sync session.json if it exists and has valid cookies
    try {
      if (fs.existsSync(this.sessionFile)) {
        const sess = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        if (sess && sess.cookieHeader) {
          const key = sessionKey(sess);
          const existing = this.accounts.find(a => sessionKey(a) === key);
          if (existing) {
            if ((sess.savedAt || 0) > (existing.savedAt || 0)) {
              existing.cookieHeader = sess.cookieHeader;
              existing.cookies = sess.cookies || existing.cookies;
              existing.savedAt = sess.savedAt;
              existing.state = 'active';
            }
          } else {
            this.accounts.unshift({
              id: crypto.randomUUID(),
              email: sess.email || '',
              uid: sess.uid || '',
              cookieHeader: sess.cookieHeader || '',
              cookies: sess.cookies || [],
              savedAt: sess.savedAt || Date.now(),
              state: 'active',
              refreshes: 0,
              inFlight: 0,
            });
          }
        }
      }
    } catch {}

    // Dedupe by SESSION identity (uid + email + sakana-chat session cookie),
    // never by uid alone: a buggy refresh cycle once stamped one account's
    // identity onto every entry; uid-only dedupe then collapsed 10 distinct
    // live sessions into 1.
    const seen = new Set();
    const out = [];
    for (const a of this.accounts) {
      if (!a || typeof a !== 'object' || !a.cookieHeader) continue;
      const key = sessionKey(a);
      if (seen.has(key)) continue;
      seen.add(key);
      a.inFlight = 0;
      a.successCount = a.successCount || 0;
      a.errorCount = a.errorCount || 0;
      out.push(a);
    }
    this.accounts = out;
    this.save();
  }

  save() {
    try {
      const clean = this.accounts.map(({ inFlight, ...rest }) => rest);
      fs.writeFileSync(this.file, JSON.stringify(clean, null, 2));
    } catch {}
  }

  count() { return this.accounts.length; }

  _checkCooldowns() {
    const now = Date.now();
    let updated = false;
    for (const a of this.accounts) {
      if (a.state === 'rate_limited' && a.rateLimitedAt && (now - a.rateLimitedAt > COOLDOWN_MS)) {
        a.state = 'active';
        delete a.rateLimitedAt;
        updated = true;
        console.log('[account-pool] account cooldown recovered to active:', (a.email || a.id).slice(0, 32));
      }
    }
    if (updated) this.save();
  }

  /** Get account by id (for conversation-continuity pinning). */
  get(id) {
    this._checkCooldowns();
    const a = this.accounts.find(a => a.id === id && a.state === 'active');
    return a ? { ...a } : null;
  }

  activeCount() {
    this._checkCooldowns();
    return this.accounts.filter(a => a.state === 'active').length;
  }

  /**
   * Acquire connection slot on account. Records per-model usage timestamps
   * so next(model) can rotate accounts across model quota windows.
   */
  acquire(id, model = '') {
    const a = this.accounts.find(a => a.id === id);
    if (a) {
      a.inFlight = (a.inFlight || 0) + 1;
      if (model) {
        a.modelUse = a.modelUse || {};
        a.modelUse[model] = Date.now();
        a.modelCount = a.modelCount || {};
        a.modelCount[model] = (a.modelCount[model] || 0) + 1;
      }
    }
  }

  /**
   * Release connection slot on account.
   */
  release(id, isSuccess = true) {
    const a = this.accounts.find(a => a.id === id);
    if (a) {
      a.inFlight = Math.max(0, (a.inFlight || 1) - 1);
      if (isSuccess) a.successCount = (a.successCount || 0) + 1;
      else a.errorCount = (a.errorCount || 0) + 1;
    }
  }

  /**
   * Get next active account using Least-InFlight load balancing.
   * Prefers accounts with 0 active in-flight streams, then lowest inFlight.
   * When a model id is given, rotates by model quota: accounts that never
   * used this model are preferred, then the ones with the oldest usage — so
   * the upstream per-model rate window (RATE-MODEL-*) is spread across the
   * whole pool instead of hammering one account per model.
   */
  next(model = '') {
    this._checkCooldowns();
    const active = this.accounts.filter(a => a.state === 'active');
    if (!active.length) return null;

    // Find account with minimum inFlight
    let minInFlight = Infinity;
    for (const a of active) {
      const inf = a.inFlight || 0;
      if (inf < minInFlight) minInFlight = inf;
    }

    const candidates = active.filter(a => (a.inFlight || 0) === minInFlight);
    if (model) {
      const neverUsed = candidates.filter(a => !((a.modelUse || {})[model]));
      if (neverUsed.length > 0) {
        const idx = this.nextIdx % neverUsed.length;
        this.nextIdx = (this.nextIdx + 1) % active.length;
        return { ...neverUsed[idx] };
      }
      const used = [...candidates].sort((a, b) => ((a.modelUse || {})[model] || 0) - ((b.modelUse || {})[model] || 0));
      this.nextIdx = (this.nextIdx + 1) % active.length;
      return { ...used[0] };
    }
    const idx = this.nextIdx % candidates.length;
    this.nextIdx = (this.nextIdx + 1) % active.length;
    return { ...candidates[idx] };
  }

  /** Mark an account as rate-limited (auto cools down after COOLDOWN_MS). */
  markRateLimited(id) {
    const acct = this.accounts.find(a => a.id === id);
    if (acct && acct.state === 'active') {
      acct.state = 'rate_limited';
      acct.rateLimitedAt = Date.now();
      console.log('[account-pool] rate-limited:', (acct.email || acct.id).slice(0, 32));
      this.save();
    }
  }

  /** Mark an account as expired (session dead). */
  markExpired(id) {
    const acct = this.accounts.find(a => a.id === id);
    if (acct) {
      acct.state = 'expired';
      acct.expiredAt = Date.now();
      this.save();
    }
  }

  /** Add a harvested session to the pool. Dedupes by session identity. */
  add(session) {
    const key = sessionKey(session);
    if (this.accounts.some(a => sessionKey(a) === key)) {
      console.log('[account-pool] duplicate session ignored');
      return null;
    }
    const id = crypto.randomUUID();
    this.accounts.push({
      id, email: session.email || '', uid: session.uid || '',
      cookieHeader: session.cookieHeader || '',
      cookies: session.cookies || [],
      savedAt: Date.now(),
      state: 'active',
      refreshes: 0,
      inFlight: 0,
      successCount: 0,
      errorCount: 0,
    });
    // Also keep session.json in sync so the legacy fallback path stays valid.
    try {
      fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    } catch {}
    this.save();
    this.trim();
    return id;
  }

  remove(id) {
    const i = this.accounts.findIndex(a => a.id === id);
    if (i === -1) return false;
    this.accounts.splice(i, 1);
    this.save();
    return true;
  }

  /** Drop duplicates and keep pool within maxPool (newest first). */
  trim() {
    const active = this.accounts.filter(a => a.state === 'active');
    const others = this.accounts.filter(a => a.state !== 'active');
    if (active.length > this.maxPool) {
      active.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      this.accounts = active.slice(0, this.maxPool).concat(others);
      console.log('[account-pool] trimmed to', this.maxPool);
    }
    this.save();
  }

  /**
   * Ensure at least `target` distinct active accounts, harvesting fresh
   * sessions via harvestFn() (which MUST create a brand-new account).
   * Each slot retries failed harvests up to HARVEST_RETRIES times.
   */
  async ensureMinPool(harvestFn, target = this.minPool) {
    const targetN = Math.min(target, this.maxPool);
    let active = this.accounts.filter(a => a.state === 'active').length;
    let needed = Math.max(0, targetN - active);
    if (needed <= 0) return 0;
    // Harvest backoff: temp-mail / registration APIs rate-limit hard (429).
    // After a failed harvest, pause for HARVEST_BACKOFF_MS (default 5min) so
    // the mail service recovers — unless the pool is critically low
    // (< ACCOUNT_POOL_CRITICAL, default 10 active accounts).
    const backoffMs = parseInt(process.env.HARVEST_BACKOFF_MS || String(5 * 60 * 1000), 10);
    const sinceFail = Date.now() - (this.lastHarvestErrorAt || 0);
    if (this.lastHarvestErrorAt && sinceFail < backoffMs && active >= (parseInt(process.env.ACCOUNT_POOL_CRITICAL || '10', 10))) {
      console.log(`[account-pool] harvest backoff +${Math.round((backoffMs - sinceFail) / 1000)}s (pool ${active}, last: ${this.lastHarvestError.slice(0, 60)})`);
      return 0;
    }
    console.log(`[account-pool] need ${needed} more fresh accounts, harvesting (each ~60-90s, serialized)...`);
    let ok = 0;
    for (let i = 0; i < needed; i++) {
      let slotDone = false;
      for (let attempt = 1; attempt <= HARVEST_RETRIES && !slotDone; attempt++) {
        try {
          const session = await harvestFn();
          if (session) {
            const id = this.add(session);
            if (id) { ok++; slotDone = true; this.lastHarvestAt = Date.now(); this.lastHarvestError = ''; this.lastHarvestErrorAt = 0; }
            else {
              // duplicate session — the harvest produced an account that already
              // exists. Count as progress only if active count grew; otherwise retry.
              active = this.accounts.filter(a => a.state === 'active').length;
              if (active >= targetN) slotDone = true;
              else throw new Error('harvest returned duplicate session');
            }
          } else {
            throw new Error('harvest returned empty session');
          }
        } catch (e) {
          this.lastHarvestError = String(e.message || e).slice(0, 200);
          this.lastHarvestErrorAt = Date.now();
          console.log(`[account-pool] harvest failed (attempt ${attempt}/${HARVEST_RETRIES}):`, this.lastHarvestError);
          if (attempt < HARVEST_RETRIES) await new Promise((r) => setTimeout(r, 5000));
        }
      }
      if (!slotDone) console.log('[account-pool] giving up on this slot — will retry on next replenish tick');
    }
    console.log(`[account-pool] pool now: ${this.count()} accounts (${this.activeCount()} active)`);
    if (ok < needed) console.log(`[account-pool] got ${ok}/${needed}`);
    return ok;
  }

  /**
   * Event-driven replenish: after a failure/limit/expiry event, top the pool
   * back up to minPool shortly. Serialized: never runs two harvests at once.
   */
  scheduleReplenish(harvestFn, delayMs = 10000) {
    if (!harvestFn || this._replenishScheduled) return;
    this._replenishScheduled = true;
    setTimeout(async () => {
      this._replenishScheduled = false;
      if (this.replenishing) return;
      this.replenishing = true;
      try { await this.ensureMinPool(harvestFn); }
      catch (e) { console.log('[account-pool] replenish error:', String(e.message || e).slice(0, 150)); }
      finally { this.replenishing = false; }
    }, delayMs).unref?.();
  }

  /**
   * Apply a refresh result to an account. Updates ONLY the live connection
   * bits (cookies). The identity (uid/email) must never be overwritten from
   * `fresh`: a shared browser profile reports ITS OWN IndexedDB identity for
   * every account, which previously stamped one account's identity onto the
   * whole pool.
   */
  applyRefresh(acct, fresh) {
    acct.cookieHeader = fresh.cookieHeader || acct.cookieHeader;
    acct.cookies = fresh.cookies || acct.cookies;
    acct.savedAt = fresh.savedAt || Date.now();
    acct.state = 'active';
    acct.refreshes = (acct.refreshes || 0) + 1;
    this.save();
    return true;
  }

  /**
   * Background keeper. Two timers:
   *  - REFRESH_INTERVAL (20min): refresh each account's cookies in-place
   *    (refreshFn), replacing dead ones
   *  - REPLENISH_INTERVAL (default 90s): real-time top-up to minPool via
   *    harvestFn whenever the active count drops (rate-limits, expiries)
   */
  startBackground({ harvestFn, refreshFn, replenishMs = REPLENISH_INTERVAL } = {}) {
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    if (this.replenishTimer) clearInterval(this.replenishTimer);
    if (!harvestFn || !refreshFn) return;
    this._harvestFn = harvestFn;
    this.backgroundTimer = setInterval(async () => {
      try {
        console.log('[account-pool] background cycle start');
        // 1) refresh cookies of existing accounts
        for (const acct of this.accounts) {
          const hue = Date.now() - (acct.savedAt || 0);
          if (acct.state === 'active' && hue < STALE_MS) continue;
          try {
            const fresh = await refreshFn(acct);
            if (fresh) {
              this.applyRefresh(acct, fresh);
            } else {
              // Login lost — replace this account with a fresh one. Skip the
              // immediate replacement while harvest backoff is active: the
              // expired slot is repopulated by the next replenish tick.
              this.markExpired(acct.id);
              const backoffMs = parseInt(process.env.HARVEST_BACKOFF_MS || String(5 * 60 * 1000), 10);
              const sinceFail = Date.now() - (this.lastHarvestErrorAt || 0);
              if (this.lastHarvestErrorAt && sinceFail < backoffMs) {
                console.log('[account-pool] refresh replacement deferred (harvest backoff)');
                continue;
              }
              const s = await harvestFn();
              if (s) { this.add(s); this.remove(acct.id); }
            }
          } catch (e) {
            console.log('[account-pool] refresh failed:', acct.email || acct.id, String(e.message || e).slice(0, 150));
          }
        }
        // 2) replenish
        await this.ensureMinPool(harvestFn);
        console.log(`[account-pool] cycle done: ${this.count()} accounts (${this.activeCount()} active)`);
      } catch (e) {
        console.log('[account-pool] background error:', String(e.message || e).slice(0, 200));
      }
    }, REFRESH_INTERVAL);

    // Real-time replenish tick: keeps the pool pinned at minPool after
    // rate-limit/expiry events without waiting for the 20min cycle.
    this.replenishTimer = setInterval(async () => {
      const active = this.accounts.filter(a => a.state === 'active').length;
      if (active >= this.minPool || this.replenishing) return;
      this.replenishing = true;
      try { await this.ensureMinPool(harvestFn); }
      catch (e) { console.log('[account-pool] replenish tick error:', String(e.message || e).slice(0, 150)); }
      finally { this.replenishing = false; }
    }, replenishMs);
  }

  stopBackground() {
    if (this.backgroundTimer) { clearInterval(this.backgroundTimer); this.backgroundTimer = null; }
    if (this.replenishTimer) { clearInterval(this.replenishTimer); this.replenishTimer = null; }
  }
}

module.exports = { AccountPool };