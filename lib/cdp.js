// Minimal CDP (Chrome DevTools Protocol) client over WebSocket (Node >= 22).
const http = require('http');

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';
const COMMAND_TIMEOUT_MS = Number.isFinite(Number(process.env.CDP_COMMAND_TIMEOUT_MS))
  ? Math.max(0, Number(process.env.CDP_COMMAND_TIMEOUT_MS)) : 60000;

async function httpGetJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

async function listTargets() {
  return httpGetJson('/json');
}

async function findPageTarget(match = 'chat.sakana.ai') {
  const targets = await listTargets();
  return targets.find((t) => t.type === 'page' && t.url.includes(match)) || targets.find((t) => t.type === 'page');
}

function normalizeError(reason, fallback = 'CDP session closed') {
  if (reason instanceof Error) return reason;
  const message = reason?.message || (typeof reason === 'string' ? reason : fallback);
  return new Error(String(message));
}

class CdpSession {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = {};
    this.closed = false;
    this.commandTimeoutMs = Number.isFinite(Number(options.commandTimeoutMs))
      ? Math.max(0, Number(options.commandTimeoutMs)) : COMMAND_TIMEOUT_MS;
    this._bindSocket();
  }

  static async connect(wsUrl, options = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      let settled = false;
      const onOpen = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const onError = (event) => {
        if (settled) return;
        settled = true;
        reject(normalizeError(event, 'CDP connection failed'));
      };
      ws.onopen = onOpen;
      ws.onerror = onError;
    });
    return new CdpSession(ws, options);
  }

  _bindSocket() {
    this.ws.onmessage = (ev) => {
      if (this.closed) return;
      let msg;
      try { msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; }
      catch (err) { this._fail(new Error('CDP invalid message: ' + String(err.message || err))); return; }
      if (msg?.id && this.pending.has(msg.id)) {
        const item = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(item.timer);
        if (msg.error) item.reject(new Error(JSON.stringify(msg.error)));
        else item.resolve(msg.result);
      } else if (msg?.method) {
        (this.handlers[msg.method] || []).forEach((handler) => {
          try { handler(msg.params); } catch (e) { /* handler errors ignored */ }
        });
      }
    };
    this.ws.onerror = (event) => this._fail(normalizeError(event, 'CDP socket error'));
    this.ws.onclose = (event) => this._fail(normalizeError(event, 'CDP session closed'));
  }

  _fail(reason) {
    const error = normalizeError(reason);
    const wasClosed = this.closed;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      try { item.reject(error); } catch {}
    }
    this.pending.clear();
    return !wasClosed;
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP session closed'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, handler) {
    (this.handlers[method] = this.handlers[method] || []).push(handler);
  }

  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    return r.result.value;
  }

  close(reason = 'CDP session closed') {
    this._fail(reason);
    try { this.ws.close(); } catch (e) {}
  }
}

module.exports = { CdpSession, findPageTarget, listTargets, httpGetJson };
