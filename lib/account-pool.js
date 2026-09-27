// Multi-account pool: manages distinct Sakana sessions, account leases, and
// serialized refresh/replenishment maintenance. Secrets stay server-side.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POOL_FILE = process.env.SAKANA_ACCOUNT_POOL_FILE || path.join(__dirname, '..', 'account_pool.json');
const SESSION_FILE = process.env.SAKANA_SESSION_FILE || path.join(__dirname, '..', 'session.json');
const envInt = (name, fallback, { min = 0 } = {}) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const MIN_POOL = envInt('ACCOUNT_POOL_MIN', 50, { min: 0 });
const MAX_POOL = Math.max(MIN_POOL, envInt('ACCOUNT_POOL_MAX', 50, { min: 0 }));
const REFRESH_INTERVAL = envInt('ACCOUNT_REFRESH_MS', 20 * 60 * 1000, { min: 1000 });
const REPLENISH_INTERVAL = envInt('ACCOUNT_REPLENISH_MS', 90000, { min: 100 });
const STALE_MS = envInt('ACCOUNT_STALE_MS', 15 * 60 * 1000, { min: 1000 });
const COOLDOWN_MS = envInt('RATE_LIMIT_COOLDOWN_MS', 10 * 60 * 1000, { min: 0 });
const HARVEST_RETRIES = Math.max(1, envInt('HARVEST_RETRIES', 3, { min: 1 }));
const HARVEST_RETRY_DELAY_MS = envInt('HARVEST_RETRY_DELAY_MS', 5000, { min: 0 });
const DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = envInt('MAX_CONCURRENT_PER_ACCOUNT', 6, { min: 1 });
const TOMBSTONE_TTL_MS = envInt('ACCOUNT_TOMBSTONE_TTL_MS', 24 * 60 * 60 * 1000, { min: 0 });

function sessionCookie(sess) {
  return ((sess?.cookieHeader || '').match(/(?:^|;\s*)sakana-chat=([^;]+)/) || [])[1] || '';
}

/** Stable identity is a session identity, not merely a Firebase uid. */
function sessionKey(sess) {
  if (!sess || typeof sess !== 'object') return '';
  const cookie = sessionCookie(sess).trim();
  if (!cookie) return '';
  const uid = String(sess.uid || '').trim();
  const email = String(sess.email || '').trim();
  return `${uid}#${email}#${cookie}`;
}

function hasValidSession(sess) {
  return !!sessionKey(sess);
}

