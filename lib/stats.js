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
    this.byModel = {};            // model -> { requests, charsIn, charsOut }
    this.conversations = 0;       // conversations created in this process
    this.promptChars = 0;
    this.completionChars = 0;
    this.lastErr = null;
    this.lastErrAt = 0;
    this.byKey = {};              // keyId -> count
  }

  begin(model) {
    this.total++;
    if (!this.byModel[model]) this.byModel[model] = { requests: 0, charsIn: 0, charsOut: 0 };
    this.byModel[model].requests++;
  }

  finish({ stream, ok, error, model, promptChars = 0, completionChars = 0, keyId = null } = {}) {
    if (stream) this.stream++; else this.nonStream++;
    this.promptChars += promptChars;
    this.completionChars += completionChars;
    if (this.byModel[model]) {
      this.byModel[model].charsIn += promptChars;
      this.byModel[model].charsOut += completionChars;
    }
    if (ok) this.ok++;
    else {
      this.err++;
      this.lastErr = error || 'unknown';
      this.lastErrAt = Date.now();
    }
    if (keyId) this.byKey[keyId] = (this.byKey[keyId] || 0) + 1;
  }

  convCreated() { this.conversations++; }

  snapshot(session = null) {
    const ageSec = session && session.savedAt ? Math.floor((Date.now() - session.savedAt) / 1000) : null;
    return {
      ok: true,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      requests: { total: this.total, stream: this.stream, nonStream: this.nonStream, ok: this.ok, err: this.err },
      tokens: {
        prompt: Math.round(this.promptChars / 4),
        completion: Math.round(this.completionChars / 4),
      },
      byModel: this.byModel,
      conversations: this.conversations,
      lastErr: this.lastErr,
      lastErrAt: this.lastErrAt,
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