// Minimal CDP (Chrome DevTools Protocol) client over WebSocket (Node >= 22).
const http = require('http');

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';

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

class CdpSession {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const s = new CdpSession(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && s.pending.has(msg.id)) {
        const { resolve, reject } = s.pending.get(msg.id);
        s.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        (s.handlers && s.handlers[msg.method] || []).forEach((h) => {
          try { h(msg.params); } catch (e) { /* handler errors ignored */ }
        });
      }
    };
    return s;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 60000);
    });
  }
  on(method, handler) { this.handlers = this.handlers || {}; (this.handlers[method] = this.handlers[method] || []).push(handler); }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

module.exports = { CdpSession, findPageTarget, listTargets, httpGetJson };