function atomicWrite(file, text) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const tmp = path.join(dir, `.${base}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

class AccountPool {
  constructor(file = POOL_FILE, sessionFile = SESSION_FILE, opts = {}) {
    this.file = file;
    this.sessionFile = sessionFile;
    this.minPool = Math.max(0, Number.isFinite(opts.minPool) ? opts.minPool : MIN_POOL);
    this.maxPool = Math.max(this.minPool, Number.isFinite(opts.maxPool) ? opts.maxPool : MAX_POOL);
    this.maxConcurrentPerAccount = Math.max(1, Number.isFinite(opts.maxConcurrentPerAccount)
      ? opts.maxConcurrentPerAccount : DEFAULT_MAX_CONCURRENT_PER_ACCOUNT);
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.cooldownMs = Number.isFinite(opts.cooldownMs) ? Math.max(0, opts.cooldownMs) : COOLDOWN_MS;
    this.staleMs = Number.isFinite(opts.staleMs) ? Math.max(0, opts.staleMs) : STALE_MS;
    this.tombstoneTtlMs = Number.isFinite(opts.tombstoneTtlMs) ? Math.max(0, opts.tombstoneTtlMs) : TOMBSTONE_TTL_MS;
    this.harvestRetries = Math.max(1, Number.isFinite(opts.harvestRetries) ? opts.harvestRetries : HARVEST_RETRIES);
    this.harvestRetryDelayMs = Math.max(0, Number.isFinite(opts.harvestRetryDelayMs) ? opts.harvestRetryDelayMs : HARVEST_RETRY_DELAY_MS);
    this.accounts = [];
    this.nextIdx = 0;
    this.leases = new Map();
    this.backgroundTimer = null;
    this.replenishTimer = null;
    this.replenishing = false;
    this.refreshing = false;
    this._ensurePromise = null;
    this._cyclePromise = null;
    this._replenishScheduled = false;
    this._replenishTimer = null;
    this._stopped = false;
    this.lastHarvestAt = 0;
    this.lastHarvestError = '';
    this.lastHarvestErrorAt = 0;
    this.loadError = '';
    this.persistenceError = '';
    this.telemetry = {
      harvestAttempts: 0,
      harvestSuccesses: 0,
      harvestFailures: 0,
      refreshAttempts: 0,
      refreshSuccesses: 0,
      refreshFailures: 0,
      replacements: 0,
      selectionWaits: 0,
      leaseTimeouts: 0,
    };
    this.load();
  }

  _normalizeAccount(a) {
    if (!a || typeof a !== 'object' || !hasValidSession(a)) return null;
    a.state = a.state || 'active';
    a.savedAt = Number(a.savedAt) || 0;
    a.refreshes = Number(a.refreshes) || 0;
    a.inFlight = 0;
    a.successCount = Number(a.successCount) || 0;
    a.errorCount = Number(a.errorCount) || 0;
    a.generation = Number(a.generation) || 0;
    a.modelUse = a.modelUse && typeof a.modelUse === 'object' ? a.modelUse : {};
    a.modelCount = a.modelCount && typeof a.modelCount === 'object' ? a.modelCount : {};
    if (a.state === 'rate_limited' && !a.rateLimitedAt) a.rateLimitedAt = a.savedAt || this.now();
    return a;
  }

  load() {
    let parsed = [];
    let poolReadable = false;
    try {
      if (!fs.existsSync(this.file)) {
        poolReadable = true;
      } else {
        const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!Array.isArray(value)) throw new Error('account pool must be an array');
        parsed = value;
        poolReadable = true;
      }
    } catch (err) {
      this.loadError = String(err.message || err).slice(0, 240);
      console.log('[account-pool] load failed; preserving file:', this.loadError);
      parsed = [];
    }

    const seen = new Set();
    this.accounts = [];
    for (const raw of parsed) {
      const acct = this._normalizeAccount(raw);
      const key = acct && sessionKey(acct);
      if (!acct || !key || seen.has(key)) continue;
      seen.add(key);
      this.accounts.push(acct);
    }

    let changed = this.accounts.length !== parsed.length;
    try {
      if (fs.existsSync(this.sessionFile)) {
        const sess = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        if (hasValidSession(sess)) {
          const key = sessionKey(sess);
          const existing = this.accounts.find(a => sessionKey(a) === key);
          if (existing) {
            if ((sess.savedAt || 0) > (existing.savedAt || 0) && existing.state === 'active') {
              existing.cookieHeader = sess.cookieHeader;
              existing.cookies = sess.cookies || existing.cookies;
              existing.savedAt = sess.savedAt;
              existing.generation++;
              changed = true;
            }
          } else {
            this.accounts.unshift(this._normalizeAccount({
              id: crypto.randomUUID(),
              email: sess.email || '',
              uid: sess.uid || '',
              cookieHeader: sess.cookieHeader,
              cookies: sess.cookies || [],
              savedAt: sess.savedAt || this.now(),
              state: 'active',
              refreshes: 0,
            }));
            changed = true;
          }
        }
      }
    } catch (err) {
      this.loadError = this.loadError || String(err.message || err).slice(0, 240);
      console.log('[account-pool] session sync failed:', this.loadError);
    }

    this._compact(false);
    if (poolReadable && changed) this.save();
  }

  save() {
    try {
      const clean = this.accounts.map(({ inFlight, generation, ...rest }) => ({ ...rest }));
      atomicWrite(this.file, JSON.stringify(clean, null, 2));
      this.persistenceError = '';
      return true;
    } catch (err) {
      this.persistenceError = String(err.message || err).slice(0, 240);
      console.log('[account-pool] persistence failed:', this.persistenceError);
      return false;
    }
  }

  count() { return this.accounts.length; }

  _checkCooldowns(now = this.now()) {
    let updated = false;
    for (const a of this.accounts) {
      if (a.state !== 'rate_limited') continue;
      const at = Number(a.rateLimitedAt) || 0;
      if (at && now - at >= this.cooldownMs) {
        a.state = 'active';
        a.generation = (a.generation || 0) + 1;
        delete a.rateLimitedAt;
        updated = true;
        console.log('[account-pool] account cooldown recovered to active:', (a.email || a.id).slice(0, 32));
      }
    }
    if (updated) this.save();
    return updated;
  }

  _activeAccounts() {
    this._checkCooldowns();
    return this.accounts.filter(a => a.state === 'active');
  }

  /** Get a copy by id for conversation affinity. */
  get(id) {
    const a = this._activeAccounts().find(a => a.id === id);
    return a ? { ...a } : null;
  }

  activeCount() { return this._activeAccounts().length; }

  _select(model = '', { excludeIds = [] } = {}) {
    const excluded = new Set(excludeIds.filter(Boolean));
    const active = this._activeAccounts().filter(a => !excluded.has(a.id));
    if (!active.length) return null;
    const fresh = active.filter(a => !a.savedAt || this.now() - a.savedAt <= this.staleMs);
    const freshAvailable = fresh.filter(a => (a.inFlight || 0) < this.maxConcurrentPerAccount);
    const available = freshAvailable.length
      ? freshAvailable
      : active.filter(a => (a.inFlight || 0) < this.maxConcurrentPerAccount);
    if (!available.length) return null;
    let min = Infinity;
    for (const a of available) min = Math.min(min, a.inFlight || 0);
    const tied = available.filter(a => (a.inFlight || 0) === min);
    if (model) {
      const never = tied.filter(a => !((a.modelUse || {})[model]));
      if (never.length) return never[this.nextIdx++ % never.length];
      tied.sort((a, b) => ((a.modelUse || {})[model] || 0) - ((b.modelUse || {})[model] || 0) || String(a.id).localeCompare(String(b.id)));
      return tied[0];
    }
    return tied[this.nextIdx++ % tied.length];
  }

  /** Compatibility selection API. Prefer lease() in request paths. */
  next(model = '', options = {}) {
    const selected = this._select(model, options);
    if (!selected) this.telemetry.selectionWaits++;
    return selected ? { ...selected } : null;
  }

  /** Atomically select and occupy an account. */
  lease(model = '', { accountId = null, excludeIds = [], owner = '' } = {}) {
    const account = accountId
      ? this._activeAccounts().find(a => a.id === accountId && !excludeIds.includes(a.id))
      : this._select(model, { excludeIds });
    if (!account || (account.inFlight || 0) >= this.maxConcurrentPerAccount) {
      this.telemetry.selectionWaits++;
      return null;
    }
    const lease = {
      leaseId: crypto.randomUUID(),
      accountId: account.id,
      model,
      owner: owner || '',
      acquiredAt: this.now(),
      generation: account.generation || 0,
      accountRef: account,
      released: false,
    };
    account.inFlight = (account.inFlight || 0) + 1;
    if (model) {
      account.modelUse = account.modelUse || {};
      account.modelUse[model] = this.now();
      account.modelCount = account.modelCount || {};
      account.modelCount[model] = (account.modelCount[model] || 0) + 1;
    }
    this.leases.set(lease.leaseId, lease);
    return { ...lease, account: { ...account }, accountRef: undefined };
  }

  leaseAccount(id, model = '', options = {}) {
    return this.lease(model, { ...options, accountId: id });
  }

  releaseLease(value, isSuccess = true, details = {}) {
    const leaseId = typeof value === 'string' ? value : value?.leaseId;
    if (!leaseId) return false;
    const lease = this.leases.get(leaseId);
    if (!lease || lease.released) return false;
    lease.released = true;
    this.leases.delete(leaseId);
    const account = lease.accountRef || this.accounts.find(a => a.id === lease.accountId);
    if (account) {
      account.inFlight = Math.max(0, (account.inFlight || 0) - 1);
      if (isSuccess) account.successCount = (account.successCount || 0) + 1;
      else account.errorCount = (account.errorCount || 0) + 1;
      if (!isSuccess && details.error) {
        account.lastError = String(details.error).slice(0, 200);
        account.lastErrorAt = this.now();
      }
    }
    return true;
  }

  /** Legacy counter API retained for tests and older integrations. */
  acquire(id, model = '') {
    const a = this.accounts.find(a => a.id === id);
    if (!a) return false;
    a.inFlight = (a.inFlight || 0) + 1;
    if (model) {
      a.modelUse = a.modelUse || {};
      a.modelUse[model] = this.now();
      a.modelCount = a.modelCount || {};
      a.modelCount[model] = (a.modelCount[model] || 0) + 1;
    }
    return true;
  }

  release(id, isSuccess = true) {
    const a = this.accounts.find(a => a.id === id);
    if (!a) return false;
    a.inFlight = Math.max(0, (a.inFlight || 1) - 1);
    if (isSuccess) a.successCount = (a.successCount || 0) + 1;
    else a.errorCount = (a.errorCount || 0) + 1;
    return true;
  }

  markRateLimited(idOrLease, reason = '') {
    const id = typeof idOrLease === 'string' ? idOrLease : idOrLease?.accountId;
    const acct = this.accounts.find(a => a.id === id);
    if (!acct || acct.state === 'expired') return false;
    acct.state = 'rate_limited';
    acct.rateLimitedAt = this.now();
    acct.generation = (acct.generation || 0) + 1;
    if (reason) { acct.lastError = String(reason).slice(0, 200); acct.lastErrorAt = this.now(); }
    this.save();
    console.log('[account-pool] rate-limited:', (acct.email || acct.id).slice(0, 32));
    return true;
  }

  markExpired(idOrLease, reason = '') {
    const id = typeof idOrLease === 'string' ? idOrLease : idOrLease?.accountId;
    const acct = this.accounts.find(a => a.id === id);
    if (!acct) return false;
    acct.state = 'expired';
    acct.expiredAt = this.now();
    acct.generation = (acct.generation || 0) + 1;
    if (reason) { acct.lastError = String(reason).slice(0, 200); acct.lastErrorAt = this.now(); }
    this.save();
    return true;
  }

  _writeLegacySession(session) {
    if (!hasValidSession(session)) return false;
    try {
      let current = null;
      try { current = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')); } catch {}
      if (current && hasValidSession(current)) {
        const currentAccount = this.accounts.find(a => sessionKey(a) === sessionKey(current));
        if (currentAccount && currentAccount.state !== 'active') return false;
        if (currentAccount && currentAccount.state === 'active') return true;
      }
      atomicWrite(this.sessionFile, JSON.stringify(session, null, 2));
      return true;
    } catch (err) {
      this.persistenceError = String(err.message || err).slice(0, 240);
      console.log('[account-pool] legacy session persistence failed:', this.persistenceError);
      return false;
    }
  }

  add(session) {
    if (!hasValidSession(session)) {
      this.lastHarvestError = 'harvest returned invalid session cookie';
      this.lastHarvestErrorAt = this.now();
      return null;
    }
    const key = sessionKey(session);
    if (this.accounts.some(a => sessionKey(a) === key)) return null;
    const id = crypto.randomUUID();
    this.accounts.push({
      id,
      email: session.email || '',
      uid: session.uid || '',
      cookieHeader: session.cookieHeader,
      cookies: session.cookies || [],
      savedAt: session.savedAt || this.now(),
      state: 'active',
      refreshes: 0,
      inFlight: 0,
      successCount: 0,
      errorCount: 0,
      generation: 0,
      modelUse: {},
      modelCount: {},
    });
    this._writeLegacySession(session);
    this._compact(true);
    this.save();
    return id;
  }

  /** Merge a freshly harvested session without resurrecting quarantined records. */
  upsert(session) {
    if (!hasValidSession(session)) return null;
    const key = sessionKey(session);
    const cookie = sessionCookie(session).trim();
    const existing = this.accounts.find(a =>
      sessionKey(a) === key || (cookie && sessionCookie(a).trim() === cookie)
    );
    if (!existing) return this.add(session);
    if (existing.state !== 'active') return null;
    if ((session.savedAt || 0) >= (existing.savedAt || 0)) {
      existing.cookieHeader = session.cookieHeader;
      existing.cookies = session.cookies || existing.cookies;
      existing.uid = session.uid || existing.uid || '';
      existing.email = session.email || existing.email || '';
      existing.savedAt = session.savedAt || this.now();
      existing.refreshes = (existing.refreshes || 0) + 1;
      existing.lastRefreshAt = this.now();
      existing.generation = (existing.generation || 0) + 1;
      this._writeLegacySession(session);
      this.save();
    }
    return existing.id;
  }

  remove(id, { force = false } = {}) {
    const acct = this.accounts.find(a => a.id === id);
    if (!acct) return false;
    if (!force && (acct.inFlight || 0) > 0) return false;
    this.accounts = this.accounts.filter(a => a.id !== id);
    this.save();
    return true;
  }

  _compact(persist = true) {
    const now = this.now();
    const leased = new Set([...this.leases.values()].filter(l => !l.released).map(l => l.accountId));
    const removable = (a) => !leased.has(a.id) && (!a.inFlight || a.inFlight <= 0);
    // Remove stale tombstones before enforcing max; preserve recently failed state
    // for diagnostics when there is room.
    this.accounts = this.accounts.filter(a => {
      if (a.state === 'active' || leased.has(a.id)) return true;
      const at = a.expiredAt || a.rateLimitedAt || a.lastErrorAt || a.savedAt || 0;
      return !this.tombstoneTtlMs || now - at < this.tombstoneTtlMs;
    });
    if (this.accounts.length > this.maxPool) {
      const candidates = this.accounts.filter(removable).sort((a, b) => {
        const stateRank = (x) => x.state === 'expired' ? 0 : x.state === 'rate_limited' ? 1 : 2;
        return stateRank(a) - stateRank(b) || (a.savedAt || 0) - (b.savedAt || 0);
      });
      const drop = Math.min(candidates.length, this.accounts.length - this.maxPool);
      const ids = new Set(candidates.slice(0, drop).map(a => a.id));
      if (ids.size) this.accounts = this.accounts.filter(a => !ids.has(a.id));
    }
    if (persist) this.save();
  }

  trim() { this._compact(true); }

  async ensureMinPool(harvestFn, target = this.minPool) {
    if (typeof harvestFn !== 'function') return 0;
    if (this._ensurePromise) return this._ensurePromise;
    this._ensurePromise = this._ensureMinPool(harvestFn, target)
      .catch((err) => { console.log('[account-pool] replenish error:', String(err.message || err).slice(0, 200)); throw err; })
      .finally(() => { this._ensurePromise = null; this.replenishing = false; });
    this.replenishing = true;
    return this._ensurePromise;
  }

  async _ensureMinPool(harvestFn, target) {
    const targetN = Math.min(Math.max(0, target), this.maxPool);
    let ok = 0;
    const backoffMs = envInt('HARVEST_BACKOFF_MS', 5 * 60 * 1000, { min: 0 });
    const critical = envInt('ACCOUNT_POOL_CRITICAL', 10, { min: 0 });
    this._checkCooldowns();
    let active = this.activeCount();
    if (active >= targetN) return 0;
    const sinceFail = this.now() - (this.lastHarvestErrorAt || 0);
    if (this.lastHarvestErrorAt && sinceFail < backoffMs && active >= critical) return 0;

    while (active < targetN) {
      let added = false;
      for (let attempt = 1; attempt <= this.harvestRetries && !added; attempt++) {
        this.telemetry.harvestAttempts++;
        try {
          const session = await harvestFn();
          const id = this.add(session);
          if (!id) throw new Error('harvest returned duplicate or invalid session');
          added = true;
          ok++;
          this.telemetry.harvestSuccesses++;
          this.lastHarvestAt = this.now();
          this.lastHarvestError = '';
          this.lastHarvestErrorAt = 0;
          active = this.activeCount();
        } catch (err) {
          this.telemetry.harvestFailures++;
          this.lastHarvestError = String(err.message || err).slice(0, 200);
          this.lastHarvestErrorAt = this.now();
          if (attempt < this.harvestRetries && this.harvestRetryDelayMs) await new Promise(resolve => setTimeout(resolve, this.harvestRetryDelayMs));
        }
      }
      if (!added) break;
      active = this.activeCount();
    }
    return ok;
  }

  scheduleReplenish(harvestFn, delayMs = 10000) {
    if (!harvestFn || this._replenishScheduled || this._stopped) return false;
    this._replenishScheduled = true;
    this._replenishTimer = setTimeout(() => {
      this._replenishTimer = null;
      this._replenishScheduled = false;
      if (this._stopped) return;
      this.ensureMinPool(harvestFn).catch(() => {});
    }, Math.max(0, delayMs));
    this._replenishTimer.unref?.();
    return true;
  }

  applyRefresh(acct, fresh, generation = acct?.generation) {
    if (!acct || !fresh || acct.state !== 'active' || acct.generation !== generation || !hasValidSession(fresh)) return false;
    if (sessionCookie(acct) !== sessionCookie(fresh)) return false;
    if (acct.uid && fresh.uid && acct.uid !== fresh.uid) return false;
    if (acct.email && fresh.email && acct.email !== fresh.email) return false;
    acct.cookieHeader = fresh.cookieHeader;
    acct.cookies = fresh.cookies || acct.cookies;
    acct.savedAt = fresh.savedAt || this.now();
    acct.refreshes = (acct.refreshes || 0) + 1;
    acct.generation = (acct.generation || 0) + 1;
    acct.lastRefreshAt = this.now();
    this.save();
    return true;
  }

  async _runBackgroundCycle(harvestFn, refreshFn) {
    if (this._cyclePromise) return this._cyclePromise;
    this._cyclePromise = (async () => {
      this.refreshing = true;
      try {
        this._checkCooldowns();
        const snapshot = this.accounts.filter(a => a.state === 'active' && !a.inFlight && (!a.savedAt || this.now() - a.savedAt >= this.staleMs)).map(a => ({ ...a }));
        for (const candidate of snapshot) {
          const acct = this.accounts.find(a => a.id === candidate.id);
          if (!acct || acct.state !== 'active' || acct.inFlight || acct.generation !== candidate.generation) continue;
          this.telemetry.refreshAttempts++;
          const version = acct.generation;
          try {
            const fresh = await refreshFn({ ...acct });
            if (fresh && this.applyRefresh(acct, fresh, version)) {
              this.telemetry.refreshSuccesses++;
              continue;
            }
            this.telemetry.refreshFailures++;
            if (acct.state !== 'active' || acct.generation !== version || acct.inFlight) continue;
            this.markExpired(acct.id, 'refresh returned no valid session');
            if (acct.inFlight) continue;
            const replacement = await harvestFn();
            const replacementId = this.add(replacement);
            if (replacementId) {
              this.remove(acct.id);
              this.telemetry.replacements++;
            }
          } catch (err) {
            this.telemetry.refreshFailures++;
            acct.lastError = String(err.message || err).slice(0, 200);
            acct.lastErrorAt = this.now();
          }
        }
        await this.ensureMinPool(harvestFn);
      } finally {
        this.refreshing = false;
      }
    })().finally(() => { this._cyclePromise = null; });
    return this._cyclePromise;
  }

  startBackground({ harvestFn, refreshFn, replenishMs = REPLENISH_INTERVAL, refreshMs = REFRESH_INTERVAL } = {}) {
    this.stopBackground();
    if (!harvestFn || !refreshFn) return;
    this._stopped = false;
    this._harvestFn = harvestFn;
    this.backgroundTimer = setInterval(() => {
      this._runBackgroundCycle(harvestFn, refreshFn).catch(err => console.log('[account-pool] background error:', String(err.message || err).slice(0, 200)));
    }, refreshMs);
    this.replenishTimer = setInterval(() => {
      if (this.refreshing || this._ensurePromise) return;
      if (this.activeCount() >= this.minPool) return;
      this.ensureMinPool(harvestFn).catch(() => {});
    }, replenishMs);
    this.backgroundTimer.unref?.();
    this.replenishTimer.unref?.();
  }

  stopBackground() {
    this._stopped = true;
    if (this.backgroundTimer) { clearInterval(this.backgroundTimer); this.backgroundTimer = null; }
    if (this.replenishTimer) { clearInterval(this.replenishTimer); this.replenishTimer = null; }
    if (this._replenishTimer) { clearTimeout(this._replenishTimer); this._replenishTimer = null; }
    this._replenishScheduled = false;
    this._harvestFn = null;
  }

  snapshot() {
    this._checkCooldowns();
    const now = this.now();
    const states = { active: 0, rate_limited: 0, expired: 0, other: 0 };
    let stale = 0;
    let inFlight = 0;
    let oldestLeaseAt = 0;
    for (const a of this.accounts) {
      if (Object.hasOwn(states, a.state)) states[a.state]++;
      else states.other++;
      if (a.state === 'active' && a.savedAt && now - a.savedAt > this.staleMs) stale++;
      inFlight += a.inFlight || 0;
    }
    for (const lease of this.leases.values()) {
      if (!lease.released && (!oldestLeaseAt || lease.acquiredAt < oldestLeaseAt)) oldestLeaseAt = lease.acquiredAt;
    }
    return {
      total: this.accounts.length,
      active: states.active,
      limited: states.rate_limited,
      expired: states.expired,
      target: this.minPool,
      max: this.maxPool,
      inFlight,
      stale,
      targetMet: states.active >= this.minPool,
      replenishing: !!this._ensurePromise,
      refreshing: !!this._cyclePromise,
      leaseCount: this.leases.size,
      oldestLeaseAgeMs: oldestLeaseAt ? Math.max(0, now - oldestLeaseAt) : 0,
      lastHarvestAt: this.lastHarvestAt,
      lastHarvestErrorAt: this.lastHarvestErrorAt,
      lastHarvestError: this.lastHarvestError,
      loadError: this.loadError,
      persistenceError: this.persistenceError,
      telemetry: { ...this.telemetry },
    };
  }

  safeAccount(a) {
    const now = this.now();
    const cooldownRemaining = a.state === 'rate_limited' && a.rateLimitedAt
      ? Math.max(0, this.cooldownMs - (now - a.rateLimitedAt)) : 0;
    const leaseAges = [...this.leases.values()]
      .filter(l => !l.released && l.accountId === a.id)
      .map(l => Math.max(0, now - l.acquiredAt));
    return {
      id: a.id,
      email: a.email || '',
      uid: a.uid || '',
      display: a.display || '',
      state: a.state || 'active',
      inFlight: a.inFlight || 0,
      successCount: a.successCount || 0,
      errorCount: a.errorCount || 0,
      refreshes: a.refreshes || 0,
      savedAt: a.savedAt || 0,
      cookieCount: Array.isArray(a.cookies) ? a.cookies.length : 0,
      rateLimitedAt: a.rateLimitedAt || 0,
      expiredAt: a.expiredAt || 0,
      lastRefreshAt: a.lastRefreshAt || 0,
      lastError: a.lastError || '',
      lastErrorAt: a.lastErrorAt || 0,
      cooldownRemainingMs: cooldownRemaining,
      stale: !!(a.state === 'active' && a.savedAt && now - a.savedAt > this.staleMs),
      leaseAgesMs: leaseAges.slice(0, 8),
      modelCount: Object.fromEntries(Object.entries(a.modelCount || {}).slice(0, 20)),
    };
  }
}

module.exports = { AccountPool, sessionKey, hasValidSession, POOL_FILE, SESSION_FILE };
