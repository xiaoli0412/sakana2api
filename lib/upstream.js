// Sakana web chat upstream client.
// Speaks the protocol in protocol.md: bootstrap + FormData NDJSON stream.

const { randomUUID } = require('crypto');
const { openaiRequestToSakana, sniffMimeType } = require('./translate');
const { abortCode, abortError } = require('./abort');

// Configure high-concurrency connection pooling for undici / global fetch
let globalDispatcher = null;
try {
  const { setGlobalDispatcher, Agent } = require('undici');
  globalDispatcher = new Agent({
    connections: 500,
    pipelining: 1,
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 600000,
  });
  setGlobalDispatcher(globalDispatcher);
} catch (error) {
  // A direct dependency is required for production; fail loudly if the
  // installed runtime cannot initialize the configured dispatcher.
  throw error;
}

const BASE = process.env.SAKANA_BASE || 'https://chat.sakana.ai';
const UA = process.env.SAKANA_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '300000', 10); // generous: generation can be long
const BOOTSTRAP_TIMEOUT = parseInt(process.env.UPSTREAM_BOOTSTRAP_MS || '60000', 10);
const MAX_MULTIPART_BYTES = Math.max(1, parseInt(process.env.UPSTREAM_MAX_MULTIPART_BYTES || String(64 * 1024 * 1024), 10));
const MAX_REMOTE_BYTES = Math.max(1, parseInt(process.env.UPSTREAM_MAX_REMOTE_BYTES || String(20 * 1024 * 1024), 10));

function timeoutSignal(parent, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(0, timeoutMs));
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function readLimitedBuffer(response, maxBytes, signal) {
  const declared = Number(response?.headers?.get?.('content-length') || 0);
  if (declared > maxBytes) {
    try { await response.body?.cancel?.(); } catch {}
    throw new UpstreamError('response exceeds configured limit', 413, 'BODY_TOO_LARGE');
  }
  if (!response?.body?.getReader) {
    if (signal?.aborted) throw abortError(signal.reason);
    if (!Number.isFinite(declared) || declared <= 0) {
      throw new UpstreamError('response size cannot be bounded', 413, 'BODY_TOO_LARGE');
    }
    const raw = Buffer.from(await response.arrayBuffer());
    if (signal?.aborted) throw abortError(signal.reason);
    if (raw.length > maxBytes) throw new UpstreamError('response exceeds configured limit', 413, 'BODY_TOO_LARGE');
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const onAbort = () => { try { reader.cancel(signal.reason); } catch {} };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw abortError(signal.reason);
      const { value, done } = await reader.read();
      if (signal?.aborted) throw abortError(signal.reason);
      if (done) break;
      size += value?.byteLength || 0;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new UpstreamError('response exceeds configured limit', 413, 'BODY_TOO_LARGE');
      }
      if (value?.byteLength) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    try { await reader.cancel(); } catch {}
  }
}

