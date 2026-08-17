// Sakana web chat upstream client.
// Speaks the protocol in protocol.md: bootstrap + FormData NDJSON stream.

const { randomUUID } = require('crypto');
const { openaiRequestToSakana, sniffMimeType } = require('./translate');

// Configure high-concurrency connection pooling for undici / global fetch
try {
  const { setGlobalDispatcher, Agent } = require('undici');
  setGlobalDispatcher(new Agent({
    connections: 500,
    pipelining: 1,
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 600000,
  }));
} catch {}

const BASE = process.env.SAKANA_BASE || 'https://chat.sakana.ai';
const UA = process.env.SAKANA_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '300000', 10); // generous: generation can be long
const BOOTSTRAP_TIMEOUT = parseInt(process.env.UPSTREAM_BOOTSTRAP_MS || '60000', 10);

// UUIDv7 (time-ordered) — matches the browser's message ids on chat.sakana.ai
function uuidv7() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const t = BigInt(Date.now());
  b[0] = Number((t >> 40n) & 0xffn);
  b[1] = Number((t >> 32n) & 0xffn);
  b[2] = Number((t >> 24n) & 0xffn);
  b[3] = Number((t >> 16n) & 0xffn);
  b[4] = Number((t >> 8n) & 0xffn);
  b[5] = Number(t & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Build a browser-style multipart body. The service rejects undici FormData
// encoding (boundary naming / trailing CRLF) with INPUT-REQ-001; a
// WebKitFormBoundary-style body passes exactly like the web app's.
function buildMultipart(fields, files = []) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let b = '';
  for (let i = 0; i < 16; i++) b += chars[Math.floor(Math.random() * chars.length)];
  const boundary = '----WebKitFormBoundary' + b;
  const parts = [];
  const w = (s) => Buffer.from(s, 'utf8');
  for (const [name, value] of fields) {
    parts.push(w(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files) {
    parts.push(w(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: ${f.mime}\r\n\r\n`));
    parts.push(f.buf);
    parts.push(w('\r\n'));
  }
  parts.push(w(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

class UpstreamError extends Error {
  constructor(message, status, errorCode, context) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
    this.context = context;
  }
}

class SakanaUpstream {
  constructor(getSession) {
    this.getSession = getSession; // () => { cookieHeader, ua, id?, ... }
    this.lastSession = null; // which session served the last call (for rate-limit marking)
  }

  async _headers(extra = {}) {
    const sess = await this.getSession();
    this.lastSession = sess;
    // datadog/rum trace headers — the web app sends them on every API call;
    // requests without them get rejected (INPUT-REQ / bot check).
    const trace = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'); // 32 hex
    const span = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex');   // 16 hex
    return {
      'user-agent': sess.ua || UA,
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      referer: BASE + '/',
      cookie: sess.cookieHeader || '',
      'x-datadog-origin': 'rum',
      'x-datadog-trace-id': trace,
      'x-datadog-parent-id': span,
      'x-datadog-sampling-priority': '1',
      traceparent: '00-0000000000000000' + trace + '-' + span + '-01',
      tracestate: 'dd=s:1;o:rum',
      ...extra,
    };
  }

  async fetchText(url, init, timeoutMs = BOOTSTRAP_TIMEOUT) {
    let resp;
    try {
      resp = await fetch(BASE + url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new UpstreamError('upstream timeout (' + timeoutMs + 'ms)', 504, 'UPSTREAM-TIMEOUT');
      throw new UpstreamError('network error: ' + e.message, 502, 'UPSTREAM-NETWORK');
    }
    if (resp.status === 403 && /cloudflare|challenge/.test(resp.headers.get('content-type') || '')) {
      throw new UpstreamError('Cloudflare challenge (session expired?)', 403, 'CF-403');
    }
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (!resp.ok) {
      if (parsed && parsed.errorCode) throw new UpstreamError(parsed.errorCode + ' ' + (parsed.error || ''), resp.status, parsed.errorCode, parsed.context);
      throw new UpstreamError('HTTP ' + resp.status + ': ' + text.slice(0, 200), resp.status, null);
    }
    return { resp, text, parsed };
  }

  /**
   * Create a conversation on Sakana side.
   * Returns { conversationId, systemMessageId }.
   */
  async createConversation({ toneMode = 'default', enableThinking = false, webSearchEnabled = false, model = 'sakana-namazu', inputs } = {}) {
    const body = { inputs, enableThinking, toneMode, webSearchEnabled, model };
    if (!inputs) delete body.inputs;
    const { parsed } = await this.fetchText('/api/conversation', {
      method: 'POST',
      headers: await this._headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!parsed || !parsed.conversationId || !parsed.systemMessageId) {
      throw new UpstreamError('bootstrap ids missing: ' + JSON.stringify(parsed), 502, 'BAD-BOOTSTRAP');
    }
    return parsed;
  }

  /**
   * Stream a generation. Returns the fetch Response (body = NDJSON reader).
   */
  async streamGenerate(conversationId, req, { lastMessageId } = {}) {
    const data = {
      inputs: req.prompt || undefined,
      id: lastMessageId || uuidv7(),   // MUST reference an existing message (CONV-MSG-001 otherwise)
      is_retry: !!req.isRetry,
      is_continue: !!req.isContinue,
      enableThinking: !!req.enableThinking,
      toneMode: req.toneMode || 'default',
      webSearchEnabled: !!req.webSearchEnabled,
      userMessageId: req.userMessageId || randomUUID(), // free-form client id (v4)
      model: req.sakanaModel || 'sakana-namazu',    // browser sends model every turn
    };
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];

    // Resolve remote file URLs before upload (keeps protocol identical to browser).
    const fileParts = [];
    for (const f of req.files || []) {
      let buf = f.buf;
      let mime = f.mime;
      if (!buf && f.pendingUrl) {
        try {
          const r = await fetch(f.pendingUrl, { signal: AbortSignal.timeout(20000) });
          buf = Buffer.from(await r.arrayBuffer());
          if (!mime) mime = r.headers.get('content-type') || 'application/octet-stream';
        } catch (e) { continue; }
      }
      if (!buf) continue;
      if (!mime || mime === 'application/octet-stream') mime = sniffMimeType(buf);
      // The upstream treats `type=base64;`-prefixed filenames as base64-encoded
      // content and decodes it server-side (verified 2026-08: sending raw bytes
      // yields garbage in the sandbox — "Wrote 42 bytes"; sending the b64
      // string yields the exact original file). Other types pass through raw.
      let contentBuf = buf;
      if ((f.type || '') === 'base64') {
        contentBuf = Buffer.from(buf.toString('base64'), 'utf8');
      }
      fileParts.push({ filename: `${f.type || 'file'};${f.name}`, mime, buf: contentBuf });
    }

    const { boundary, body } = buildMultipart([['data', JSON.stringify(data)]], fileParts);
    // Minimal header set — byte-identical to the verified-working replay.
    const sess = await this.getSession();
    const trace = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
    const span = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex');
    const headers = {
      'user-agent': sess.ua || UA,
      'content-type': 'multipart/form-data; boundary=' + boundary,
      origin: BASE,
      referer: BASE + '/',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      cookie: sess.cookieHeader || '',
      // Real browser omits accept header on stream requests
      'x-datadog-origin': 'rum',
      'x-datadog-trace-id': trace,
      'x-datadog-parent-id': span,
      'x-datadog-sampling-priority': '1',
      traceparent: '00-0000000000000000' + trace + '-' + span + '-01',
      tracestate: 'dd=s:1;o:rum',
    };
    // Remove undefined keys
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];

    const resp = await fetch(BASE + '/api/conversation/' + encodeURIComponent(conversationId), {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    }).catch((e) => {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new UpstreamError('upstream generation timeout (' + FETCH_TIMEOUT + 'ms)', 504, 'UPSTREAM-TIMEOUT');
      throw new UpstreamError('network error: ' + e.message, 502, 'UPSTREAM-NETWORK');
    });
    if (!resp.ok) {
      const text = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      if (parsed && parsed.errorCode) throw new UpstreamError(parsed.errorCode, resp.status, parsed.errorCode);
      throw new UpstreamError('stream HTTP ' + resp.status + ': ' + text.slice(0, 200), resp.status);
    }
    return resp;
  }

  /**
   * Fetch the last message id in a conversation tree.
   * The stream turn's `id` must reference an existing message (CONV-MSG-001 otherwise).
   */
  async getLastMessageId(conversationId) {
    const conv = await this.getConversation(conversationId);
    const msgs = (conv && conv.messages) || [];
    return (msgs.length ? msgs[msgs.length - 1].id : '') || '';
  }

  /**
   * Compact a conversation tree (browser behavior: POST /api/conversation/{id}/compact).
   * Not strictly needed for proxy but matches real browser flow.
   */
  async compactConversation(conversationId, leafMessageId) {
    try {
      await this.fetchText('/api/conversation/' + encodeURIComponent(conversationId) + '/compact', {
        method: 'POST',
        headers: this._headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ leafMessageId }),
      });
    } catch {} // non-critical
  }

  async stopGeneration(conversationId) {
    try {
      await this.fetchText('/api/conversation/' + encodeURIComponent(conversationId) + '/stop', {
        method: 'POST',
        headers: await this._headers(),
      });
    } catch {}
  }

  async getConversation(id) {
    const { parsed } = await this.fetchText('/api/conversation/' + encodeURIComponent(id), {
      headers: await this._headers({ accept: 'application/json' }),
    });
    return parsed;
  }

  async listConversations(p = 0) {
    const { parsed } = await this.fetchText('/api/v2/conversations?p=' + p, {
      headers: await this._headers({ accept: 'application/json', cache: 'no-store' }),
    });
    return parsed && (parsed.json || parsed);
  }
}

module.exports = { SakanaUpstream, UpstreamError, BASE };