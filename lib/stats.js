// Lightweight in-process usage statistics + managed API key store for the
// sakana-2api management panel. Keys persist to keys.json (gitignored).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEYS_FILE = process.env.SAKANA_KEYS_FILE || path.join(__dirname, '..', 'keys.json');

const envInt = (name, fallback, min = 0) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const DEFAULT_MAX_MODELS = envInt('STATS_MAX_MODELS', 100, 0);
const DEFAULT_MAX_KEYS = envInt('STATS_MAX_KEYS', 1000, 0);
const DEFAULT_MAX_ERROR_LENGTH = envInt('STATS_MAX_ERROR_LENGTH', 500, 1);

function safeText(value, maxLength = DEFAULT_MAX_ERROR_LENGTH) {
  let text;
  try {
    if (value && typeof value === 'object' && value.message != null) value = value.message;
    text = typeof value === 'string' ? value : String(value ?? '');
  } catch {
    text = '[unprintable error]';
  }
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength);
}

function errorLabel(value) {
  let raw = '';
  try { raw = String(value?.errorCode || value?.code || value?.name || value || '').toUpperCase(); } catch {}
  if (raw === 'ABORT_ERR' || raw === 'REQUEST-ABORTED' || raw === 'ABORTERROR') return 'canceled';
  if (raw.includes('TIMEOUT') || raw === 'ETIMEDOUT') return 'timeout';
  if (/^(AUTH|CF-403)/.test(raw)) return 'auth';
  if (/^RATE|QUEUE_FULL/.test(raw)) return 'rate';
  if (/^ATTACHMENT/.test(raw)) return 'attachment';
  if (/^CONTEXT|CONV-/.test(raw)) return 'context';
  if (/^INVALID|BODY_TOO_LARGE|MISSING/.test(raw)) return 'client';
  return 'upstream';
}

/* ---------------- usage stats ---------------- */

class Stats {
  constructor(options = {}) {
    this.maxModels = Number.isFinite(options.maxModels) ? Math.max(0, options.maxModels)
      : (Number.isFinite(options.maxByModel) ? Math.max(0, options.maxByModel) : DEFAULT_MAX_MODELS);
    this.maxKeys = Number.isFinite(options.maxKeys) ? Math.max(0, options.maxKeys)
      : (Number.isFinite(options.maxByKey) ? Math.max(0, options.maxByKey) : DEFAULT_MAX_KEYS);
    this.maxErrorLength = Number.isFinite(options.maxErrorLength)
      ? Math.max(1, options.maxErrorLength)
      : (Number.isFinite(options.maxErrLength) ? Math.max(1, options.maxErrLength) : DEFAULT_MAX_ERROR_LENGTH);
    this.startedAt = Date.now();
    this.total = 0;
    this.stream = 0;
    this.nonStream = 0;
    this.ok = 0;
    this.err = 0;
    this.byModel = Object.create(null); // model -> { requests, charsIn, charsOut, errCount }
    this.conversations = 0;       // conversations created in this process
    this.promptChars = 0;
    this.completionChars = 0;
    this.lastErr = null;
    this.lastErrAt = 0;
    this.byKey = Object.create(null); // keyId -> count
    this.hourly = new Map();      // hourKey -> { hour, requests, ok, err, promptTokens, completionTokens, cost }
  }

  _modelName(model) {
    const text = safeText(model, 200);
    return text || 'unknown';
  }

  _keyName(keyId) {
    const text = safeText(keyId, 200);
    return text || '';
  }

  _getModel(model) {
    const name = this._modelName(model);
    if (Object.prototype.hasOwnProperty.call(this.byModel, name)) return this.byModel[name];
    if (Object.keys(this.byModel).length >= this.maxModels) return null;
    this.byModel[name] = { requests: 0, charsIn: 0, charsOut: 0, errCount: 0 };
    return this.byModel[name];
  }

  _getHourBucket(ts = Date.now()) {
    const d = new Date(ts);
    d.setMinutes(0, 0, 0);
    const key = d.getTime();
    if (!this.hourly.has(key)) {
      this.hourly.set(key, {
        ts: key,
        hourStr: `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`,
        dateStr: `${d.getMonth() + 1}/${d.getDate()}`,
        requests: 0,
        ok: 0,
        err: 0,
        promptTokens: 0,
        completionTokens: 0,
        cost: 0,
      });
    }
    // Clean up older than 30 days.
    if (this.hourly.size > 720) {
      const oldest = [...this.hourly.keys()].sort((a, b) => a - b)[0];
      this.hourly.delete(oldest);
    }
    return this.hourly.get(key);
  }

  begin(model) {
    this.total++;
    const bucket = this._getModel(model);
    if (bucket) bucket.requests++;
    const b = this._getHourBucket();
    b.requests++;
  }