function closeGlobalDispatcher() {
  const dispatcher = globalDispatcher;
  globalDispatcher = null;
  if (!dispatcher || typeof dispatcher.close !== 'function') return Promise.resolve();
  return Promise.resolve(dispatcher.close()).catch(() => {});
}

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
  let totalBytes = 0;
  const push = (part) => {
    totalBytes += Buffer.byteLength(part);
    if (totalBytes > MAX_MULTIPART_BYTES) {
      const error = new UpstreamError('multipart payload exceeds configured limit', 413, 'MULTIPART_BUDGET_EXCEEDED');
      throw error;
    }
    parts.push(part);
  };
  const w = (s) => Buffer.from(s, 'utf8');
  for (const [name, value] of fields) {
    push(w(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files) {
    push(w(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: ${f.mime}\r\n\r\n`));
    push(f.buf);
    push(w('\r\n'));
  }
  push(w(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts), bytes: totalBytes };
}

class UpstreamError extends Error {
  constructor(message, status, errorCode, context) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
    this.context = context;
  }
}

function selectActiveLeaf(messages = []) {
  const list = Array.isArray(messages) ? messages.filter((message) => message && message.id) : [];
  if (!list.length) return '';
  const ids = new Set(list.map((message) => message.id));
  const childIds = new Set();
  for (const message of list) {
    for (const child of Array.isArray(message.children) ? message.children : []) {
      if (ids.has(child)) childIds.add(child);
    }
  }
  const leaves = list.filter((message) => !childIds.has(message.id));
  const active = leaves.find((message) => message.active || message.isActive || message.selected || message.current);
  return (active || leaves[leaves.length - 1] || list[list.length - 1]).id || '';
}

class SakanaUpstream {
  constructor(getSession) {
    this.getSession = getSession; // () => { cookieHeader, ua, id?, ... }
  }

  async _session() {
    const sess = await this.getSession();
    if (!sess || typeof sess !== 'object') throw new UpstreamError('no upstream session', 503, 'AUTH-LOGIN-001');
    return sess;
  }

  async _headers(extra = {}) {
    const sess = await this._session();
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
      traceparent: '00-' + trace + '-' + span + '-01',
      tracestate: 'dd=s:1;o:rum',
      ...extra,
    };
  }

  async fetchText(url, init, timeoutMs = BOOTSTRAP_TIMEOUT, signal) {
    const requestSignal = timeoutSignal(signal || init?.signal, timeoutMs);
    let resp;
    try {
      resp = await fetch(BASE + url, { ...init, signal: requestSignal });
    } catch (e) {
      const code = abortCode(requestSignal.reason || e, '');
      if (code === 'REQUEST-TIMEOUT') throw new UpstreamError('upstream timeout', 504, 'UPSTREAM-TIMEOUT');
      if (code === 'SERVER-SHUTDOWN') throw new UpstreamError('server is shutting down', 503, 'SERVER-SHUTDOWN');
      if (code === 'REQUEST-ABORTED') throw new UpstreamError('request aborted', 499, 'REQUEST-ABORTED');
      throw new UpstreamError('upstream network error', 502, 'UPSTREAM-NETWORK');
    }
    if (resp.status === 403 && /cloudflare|challenge/.test(resp.headers.get('content-type') || '')) {
      try { await resp.body?.cancel?.(); } catch {}
      throw new UpstreamError('Cloudflare challenge', 403, 'CF-403');
    }
    let text;
    try {
      text = (await readLimitedBuffer(resp, MAX_REMOTE_BYTES, requestSignal)).toString('utf8');
    } catch (e) {
      const code = abortCode(requestSignal.reason || e, '');
      if (code === 'REQUEST-TIMEOUT') throw new UpstreamError('upstream timeout', 504, 'UPSTREAM-TIMEOUT');
      if (code === 'SERVER-SHUTDOWN') throw new UpstreamError('server is shutting down', 503, 'SERVER-SHUTDOWN');
      if (code === 'REQUEST-ABORTED') throw new UpstreamError('request aborted', 499, 'REQUEST-ABORTED');
      if (e?.errorCode) throw e;
      throw new UpstreamError('upstream response read failed', 502, 'UPSTREAM-NETWORK');
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (!resp.ok) {
      if (parsed && parsed.errorCode) throw new UpstreamError(parsed.errorCode, resp.status, parsed.errorCode, parsed.context);
      throw new UpstreamError('upstream request failed', resp.status, 'UPSTREAM-ERROR');
    }
    return { resp, text, parsed };
  }

  /**
   * Create a conversation on Sakana side.
   * Returns { conversationId, systemMessageId }.
   */
  async createConversation({ toneMode = 'default', enableThinking = false, webSearchEnabled = false, model = 'sakana-namazu', inputs, signal } = {}) {
    const body = { inputs, enableThinking, toneMode, webSearchEnabled, model };
    if (!inputs) delete body.inputs;
    const { parsed } = await this.fetchText('/api/conversation', {
      method: 'POST',
      headers: await this._headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      signal,
    }, BOOTSTRAP_TIMEOUT, signal);
    if (!parsed || !parsed.conversationId || !parsed.systemMessageId) {
      throw new UpstreamError('bootstrap ids missing: ' + JSON.stringify(parsed), 502, 'BAD-BOOTSTRAP');
    }
    return parsed;
  }

  /**
   * Stream a generation. Returns the fetch Response (body = NDJSON reader).
   */
  async streamGenerate(conversationId, req, { lastMessageId, signal } = {}) {
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
        const fileSignal = timeoutSignal(signal || req.__requestSignal, 20000);
        let response;
        try {
          response = await fetch(f.pendingUrl, { signal: fileSignal });
          if (!response.ok) {
            try { await response.body?.cancel?.(); } catch {}
            throw new UpstreamError('remote attachment fetch failed', response.status, 'ATTACHMENT_FETCH_FAILED');
          }
          buf = await readLimitedBuffer(response, MAX_REMOTE_BYTES, fileSignal);
          if (!mime) mime = response.headers.get('content-type') || 'application/octet-stream';
        } catch (e) {
          const code = abortCode(fileSignal.reason || e, '');
          if (code === 'REQUEST-TIMEOUT') throw new UpstreamError('attachment fetch timeout', 504, 'REQUEST-TIMEOUT');
          if (code === 'SERVER-SHUTDOWN') throw new UpstreamError('server is shutting down', 503, 'SERVER-SHUTDOWN');
          if (code === 'REQUEST-ABORTED') throw new UpstreamError('request aborted', 499, 'REQUEST-ABORTED');
          if (e?.errorCode) throw e;
          throw new UpstreamError('remote attachment fetch failed', 502, 'ATTACHMENT_FETCH_FAILED');
        }
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
    const sess = await this._session();
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
      traceparent: '00-' + trace + '-' + span + '-01',
      tracestate: 'dd=s:1;o:rum',
    };
    // Remove undefined keys
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];

    const requestSignal = timeoutSignal(signal || req.__requestSignal, FETCH_TIMEOUT);
    const resp = await fetch(BASE + '/api/conversation/' + encodeURIComponent(conversationId), {
      method: 'POST',
      headers,
      body,
      signal: requestSignal,
    }).catch((e) => {
      const code = abortCode(requestSignal.reason || e, '');
      if (code === 'REQUEST-TIMEOUT') throw new UpstreamError('upstream generation timeout', 504, 'UPSTREAM-TIMEOUT');
      if (code === 'SERVER-SHUTDOWN') throw new UpstreamError('server is shutting down', 503, 'SERVER-SHUTDOWN');
      if (code === 'REQUEST-ABORTED') throw new UpstreamError('request aborted', 499, 'REQUEST-ABORTED');
      throw new UpstreamError('upstream network error', 502, 'UPSTREAM-NETWORK');
    });
    if (!resp.ok) {
      let text;
      try {
        text = (await readLimitedBuffer(resp, MAX_REMOTE_BYTES, requestSignal)).toString('utf8');
      } catch (e) {
        const code = abortCode(requestSignal.reason || e, '');
        if (code === 'REQUEST-TIMEOUT') throw new UpstreamError('upstream timeout', 504, 'UPSTREAM-TIMEOUT');
        if (code === 'SERVER-SHUTDOWN') throw new UpstreamError('server is shutting down', 503, 'SERVER-SHUTDOWN');
        if (code === 'REQUEST-ABORTED') throw new UpstreamError('request aborted', 499, 'REQUEST-ABORTED');
        throw e?.errorCode ? e : new UpstreamError('upstream error response read failed', 502, 'UPSTREAM-NETWORK');
      }
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      if (parsed && parsed.errorCode) throw new UpstreamError(parsed.errorCode, resp.status, parsed.errorCode);
      throw new UpstreamError('upstream request failed', resp.status, 'UPSTREAM-ERROR');
    }
    return resp;
  }

  /** Stable URL for a generated conversation file. */
  fileOutputUrl(conversationId, sha) {
    if (!conversationId || !sha) return '';
    return `${BASE}/api/conversation/${encodeURIComponent(conversationId)}/output/${encodeURIComponent(sha)}`;
  }

  /**
   * Fetch the last message id in a conversation tree.
   * The stream turn's `id` must reference an existing message (CONV-MSG-001 otherwise).
   */
  async getLastMessageId(conversationId, signal) {
    const conv = await this.getConversation(conversationId, signal);
    const msgs = (conv && conv.messages) || [];
    return selectActiveLeaf(msgs);
  }

  /**
   * Compact a conversation tree (browser behavior: POST /api/conversation/{id}/compact).
   * Not strictly needed for proxy but matches real browser flow.
   */
  async compactConversation(conversationId, leafMessageId, signal) {
    await this.fetchText('/api/conversation/' + encodeURIComponent(conversationId) + '/compact', {
      method: 'POST',
      headers: await this._headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ leafMessageId }),
    }, BOOTSTRAP_TIMEOUT, signal);
    return true;
  }

  async stopGeneration(conversationId, signal) {
    await this.fetchText('/api/conversation/' + encodeURIComponent(conversationId) + '/stop', {
      method: 'POST',
      headers: await this._headers(),
    }, BOOTSTRAP_TIMEOUT, signal);
    return true;
  }

  async getConversation(id, signal) {
    const { parsed } = await this.fetchText('/api/conversation/' + encodeURIComponent(id), {
      headers: await this._headers({ accept: 'application/json' }),
    }, BOOTSTRAP_TIMEOUT, signal);
    return parsed;
  }

  async listConversations(p = 0, signal) {
    const { parsed } = await this.fetchText('/api/v2/conversations?p=' + p, {
      headers: await this._headers({ accept: 'application/json', cache: 'no-store' }),
    }, BOOTSTRAP_TIMEOUT, signal);
    return parsed && (parsed.json || parsed);
  }
}

module.exports = { SakanaUpstream, UpstreamError, BASE, selectActiveLeaf, closeGlobalDispatcher, readLimitedBuffer, probeSession };

/**
 * Verify a session cookie against the authenticated user-settings endpoint
 * (2026-10: /api/v2/user/settings, 401 AUTH-LOGIN-001 when the session is
 * absent/invalid). Used by the admin account-import path before a cookie can
 * enter the pool. Never returns the response body to callers.
 */
async function probeSession(cookieHeader, { timeoutMs = 15000, signal = null } = {}) {
  const trace = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
  const span = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex');
  let resp;
  try {
    resp = await fetch(BASE + '/api/v2/user/settings', {
      headers: {
        'user-agent': UA,
        accept: 'application/json',
        cookie: cookieHeader || '',
        referer: BASE + '/',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'x-datadog-origin': 'rum',
        'x-datadog-trace-id': trace,
        'x-datadog-parent-id': span,
        traceparent: '00-' + trace + '-' + span + '-01',
        tracestate: 'dd=s:1;o:rum',
      },
      signal: timeoutSignal(signal, timeoutMs),
    });
  } catch (e) {
    return { ok: false, status: 0, error: stableProbeError(e) };
  }
  try { await resp.body?.cancel?.(); } catch {}
  return { ok: resp.status === 200, status: resp.status };
}

function stableProbeError(e) {
  const code = String(e?.code || e?.name || 'network_error');
  return code === 'AbortError' ? 'timeout' : 'network_error';
}
