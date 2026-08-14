// Multi-account pool: manages N distinct Sakana accounts, round-robins
// requests, auto-harvests new sessions via auto-session, detects rate-limits,
// and replenishes/refreshes the pool in the background.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POOL_FILE = path.join(__dirname, '..', 'account_pool.json');
const MIN_POOL = parseInt(process.env.ACCOUNT_POOL_MIN || '10', 10);
const MAX_POOL = parseInt(process.env.ACCOUNT_POOL_MAX || '10', 10);
const REFRESH_INTERVAL = parseInt(process.env.ACCOUNT_REFRESH_MS || String(20 * 60 * 1000), 10);
const STALE_MS = 30 * 60 * 1000; // cf_clearance TTL ~30min; refresh before it dies

class AccountPool {
  constructor() {
    this.accounts = []; // { id, email, uid, cookieHeader, cookies, savedAt, state, refreshes }
    this.nextIdx = 0;
    this.load();
    this.backgroundTimer = null;
  }

  load() {
    try { this.accounts = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); }
    catch { this.accounts = []; }
    // Dedupe: the old bug filled the pool with N copies of the SAME account.
    const seen = new Set();
    const out = [];
    for (const a of this.accounts) {
      if (!a || typeof a !== 'object' || !a.cookieHeader) continue;
      const key = (a.uid || a.email || a.cookieHeader.slice(0, 64));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    this.accounts = out;
    this.save();
  }

  save() {
    try { fs.writeFileSync(POOL_FILE, JSON.stringify(this.accounts, null, 2)); } catch {}
  }

  count() { return this.accounts.length; }

  activeCount() { return this.accounts.filter(a => a.state === 'active').length; }

  /** Get next active account (round-robin). Returns a copy; null if none. */
  next() {
    const active = this.accounts.filter(a => a.state === 'active');
    if (!active.length) return null;
    const idx = this.nextIdx % active.length;
    this.nextIdx = (idx + 1) % active.length;
    return { ...active[idx] };
  }

  /** Mark an account as rate-limited (gets refreshed/replaced). */
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

  /** Add a harvested session to the pool. Dedupes by uid/email. */
  add(session) {
    const key = (session.uid || session.email || session.cookieHeader || '').slice(0, 64);
    if (this.accounts.some(a => (a.uid || a.email || a.cookieHeader || '').slice(0, 64) === key)) {
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
    });
    // Also keep session.json in sync so the legacy fallback path stays valid.
    fs.writeFileSync(path.join(__dirname, '..', 'session.json'), JSON.stringify(session, null, 2));
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

  /** Drop duplicates and keep pool within MAX_POOL (newest first). */
  trim() {
    const active = this.accounts.filter(a => a.state === 'active');
    const others = this.accounts.filter(a => a.state !== 'active');
    if (active.length > MAX_POOL) {
      active.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      this.accounts = active.slice(0, MAX_POOL).concat(others);
      console.log('[account-pool] trimmed to', MAX_POOL);
    }
    this.save();
  }

  /**
   * Ensure at least MIN_POOL distinct active accounts, harvesting fresh
   * sessions via harvestFn() (which MUST create a brand-new account).
   */
  async ensureMinPool(harvestFn) {
    const active = this.accounts.filter(a => a.state === 'active').length;
    const needed = Math.max(0, Math.min(MIN_POOL, MAX_POOL) - active);
    if (needed <= 0) return;
    console.log(`[account-pool] need ${needed} more fresh accounts, harvesting (each ~60-90s, serialized)...`);
    let ok = 0;
    for (let i = 0; i < needed; i++) {
      try {
        const session = await harvestFn();
        if (session) { this.add(session); ok++; }
        console.log(`[account-pool] pool now: ${this.count()} accounts (${this.activeCount()} active)`);
      } catch (e) {
        console.log('[account-pool] harvest failed:', String(e.message || e).slice(0, 200));
      }
    }
    if (ok < needed) console.log(`[account-pool] got ${ok}/${needed} — will retry on next cycle`);
  }

  /**
   * Background keeper. Every REFRESH_INTERVAL:
   *  - refresh each account's cookies in-place (refreshFn), replacing dead ones
   *  - replenish below MIN_POOL (harvestFn creates fresh accounts)
   */
  startBackground({ harvestFn, refreshFn } = {}) {
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    if (!harvestFn || !refreshFn) return;
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
              acct.cookieHeader = fresh.cookieHeader;
              acct.cookies = fresh.cookies;
              acct.uid = fresh.uid || acct.uid;
              acct.email = fresh.email || acct.email;
              acct.savedAt = Date.now();
              acct.state = 'active';
              acct.refreshes = (acct.refreshes || 0) + 1;
              this.save();
            } else {
              // Login lost — replace this account with a fresh one.
              this.markExpired(acct.id);
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
  }

  stopBackground() {
    if (this.backgroundTimer) { clearInterval(this.backgroundTimer); this.backgroundTimer = null; }
  }
}

module.exports = { AccountPool };