  finish({ stream, ok, error, model, promptChars = 0, completionChars = 0, keyId = null } = {}) {
    if (stream) this.stream++; else this.nonStream++;
    this.promptChars += Number.isFinite(promptChars) ? promptChars : 0;
    this.completionChars += Number.isFinite(completionChars) ? completionChars : 0;
    const promptTokens = Math.round((Number.isFinite(promptChars) ? promptChars : 0) / 4);
    const completionTokens = Math.round((Number.isFinite(completionChars) ? completionChars : 0) / 4);
    // Rough OpenAI equivalent market value estimation: $0.005/1k prompt, $0.015/1k completion.
    const estCost = ((promptTokens * 0.005) + (completionTokens * 0.015)) / 1000;

    const bucket = this.byModel[this._modelName(model)];
    if (bucket) {
      bucket.charsIn += Number.isFinite(promptChars) ? promptChars : 0;
      bucket.charsOut += Number.isFinite(completionChars) ? completionChars : 0;
      if (!ok) bucket.errCount = (bucket.errCount || 0) + 1;
    }
    const b = this._getHourBucket();
    if (ok) {
      this.ok++;
      b.ok++;
    } else {
      this.err++;
      b.err++;
      this.lastErr = errorLabel(error || 'unknown');
      this.lastErrAt = Date.now();
    }
    b.promptTokens += promptTokens;
    b.completionTokens += completionTokens;
    b.cost += estCost;

    const key = this._keyName(keyId);
    if (key && Object.prototype.hasOwnProperty.call(this.byKey, key)) {
      this.byKey[key]++;
    } else if (key && Object.keys(this.byKey).length < this.maxKeys) {
      this.byKey[key] = 1;
    }
  }

  convCreated() { this.conversations++; }

  snapshot(session = null) {
    const ageSec = session && session.savedAt ? Math.floor((Date.now() - session.savedAt) / 1000) : null;
    const promptTokens = Math.round(this.promptChars / 4);
    const completionTokens = Math.round(this.completionChars / 4);
    const totalTokens = promptTokens + completionTokens;
    const totalCost = Number((((promptTokens * 0.005) + (completionTokens * 0.015)) / 1000).toFixed(4));

    // Prepare time-series array (hourly).
    const now = Date.now();
    const series24h = [];
    for (let i = 23; i >= 0; i--) {
      const t = now - i * 3600 * 1000;
      const d = new Date(t);
      d.setMinutes(0, 0, 0);
      const b = this.hourly.get(d.getTime()) || {
        ts: d.getTime(),
        hourStr: `${String(d.getHours()).padStart(2, '0')}:00`,
        dateStr: `${d.getMonth() + 1}/${d.getDate()}`,
        requests: 0,
        ok: 0,
        err: 0,
        promptTokens: 0,
        completionTokens: 0,
        cost: 0,
      };
      series24h.push(b);
    }

    // Daily breakdown for 30d.
    const series30d = [];
    for (let i = 29; i >= 0; i--) {
      const t = now - i * 24 * 3600 * 1000;
      const d = new Date(t);
      const dayLabel = `${d.getMonth() + 1}/${d.getDate()}`;
      let reqs = 0, pTok = 0, cTok = 0, cst = 0;
      for (let h = 0; h < 24; h++) {
        const hd = new Date(d);
        hd.setHours(h, 0, 0, 0);
        const hb = this.hourly.get(hd.getTime());
        if (hb) {
          reqs += hb.requests;
          pTok += hb.promptTokens;
          cTok += hb.completionTokens;
          cst += hb.cost;
        }
      }
      series30d.push({
        dateStr: dayLabel,
        ts: d.getTime(),
        requests: reqs,
        promptTokens: pTok,
        completionTokens: cTok,
        tokens: pTok + cTok,
        cost: Number(cst.toFixed(4)),
      });
    }

    return {
      ok: true,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      requests: { total: this.total, stream: this.stream, nonStream: this.nonStream, ok: this.ok, err: this.err },
      tokens: {
        prompt: promptTokens,
        completion: completionTokens,
        total: totalTokens,
      },
      cost: {
        total: totalCost,
        currency: 'USD',
      },
      byModel: { ...this.byModel },
      byKey: { ...this.byKey },
      conversations: this.conversations,
      lastErr: this.lastErr,
      lastErrAt: this.lastErrAt,
      timeSeries: {
        h24: series24h,
        d30: series30d,
      },
      session: session ? {
        loggedIn: !!session.loggedIn,
        cookieCount: (session.cookies || []).length,
        ageSec,
        anonymous: !!session.isAnonymous,
      } : null,
    };
  }
}

/* ---------------- managed API keys ---------------- */

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class KeyStore {
  constructor(file = KEYS_FILE) {
    this.file = file;
    this.keys = [];
    this.load();
  }

  load() {
    try { this.keys = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { this.keys = []; }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.keys, null, 2));
  }

  count() { return this.keys.length; }

  create(name) {
    const secret = 'sk-sak-' + crypto.randomBytes(24).toString('hex');
    const key = {
      id: crypto.randomUUID(),
      name: String(name || 'key-' + (this.keys.length + 1)).slice(0, 40),
      hash: sha(secret),
      prefix: secret.slice(0, 12),
      created: Date.now(),
      lastUsed: null,
      revoked: false,
    };
    this.keys.push(key);
    this.save();
    return { id: key.id, name: key.name, prefix: key.prefix, created: key.created, key: secret };
  }

  validate(token) {
    if (!token) return null;
    const h = sha(token);
    const key = this.keys.find((k) => k.hash === h && !k.revoked);
    if (key) {
      key.lastUsed = Date.now();
      this.save();
      return key;
    }
    return null;
  }

  revoke(id) {
    const key = this.keys.find((k) => k.id === id);
    if (!key) return false;
    key.revoked = true;
    this.save();
    return true;
  }

  remove(id) {
    const i = this.keys.findIndex((k) => k.id === id);
    if (i === -1) return false;
    this.keys.splice(i, 1);
    this.save();
    return true;
  }

  list() {
    return this.keys.map(({ id, name, prefix, created, lastUsed, revoked }) => ({
      id, name, prefix, created, lastUsed, revoked,
    }));
  }
}

module.exports = { Stats, KeyStore };
