// Lightweight in-process usage statistics + managed API key store for the
// sakana-2api management panel. Keys persist to keys.json (gitignored).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEYS_FILE = path.join(__dirname, '..', 'keys.json');

/* ---------------- usage stats ---------------- */

class Stats {
  constructor() {
    this.startedAt = Date.now();
    this.total = 0;
    this.stream = 0;
    this.nonStream = 0;
    this.ok = 0;
    this.err = 0;
    this.byModel = {};            // model -> { requests, charsIn, charsOut, errCount }
    this.conversations = 0;       // conversations created in this process
    this.promptChars = 0;
    this.completionChars = 0;
    this.lastErr = null;
    this.lastErrAt = 0;
    this.byKey = {};              // keyId -> count
    this.hourly = new Map();      // hourKey -> { hour, requests, ok, err, promptTokens, completionTokens, cost }
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
    // Clean up older than 30 days
    if (this.hourly.size > 720) {
      const oldest = [...this.hourly.keys()].sort((a, b) => a - b)[0];
      this.hourly.delete(oldest);
    }
    return this.hourly.get(key);
  }

  begin(model) {
    this.total++;
    if (!this.byModel[model]) this.byModel[model] = { requests: 0, charsIn: 0, charsOut: 0, errCount: 0 };
    this.byModel[model].requests++;
    const b = this._getHourBucket();
    b.requests++;
  }

  finish({ stream, ok, error, model, promptChars = 0, completionChars = 0, keyId = null } = {}) {
    if (stream) this.stream++; else this.nonStream++;
    this.promptChars += promptChars;
    this.completionChars += completionChars;
    const promptTokens = Math.round(promptChars / 4);
    const completionTokens = Math.round(completionChars / 4);
    // Rough OpenAI equivalent market value estimation: $0.005/1k prompt, $0.015/1k completion
    const estCost = ((promptTokens * 0.005) + (completionTokens * 0.015)) / 1000;

    if (this.byModel[model]) {
      this.byModel[model].charsIn += promptChars;
      this.byModel[model].charsOut += completionChars;
      if (!ok) this.byModel[model].errCount = (this.byModel[model].errCount || 0) + 1;
    }
    const b = this._getHourBucket();
    if (ok) {
      this.ok++;
      b.ok++;
    } else {
      this.err++;
      b.err++;
      this.lastErr = error || 'unknown';
      this.lastErrAt = Date.now();
    }
    b.promptTokens += promptTokens;
    b.completionTokens += completionTokens;
    b.cost += estCost;

    if (keyId) this.byKey[keyId] = (this.byKey[keyId] || 0) + 1;
  }

  convCreated() { this.conversations++; }

  snapshot(session = null) {
    const ageSec = session && session.savedAt ? Math.floor((Date.now() - session.savedAt) / 1000) : null;
    const promptTokens = Math.round(this.promptChars / 4);
    const completionTokens = Math.round(this.completionChars / 4);
    const totalTokens = promptTokens + completionTokens;
    const totalCost = Number((((promptTokens * 0.005) + (completionTokens * 0.015)) / 1000).toFixed(4));

    // Prepare time-series array (hourly)
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

    // Daily breakdown for 30d
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
      byModel: this.byModel,
      conversations: this.conversations,
      lastErr: this.lastErr,
      lastErrAt: this.lastErrAt,
      timeSeries: {
        h24: series24h,
        d30: series30d,
      },
      session: session ? {
        loggedIn: !!session.loggedIn,
        email: session.email || '',
        uid: session.uid || '',
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