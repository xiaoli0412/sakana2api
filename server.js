// sakana-2api — OpenAI-compatible reverse proxy for chat.sakana.ai web chat.
// Run: node server.js   (PORT=8787 SAKANA_SESSION_FILE=session.json)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { MODELS, openaiRequestToSakana, normalizedMessagesToPrompt, assertStandardModel, NdjsonTranslator, sse, clean, stripChips, extractFileContent, buildSearchChainPrompt, renderChainSources, mergeCitations, citationsToAnnotations } = require('./lib/translate');
const { anthropicToChat, chatToAnthropicNonStream, AnthropicStreamer } = require('./lib/anthropic');
const { SakanaUpstream, UpstreamError, closeGlobalDispatcher, probeSession } = require('./lib/upstream');
const { getSession, loadSession, setReloadHandler, SESSION_FILE } = require('./lib/session');
const { autoSession } = require('./lib/auto-session');
const { Stats, KeyStore } = require('./lib/stats');
const { AccountPool } = require('./lib/account-pool');
const { Cache } = require('./lib/cache');
const { ContextStore, firstUserText, lastUserText } = require('./lib/context');
const { normalizeRequestBody, AttachmentError } = require('./lib/request-normalizer');
const { buildNormalizedSakanaRequest } = require('./lib/request-assembly');
const { makeContextSnapshot, decideContext } = require('./lib/context-policy');
const { concurrencyManager } = require('./lib/concurrency');
const { abortCode, abortError: makeAbortError } = require('./lib/abort');
const optical = require('./lib/optical-context');
const { parsePngCard, normalizeCard, saveCard, loadCard, listCards, buildCardSystemText } = require('./lib/character-card');
const { buildRpSystem, resolveRpPreset, resolveRpNsfw, resolveRpLength } = require('./lib/rp-preset');
const {
  isGeminiBody, geminiRequestToChat, parseGeminiRoute, geminiModelList,
  geminiModelDetail, geminiErrorBody, createGeminiResponseAdapter,
} = require('./lib/gemini');

// Bind ONE account to the whole request: createConversation + streamGenerate
// must use the same session or the upstream 404s with CONV-NOTFOUND-001.
const als = new AsyncLocalStorage();
const activeRequests = new Set();
const REQUEST_TIMEOUT_MS = Math.max(1000, parseInt(process.env.REQUEST_TIMEOUT_MS || '300000', 10));
const SHUTDOWN_DRAIN_MS = Math.max(100, parseInt(process.env.SHUTDOWN_DRAIN_MS || '5000', 10));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || API_KEY;
const AUTO_SESSION = process.env.AUTO_SESSION !== 'false';
// Full response caching is opt-in: request bodies can be very large and the
// cache is an optimization, not part of conversation correctness.
const CACHE_ENABLED = process.env.CACHE_ENABLED === 'true';
const CONTEXT_COMPACT_THRESHOLD_BYTES = parseInt(process.env.CONTEXT_COMPACT_THRESHOLD_BYTES || '0', 10);
// writer profile gets an automatic upstream-side conversation compaction
// threshold when the global one is unset — long novels keep the tree healthy.
// Set WRITER_COMPACT_THRESHOLD_BYTES=0 to disable it explicitly.
const WRITER_COMPACT_THRESHOLD_BYTES = parseInt(process.env.WRITER_COMPACT_THRESHOLD_BYTES || String(64 * 1024), 10);
// Optical second-stage compression (DeepSeek-OCR style): for writer requests
// whose packaged document exceeds this many bytes, the older portion renders
// into columnar page images; the recent tail stays as the txt attachment.
// OPTICAL_CONTEXT=0 disables the stage entirely.
const OPTICAL_CONTEXT_THRESHOLD = Math.max(1, parseInt(process.env.OPTICAL_CONTEXT_THRESHOLD || String(200 * 1000), 10));
const COMPACTED_TTL_MS = Math.max(0, parseInt(process.env.COMPACTED_CONVERSATION_TTL_MS || String(24 * 60 * 60 * 1000), 10));
const COMPACTED_MAX = Math.max(0, parseInt(process.env.COMPACTED_CONVERSATION_MAX || '10000', 10));
const contextTelemetry = {
  compactions: 0,
  compactFailures: 0,
  lastCompactAt: 0,
  lastCompactError: '',
};
const compactedConversations = new Map();

const stats = new Stats();
const keyStore = new KeyStore();
const accountPool = new AccountPool();
const cache = new Cache();

const CARD_DIR = path.join(__dirname, 'character_cards');
let activeCharacter = null;

const upstream = new SakanaUpstream(() => {
  const bound = als.getStore();
  if (bound && bound.session) return bound.session;
  // In manual mode, never select stale/quarantined pool records. The pool is
  // only a provider in AUTO_SESSION mode; otherwise session.json is explicit.
  if (AUTO_SESSION) {
    const acct = accountPool.next();
    if (acct) return acct;
  }
  return getSession();
});
// built-in web UI (read per-request so edits apply live)
const UI_HTML_PATH = path.join(__dirname, 'public', 'index.html');

// ---- request/response audit log (in-memory headers-only ring buffer) ----
const AUDIT_MAX = 500;
const AUDIT_HEADER_VALUE_MAX = 256;
const auditLog = [];
const REQUEST_AUDIT_HEADERS = new Set([
  'content-type', 'accept', 'content-length', 'user-agent', 'x-request-id',
  'x-conversation-id', 'x-thread-id', 'x-target-model',
]);
const RESPONSE_AUDIT_HEADERS = new Set([
  'content-type', 'content-length', 'cache-control', 'x-conversation-id',
  'x-accel-buffering',
]);

const KNOWN_ERROR_CODES = new Set([
  'RP-MODEL-DISABLED', 'INVALID_ATTACHMENT', 'CONTEXT-REBUILD-FAILED',
  'EMPTY-RESPONSE', 'SERVER-BUSY', 'AUTH-LOGIN-001', 'AUTH-TOKEN-001',
  'AUTH-TOKEN-002', 'AUTH-BOT-001', 'CF-403', 'RATE-LIMIT-001',
  'RATE-ANON-001', 'UPSTREAM-TIMEOUT', 'UPSTREAM-NETWORK', 'BAD-BOOTSTRAP',
  'CONV-NOTFOUND-001', 'REQUEST-ABORTED', 'BODY_TOO_LARGE', 'INVALID_JSON',
  'MISSING-INPUT', 'ATTACHMENT_INVALID_DATA', 'ATTACHMENT_FETCH_FAILED',
  'ATTACHMENT_TOO_LARGE', 'ATTACHMENT_INVALID_SOURCE', 'TEXT_BUDGET_EXCEEDED',
  'ATTACHMENT_BUDGET_EXCEEDED', 'CONTEXT_BUDGET_EXCEEDED',
  'MULTIPART_BUDGET_EXCEEDED',
  'SERVER-SHUTDOWN', 'QUEUE_FULL', 'REQUEST-TIMEOUT',
]);

function stableErrorCode(error, status = 500) {
  const raw = String(error?.errorCode || error?.code || '').toUpperCase();
  if (raw === 'RP-MODEL-DISABLED' || raw === 'EMPTY-RESPONSE' || raw === 'SERVER-BUSY') return raw;
  if (raw === 'SERVER-SHUTDOWN' || raw === 'ERR_SERVER_SHUTDOWN') return 'SERVER-SHUTDOWN';
  if (raw === 'REQUEST-TIMEOUT' || raw === 'TIMEOUT' || raw === 'TIMEOUTERROR') return 'REQUEST-TIMEOUT';
  if (raw === 'REQUEST-ABORTED' || raw === 'ABORT_ERR' || raw === 'ABORTERROR') return 'REQUEST-ABORTED';
  if (error?.name === 'TimeoutError') return 'REQUEST-TIMEOUT';
  if (error?.name === 'AbortError') return 'REQUEST-ABORTED';
  if (raw === 'UPSTREAM-TIMEOUT') return raw;
  if (raw === 'UPSTREAM-NETWORK' || raw === 'ECONNRESET' || raw === 'ECONNREFUSED' || raw === 'ENOTFOUND') return 'UPSTREAM-NETWORK';
  if (raw === 'BODY_TOO_LARGE') return raw;
  if (raw === 'INVALID_JSON' || raw === 'MISSING-INPUT') return raw;
  if (/^ATTACHMENT(?:_|$)|^INVALID_ATTACHMENT/.test(raw)) return 'ATTACHMENT-ERROR';
  if (/^CONTEXT-/.test(raw) || raw === 'CONV-NOTFOUND-001') return 'CONTEXT-ERROR';
  if (/^AUTH-|^CF-403$/.test(raw)) return 'AUTHENTICATION-ERROR';
  if (/^RATE-|^RATE-LIMIT$/.test(raw)) return 'RATE-LIMIT';
  if (raw === 'BAD-BOOTSTRAP') return raw;
  if (status === 401) return 'AUTHENTICATION-ERROR';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT-FOUND';
  if (status === 408 || status === 504) return 'UPSTREAM-TIMEOUT';
  if (status === 429) return 'RATE-LIMIT';
  if (status >= 400 && status < 500) return 'INVALID-REQUEST';
  return 'UPSTREAM-ERROR';
}

function errorCategory(code, status = 500) {
  if (code === 'REQUEST-ABORTED') return 'canceled';
  if (code === 'REQUEST-TIMEOUT') return 'timeout';
  if (code === 'SERVER-SHUTDOWN') return 'shutdown';
  if (code === 'AUTHENTICATION-ERROR') return 'authentication';
  if (code === 'RATE-LIMIT' || code === 'SERVER-BUSY') return 'rate_limit';
  if (code === 'ATTACHMENT-ERROR') return 'attachment';
  if (code === 'CONTEXT-ERROR') return 'context';
  if (code === 'FORBIDDEN') return 'forbidden';
  if (code === 'NOT-FOUND') return 'not_found';
  if (code === 'INVALID-REQUEST' || code === 'BODY_TOO_LARGE' || code === 'INVALID_JSON' || code === 'MISSING-INPUT') return 'client';
  if (status >= 500 || code.startsWith('UPSTREAM-') || code === 'BAD-BOOTSTRAP') return 'upstream';
  return 'internal';
}

function genericErrorMessage(category) {
  return ({
    canceled: 'request canceled',
    timeout: 'upstream timeout',
    shutdown: 'server is shutting down',
    authentication: 'upstream authentication failed',
    rate_limit: 'upstream rate limit',
    attachment: 'attachment request failed',
    context: 'conversation context unavailable',
    forbidden: 'forbidden',
    not_found: 'not found',
    client: 'invalid request',
    upstream: 'upstream request failed',
    internal: 'internal server error',
  })[category] || 'internal server error';
}

function sanitizeError(error, status = 500) {
  const code = stableErrorCode(error, status);
  const category = errorCategory(code, status);
  return {
    code,
    category,
    status: Number.isFinite(Number(status)) ? Number(status) : 500,
    message: genericErrorMessage(category).slice(0, 160),
  };
}

function clientErrorStatus(error, fallback = 500) {
  const raw = Number(error?.status ?? fallback);
  if (raw === 499 || raw === 503 || raw === 504) return raw;
  if (raw >= 400 && raw < 500) return raw;
  return raw >= 500 ? 502 : raw;
}

function safeErrorDetail(error, status = 500) {
  const safe = sanitizeError(error, status);
  return `${safe.category}: ${safe.message}`.slice(0, 180);
}

function allowlistedHeaders(headers, allowlist) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName).toLowerCase();
    if (!allowlist.has(name)) continue;
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value == null) continue;
    out[name] = String(value).slice(0, AUDIT_HEADER_VALUE_MAX);
  }
  return out;
}

function safeAuditPath(rawUrl) {
  try {
    const parsed = new URL(rawUrl || '/', 'http://audit.local');
    const safe = new URLSearchParams();
    const queryAllowlist = new Set(['format', 'alt', 'p', 'page', 'limit']);
    for (const [key, value] of parsed.searchParams) {
      if (!queryAllowlist.has(key.toLowerCase())) continue;
      safe.append(key.slice(0, 32), String(value).slice(0, 64));
    }
    const query = safe.toString();
    return parsed.pathname.slice(0, 500) + (query ? '?' + query : '');
  } catch {
    return String(rawUrl || '').split('?')[0].slice(0, 500);
  }
}

function requestBodyMetadata(req, body) {
  const normalized = body?.__normalizedRequest;
  const messages = Array.isArray(normalized?.messages)
    ? normalized.messages.length
    : (Array.isArray(body?.messages) ? body.messages.length : null);
  const attachments = Array.isArray(normalized?.attachments)
    ? normalized.attachments.length
    : null;
  const explicit = Boolean(
    body?.conversation_id || body?.chat_id || body?.thread_id ||
    req?.headers?.['x-conversation-id'] || req?.headers?.['x-thread-id'],
  );
  return { explicit, messages, attachments };
}

function auditEntry(req, body, status, _response, error, duration, options = {}) {
  const safeError = error ? sanitizeError(error, status) : null;
  const requestMeta = requestBodyMetadata(req, body);
  const response = options.response || req?.__response || null;
  const responseHeaders = response?.getHeaders?.() || {};
  const requestBytes = Number.isFinite(Number(req?.__bodyBytes))
    ? Number(req.__bodyBytes)
    : (Number.isFinite(Number(req?.headers?.['content-length'])) ? Number(req.headers['content-length']) : null);
  const responseBytes = Number.isFinite(Number(req?.__responseBytes))
    ? Number(req.__responseBytes)
    : (Number.isFinite(Number(responseHeaders['content-length'])) ? Number(responseHeaders['content-length']) : null);
  const entry = {
    id: randomUUID().slice(0, 8),
    ts: Date.now(),
    method: String(req?.method || 'POST').slice(0, 16),
    path: safeAuditPath(req?.url),
    model: String(body?.model || '').slice(0, 120),
    status: Number(status) || 500,
    duration: Math.max(0, Math.min(Number(duration) || 0, 7 * 24 * 60 * 60 * 1000)),
    error: safeError?.message || null,
    errorCode: safeError?.code || null,
    errorCategory: safeError?.category || null,
    stream: options.stream ?? body?.stream !== false,
    cache: options.cacheHit === true,
    requestBytes,
    responseBytes,
    context: requestMeta,
    requestHeaders: allowlistedHeaders(req?.headers, REQUEST_AUDIT_HEADERS),
    responseHeaders: allowlistedHeaders(responseHeaders, RESPONSE_AUDIT_HEADERS),
  };
  if (req && typeof req === 'object') req.__auditEntry = entry;
  auditLog.unshift(entry);
  if (auditLog.length > AUDIT_MAX) auditLog.length = AUDIT_MAX;
  return entry;
}

function ensureAuditEntry(req, res) {
  if (req?.__auditEntry) return req.__auditEntry;
  const status = Number(res?.statusCode) || (res?.writableEnded ? 200 : 500);
  return auditEntry(req, null, status, null, status >= 400 ? { code: status >= 500 ? 'UPSTREAM-ERROR' : 'INVALID-REQUEST' } : null,
    Math.max(0, Date.now() - Number(req?.__requestStartedAt || Date.now())), { stream: false });
}

function finalizeAuditEntry(req, res) {
  const entry = ensureAuditEntry(req, res);
  if (!entry) return;
  const headers = res?.getHeaders?.() || {};
  entry.responseHeaders = allowlistedHeaders(headers, RESPONSE_AUDIT_HEADERS);
  if (Number.isFinite(Number(req.__responseBytes))) entry.responseBytes = Number(req.__responseBytes);
  else if (Number.isFinite(Number(headers['content-length']))) entry.responseBytes = Number(headers['content-length']);
}

function beginRequestLifecycle(req, res) {
  const controller = new AbortController();
  const signal = controller.signal;
  let finished = false;
  let cleaned = false;
  const timer = setTimeout(() => {
    const error = new Error('request timeout');
    error.code = 'REQUEST-TIMEOUT';
    controller.abort(error);
  }, REQUEST_TIMEOUT_MS);
  timer.unref?.();

  req.__signal = signal;
  req.__controller = controller;
  req.__response = res;
  req.__requestStartedAt = Date.now();
  req.__bodyBytes = 0;
  req.__responseBytes = 0;
  activeRequests.add(controller);

  const abort = (reason) => {
    if (!signal.aborted) controller.abort(reason instanceof Error ? reason : new Error(String(reason || 'request aborted')));
  };
  const onAborted = () => abort(Object.assign(new Error('request aborted'), { code: 'REQUEST-ABORTED' }));
  const onRequestError = (error) => abort(error);
  const onFinish = () => { finished = true; };
  const onClose = () => {
    if (!finished && !res.writableFinished && !res.writableEnded) {
      abort(Object.assign(new Error('client disconnected'), { code: 'REQUEST-ABORTED' }));
    }
  };

  const originalWrite = res.write;
  const originalEnd = res.end;
  const countBytes = (chunk, encoding) => {
    if (chunk == null || typeof chunk === 'function') return;
    try {
      req.__responseBytes += Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(String(chunk), encoding);
    } catch {}
  };
  res.write = function wrappedWrite(chunk, encoding, callback) {
    countBytes(chunk, encoding);
    return originalWrite.call(this, chunk, encoding, callback);
  };
  res.end = function wrappedEnd(chunk, encoding, callback) {
    countBytes(chunk, encoding);
    return originalEnd.call(this, chunk, encoding, callback);
  };

  req.once('aborted', onAborted);
  req.once('error', onRequestError);
  res.once('finish', onFinish);
  res.once('close', onClose);

  return {
    signal,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onRequestError);
      res.removeListener('finish', onFinish);
      res.removeListener('close', onClose);
      res.write = originalWrite;
      res.end = originalEnd;
      activeRequests.delete(controller);
    },
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Backpressure-aware SSE writer. res.write() returning false means the TCP
 * buffer is full; without awaiting drain, a slow client plus a fast upstream
 * piles every chunk into Node's internal queue (unbounded memory under load).
 * Producers `await writer.write(...)` so generation paces against the client,
 * and `writer.flush()` before res.end() guarantees ordering.
 */
function createSSEWriter(res) {
  let tail = Promise.resolve();
  let closed;
  const closedPromise = new Promise((resolve) => { closed = resolve; });
  res.once('close', closed);
  const write = (payload) => {
    const text = typeof payload === 'string' ? payload : sse(payload.event, payload.data);
    const run = tail.then(() => new Promise((resolve) => {
      if (res.writableEnded || res.destroyed || res.socket?.destroyed) return resolve();
      const ok = res.write(text);
      if (ok) return resolve();
      const onDrain = () => resolve();
      res.once('drain', onDrain);
      closedPromise.then(onDrain);
    }));
    tail = run;
    return run;
  };
  return { write, flush: () => tail };
}

function isRpModelError(error) {
  return String(error?.errorCode || error?.code || '') === 'RP-MODEL-DISABLED';
}

function sendRpModelError(res, error, gemini = false) {
  if (gemini) return sendJson(res, 400, geminiErrorBody(400, 'RP models are disabled [RP-MODEL-DISABLED]'));
  return sendJson(res, 400, {
    error: {
      message: 'RP models are disabled',
      type: 'invalid_request_error',
      code: 'RP-MODEL-DISABLED',
    },
  });
}

async function runChatResponse(chatBody, res, req = null) {
  if (req?.__signal) Object.defineProperty(chatBody, '__requestSignal', { value: req.__signal, enumerable: false, configurable: true, writable: true });
  if (req) Object.defineProperty(chatBody, '__request', { value: req, enumerable: false, configurable: true, writable: true });
  try {
    return await makeChatResponse(chatBody);
  } catch (error) {
    if (isRpModelError(error)) {
      sendRpModelError(res, error);
      return null;
    }
    if (error instanceof AttachmentError) {
      const code = stableErrorCode(error, error.status || 400);
      if (code === 'REQUEST-ABORTED' || code === 'REQUEST-TIMEOUT' || code === 'SERVER-SHUTDOWN') throw error;
      const safe = sanitizeError(error, 400);
      sendJson(res, 400, {
        error: {
          message: safe.message,
          type: 'invalid_request_error',
          code: safe.code,
        },
      });
      return null;
    }
    if (String(error?.errorCode || error?.code || '') === 'CONTEXT-REBUILD-FAILED') {
      sendJson(res, 409, {
        error: {
          message: 'conversation context unavailable',
          type: 'invalid_request_error',
          code: 'CONTEXT-REBUILD-FAILED',
        },
      });
      return null;
    }
    throw error;
  }
}

function memorySnapshot() {
  const mem = process.memoryUsage();
  const mib = (value) => Math.round(value / 1048576);
  return {
    rssMB: mib(mem.rss),
    heapUsedMB: mib(mem.heapUsed),
    heapTotalMB: mib(mem.heapTotal),
    externalMB: mib(mem.external),
    arrayBuffersMB: mib(mem.arrayBuffers),
  };
}

function readBody(req, limit = 32 * 1024 * 1024) {
  const signal = req?.__signal;
  const declared = Number(req?.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    const error = new Error(`request body exceeds ${limit} bytes`);
    error.code = 'BODY_TOO_LARGE';
    error.status = 413;
    req.resume?.();
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
      signal?.removeEventListener?.('abort', onSignalAbort);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.__bodyBytes = size;
      if (error) {
        chunks.length = 0;
        reject(error);
      } else {
        resolve(value);
      }
    };
    const abortError = (reason) => makeAbortError(reason);
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const error = new Error(`request body exceeds ${limit} bytes`);
        error.code = 'BODY_TOO_LARGE';
        settle(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(null, Buffer.concat(chunks));
    const onError = (error) => settle(error);
    const onAborted = () => settle(abortError());
    const onClose = () => {
      if (!req.complete) settle(abortError());
    };
    const onSignalAbort = () => {
      settle(abortError(signal.reason));
      req.resume?.();
    };
    if (signal?.aborted) {
      onSignalAbort();
      req.resume?.();
      return;
    }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
    signal?.addEventListener?.('abort', onSignalAbort, { once: true });
  });
}

function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

// Auth: open when nothing enforced.
// 多格式请求头适配:Authorization: Bearer / x-goog-api-key(Gemini 客户端) /
// goog-api-key / x-api-key / api-key;另支持 Gemini 官方 ?key= 查询参数。
function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const key = req.headers['x-goog-api-key'] || req.headers['goog-api-key'] ||
    req.headers['x-api-key'] || req.headers['api-key'];
  if (key) return key;
  try {
    const q = new URL(req.url, 'http://x').searchParams.get('key');
    if (q) return q;
  } catch {}
  return '';
}

function auth(req) {
  const activeKeys = keyStore.keys.filter((k) => !k.revoked).length;
  if (!API_KEY && activeKeys === 0) return true;
  const tok = extractToken(req);
  if (API_KEY && tok === API_KEY) return true;
  if (ADMIN_API_KEY && tok === ADMIN_API_KEY) return true;
  const key = keyStore.validate(tok);
  if (key) { req.keyId = key.id; req.keyName = key.name; return true; }
  return false;
}

function isAdmin(req) {
  const activeKeys = keyStore.keys.filter((k) => !k.revoked).length;
  if (!ADMIN_API_KEY && activeKeys === 0) return true;
  const tok = extractToken(req);
  // Managed API keys are for business endpoints only. Operational metadata and
  // key management require the explicitly configured static admin secret.
  return !!ADMIN_API_KEY && tok === ADMIN_API_KEY;
}

/** Mark only the account/lease that served this request. */
function markCurrentSession(err, leaseOrAccount = null) {
  const store = als.getStore();
  const subject = leaseOrAccount || store?.lease || store?.session || null;
  const accountId = subject?.accountId || subject?.id || '';
  if (!accountId || !err) return false;
  const code = String(err.errorCode || err.code || '');
  let marked = false;
  const reason = stableErrorCode(err, err?.status || 500);
  if (code === 'AUTH-LOGIN-001' || code === 'AUTH-TOKEN-001' || code === 'AUTH-TOKEN-002' || code === 'AUTH-BOT-001' || code === 'CF-403') {
    marked = accountPool.markExpired(accountId, reason);
  } else if (code === 'RATE-LIMIT-001' || code === 'RATE-ANON-001') {
    marked = accountPool.markRateLimited(accountId, reason);
  }
  if (marked && accountPool._harvestFn) accountPool.scheduleReplenish(accountPool._harvestFn);
  return marked;
}

function isRetryableAccountError(err) {
  const code = String(err?.errorCode || err?.code || '');
  return /^(?:CONV-NOTFOUND-001|RATE-LIMIT-001|RATE-ANON-001|RATE-MODEL|AUTH-LOGIN-001|AUTH-TOKEN-001|AUTH-TOKEN-002|AUTH-BOT-001|CF-403|UPSTREAM-TIMEOUT)$/.test(code);
}

function clearContextForAccountRetry(body, req = null) {
  const oldIds = [body.conversation_id, body.chat_id, body.thread_id,
    req?.headers?.['x-conversation-id'], req?.headers?.['x-thread-id']].filter(Boolean);
  const resolved = (typeof contextStore?.lookup === 'function')
    ? contextStore.lookup(req || {}, body)
    : null;
  if (resolved?.conversationId) oldIds.push(resolved.conversationId);
  for (const id of new Set(oldIds)) contextStore.clearConversation?.(id);
  body.conversation_id = undefined;
  body.chat_id = undefined;
  body.thread_id = undefined;
  if (req?.headers) {
    delete req.headers['x-conversation-id'];
    delete req.headers['x-thread-id'];
  }
  Object.defineProperty(body, '__forceNewContext', { value: true, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(body, '__ignoreExplicitContext', { value: true, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(body, '__contextRebuildAttempted', { value: true, enumerable: false, configurable: true, writable: true });
}

// ---- native tool-round continuation ---------------------------------------
// Upstream can end an image/file-analysis turn with sandbox tool calls and NO
// final text (its own flake). The web frontend handles this by sending
// is_continue until the model emits its real answer; the proxy must do the
// same transparently instead of leaking an empty completion to clients.
const MAX_TOOL_CONTINUE_ROUNDS = parseInt(process.env.MAX_TOOL_CONTINUE_ROUNDS || '2', 10);
// code profile keeps the chain alive longer: multi-step tool flows (write →
// run → fix) need more continue rounds than the default native-tool recovery.
const CODE_TOOL_CONTINUE_ROUNDS = Math.max(1, parseInt(process.env.CODE_TOOL_CONTINUE_ROUNDS || '4', 10));
const toolRoundsFor = (sakanaReq) => (sakanaReq?.route?.family === 'code' ? CODE_TOOL_CONTINUE_ROUNDS : MAX_TOOL_CONTINUE_ROUNDS);

/**
 * Generator variant of drainUpstreamRound for SSE producers: yields one
 * chat.completion.chunk event per translated chunk, live, as lines arrive.
 * (yield is not legal inside the plain onChunk callback used by the
 * non-stream/stream-write paths, so generators get their own reader loop.)
 */
async function* drainRoundToSSE(resp, translator, base, signal) {
  const reader = resp.body.getReader();
  const onAbort = () => { try { reader.cancel(signal.reason); } catch {} };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const decoder = new TextDecoder();
    let buf = '';
    const toData = (c) => {
      const data = { ...base, choices: c.choices };
      if (c.usage) data.usage = c.usage;
      if (c.citations && c.citations.length) data.citations = c.citations;
      return data;
    };
    for (;;) {
      if (signal?.aborted) throw makeAbortError(signal.reason);
      const { value, done } = await reader.read();
      if (signal?.aborted) throw makeAbortError(signal.reason);
      if (done) { buf += decoder.decode(); break; }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        for (const c of translator.line(line)) yield { event: 'chat.completion.chunk', data: toData(c) };
      }
    }
    if (buf.trim()) for (const c of translator.line(buf)) yield { event: 'chat.completion.chunk', data: toData(c) };
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    try { await reader.cancel(); } catch {}
  }
}

/**
 * Drain one upstream NDJSON generation stream through a translator.
 * Returns aggregates + translator state needed to decide whether the turn
 * needs continuation. Optional onChunk is called with every translated chunk
 * (used by streaming callers to write SSE as lines arrive).
 */
async function drainUpstreamRound(resp, translator, onChunk, signal) {
  const reader = resp.body.getReader();
  const onAbort = () => { try { reader.cancel(signal.reason); } catch {} };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const decoder = new TextDecoder();
    let buf = '';
    const agg = { content: '', reasoning: '', toolCalls: [] };
    const absorb = async (chunks) => {
      for (const c of chunks) {
        if (onChunk) await onChunk(c);
        const d = c.choices[0] && c.choices[0].delta;
        if (!d) continue;
        if (d.content) agg.content += d.content;
        if (d.reasoning_content) agg.reasoning += d.reasoning_content;
        if (d.tool_calls) agg.toolCalls.push(...d.tool_calls);
      }
    };
    for (;;) {
      if (signal?.aborted) throw makeAbortError(signal.reason);
      const { value, done } = await reader.read();
      if (signal?.aborted) throw makeAbortError(signal.reason);
      if (done) { buf += decoder.decode(); break; }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) { if (line.trim()) await absorb(translator.line(line)); }
    }
    if (buf.trim()) await absorb(translator.line(buf));
    return { t: translator, ...agg };
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    try { await reader.cancel(); } catch {}
  }
}

/**
 * is_continue round: reference the conversation's current leaf message and
 * send NO inputs/files — the sandbox already holds the attachments.
 */
async function continueNativeToolRound(conversationId, sakanaReq, signal) {
  const leaf = await upstream.getLastMessageId(conversationId, signal);
  const contReq = { ...sakanaReq, isContinue: true, prompt: undefined, files: [] };
  const resp = await upstream.streamGenerate(conversationId, contReq, { lastMessageId: leaf, signal });
  return { ...(await drainUpstreamRound(resp, new NdjsonTranslator({ declaredTools: sakanaReq.clientToolNames }), undefined, signal)), leaf };
}

/**
 * Smart-routing round 1 for code/writer profiles: a search-only collection
 * pass on the same conversation. Returns bounded sources for the thinking
 * round; the caller falls back to single-round on any failure.
 */
async function runSearchChainRound(conversationId, sakanaReq, { lastMessageId, signal }) {  const searchReq = {
    ...sakanaReq,
    prompt: buildSearchChainPrompt(sakanaReq),
    files: [],
    enableThinking: false,
    webSearchEnabled: true,
    tools: null,
    clientToolNames: [],
    isContinue: false,
    isRetry: false,
    route: { ...(sakanaReq.route || {}), chainSearch: false },
  };
  const t = new NdjsonTranslator({ declaredTools: [] });
  const resp = await upstream.streamGenerate(conversationId, searchReq, { lastMessageId, signal });
  const drained = await drainUpstreamRound(resp, t, undefined, signal);
  return { citations: t.citations || [], reasoning: drained.reasoning || '', note: renderChainSources(t.citations) };
}

/**
 * Optical second-stage compression for writer requests: when the packaged
 * context document exceeds OPTICAL_CONTEXT_THRESHOLD, render the older 70%
 * into columnar page images and keep the recent tail as the txt attachment.
 * Any failure leaves the original single-document pipeline untouched.
 */
async function maybeApplyOpticalCompression(sakanaReq, signal) {
  if (!sakanaReq?.route || sakanaReq.route.family !== 'writer') return;
  if (process.env.OPTICAL_CONTEXT === '0') return;
  const docIndex = (sakanaReq.files || []).findIndex((f) => f && f.synthetic && /^context_document\.(txt|json)$/.test(f.name));
  if (docIndex === -1) return;
  const doc = sakanaReq.files[docIndex];
  const fullText = doc.buf.toString('utf8');
  if (doc.buf.length < OPTICAL_CONTEXT_THRESHOLD) return;
  const keepChars = Math.min(Math.floor(fullText.length * 0.3), 100_000);
  const oldPart = fullText.slice(0, fullText.length - keepChars);
  const recentPart = fullText.slice(fullText.length - keepChars);
  if (oldPart.length < OPTICAL_CONTEXT_THRESHOLD) return;

  const rendered = await optical.renderTextToPages(oldPart, {
    density: process.env.OPTICAL_DENSITY || 'medium',
    maxPages: parseInt(process.env.OPTICAL_MAX_PAGES || '8', 10),
    signal,
  });
  if (!rendered.pages.length) return;

  const pageFiles = rendered.pages.map((page, i) => ({
    type: 'base64',
    name: `context_page-${String(i + 1).padStart(2, '0')}.png`,
    synthetic: true,
    mime: 'image/png',
    buf: page.buf,
  }));
  const recentFile = {
    ...doc,
    name: 'context_document.txt',
    mime: 'text/plain',
    buf: Buffer.from(recentPart, 'utf8'),
  };
  sakanaReq.files.splice(docIndex, 1, ...pageFiles, recentFile);
  const lastPage = String(rendered.pages.length).padStart(2, '0');
  sakanaReq.prompt = sakanaReq.prompt.replace(
    '... [文档主体内容已挂载至附件 context_document.txt] ...',
    `[文档较早部分已按阅读顺序渲染为图片 context_page-01..${lastPage},请先读取全部图片页;较近部分保留在附件 context_document.txt]`,
  );
  console.log(`[optical] writer document compressed: ${oldPart.length} chars -> ${rendered.pages.length} pages (density=${rendered.density}, truncated=${rendered.truncated})`);
}

// High-Affinity Conversation Context & Stickiness Manager
// Backed by lib/context.js (ContextStore, unit-tested). These thin wrappers
// keep the legacy call shapes AND bind the request-scoped account via
// AsyncLocalStorage when the caller doesn't pass one explicitly.
const contextStore = new ContextStore();

function lookupContext(req, body) {
  if (typeof req === 'string') return contextStore.lookup(req);
  return contextStore.lookup(req, body);
}

function saveContext(req, body, conversationId, lastMessageId, explicitAccountId = null, snapshot = null) {
  if (!conversationId) return;
  const bound = als.getStore();
  const previous = contextStore.getByConversationId(conversationId) || (typeof req === 'string' ? contextStore.lookup(req) : contextStore.lookup(req, body));
  const requestedMode = String(body?.history_mode || body?.historyMode || '').toLowerCase();
  const explicitContextId = body?.conversation_id || body?.chat_id || body?.thread_id ||
    (req?.headers && (req.headers['x-conversation-id'] || req.headers['x-thread-id'])) || '';
  const delta = requestedMode === 'delta' || (!!explicitContextId && !requestedMode);
  const effectiveSnapshot = delta && previous && snapshot
    ? {
        ...snapshot,
        firstMessageFingerprint: previous.firstMessageFingerprint || snapshot.firstMessageFingerprint,
        messageCount: Math.max(Number(previous.messageCount) || 0, Number(snapshot.messageCount) || 0),
      }
    : snapshot;
  if (typeof req === 'string') {
    const result = contextStore.save(req, undefined, conversationId, lastMessageId, explicitAccountId, effectiveSnapshot);
    if (lastMessageId) contextStore.updateLeaf(conversationId, lastMessageId, effectiveSnapshot);
    return result;
  }
  const accountId = explicitAccountId || (bound && bound.session && bound.session.id) || '';
  const result = contextStore.save(req, body, conversationId, lastMessageId, accountId, effectiveSnapshot);
  if (lastMessageId) contextStore.updateLeaf(conversationId, lastMessageId, effectiveSnapshot);
  return result;
}

async function refreshContextLeaf(conversationId, fallback = '', signal) {
  if (!conversationId) return '';
  try {
    const fresh = await upstream.getLastMessageId(conversationId, signal);
    return fresh || fallback || '';
  } catch {
    return fallback || '';
  }
}

async function maybeCompactConversation(conversationId, leafMessageId, normalized, signal, body = null) {
  const writerProfile = body?.__writerProfile === true;
  const compactThreshold = CONTEXT_COMPACT_THRESHOLD_BYTES > 0
    ? CONTEXT_COMPACT_THRESHOLD_BYTES
    : (writerProfile ? WRITER_COMPACT_THRESHOLD_BYTES : 0);
  if (!conversationId || !leafMessageId || !Number.isFinite(compactThreshold) || compactThreshold <= 0) return false;
  const now = Date.now();
  for (const [id, ts] of compactedConversations) {
    if (COMPACTED_TTL_MS <= 0 || now - ts >= COMPACTED_TTL_MS) compactedConversations.delete(id);
  }
  const compactedAt = compactedConversations.get(conversationId);
  if (compactedAt && (COMPACTED_TTL_MS <= 0 || now - compactedAt < COMPACTED_TTL_MS)) return false;
  const bytes = Number(normalized?.measurements?.totalBytes || normalized?.textBytes || 0);
  if (bytes < compactThreshold) return false;
  try {
    await upstream.compactConversation(conversationId, leafMessageId, signal);
    compactedConversations.set(conversationId, now);
    while (COMPACTED_MAX > 0 && compactedConversations.size > COMPACTED_MAX) {
      const oldest = compactedConversations.keys().next().value;
      if (oldest === undefined) break;
      compactedConversations.delete(oldest);
    }
    contextTelemetry.compactions++;
    contextTelemetry.lastCompactAt = now;
    return true;
  } catch (error) {
    contextTelemetry.compactFailures++;
    contextTelemetry.lastCompactAt = now;
    contextTelemetry.lastCompactError = stableErrorCode(error, error?.status || 500);
    return false;
  }
}

async function finalizeContext(body, normalized, conversationId, fallbackLeaf, req = {}, snapshot = null, signal) {
  if (signal?.aborted) throw makeAbortError(signal.reason);
  const finalLeaf = await refreshContextLeaf(conversationId, fallbackLeaf, signal);
  if (signal?.aborted) throw makeAbortError(signal.reason);
  saveContext(req, body, conversationId, finalLeaf, null, snapshot);
  if (signal?.aborted) throw makeAbortError(signal.reason);
  await maybeCompactConversation(conversationId, finalLeaf, normalized, signal, body);
  return finalLeaf;
}


/** Inject character card data into the messages array. */
function injectCharacterCard(messages, card, isNewConversation = null) {
  if (!card || !card.name || !Array.isArray(messages)) return messages;
  const msgs = [...messages];
  const shouldSeed = isNewConversation === null
    ? !msgs.some(m => m.role === 'assistant')
    : Boolean(isNewConversation);
  const sysText = buildCardSystemText(card, shouldSeed);
  if (sysText) msgs.unshift({ role: 'system', content: sysText });
  // first_mes as the first assistant message if the conversation is new
  if (card.first_mes && shouldSeed) {
    msgs.push({ role: 'assistant', content: card.first_mes });
  }
  return msgs;
}

// RP 专属模型注入的沉浸式角色扮演破限提示词(预设库 lib/rp-preset.js)。
// 预设档位:off / light(轻破甲,旧行为) / full(Sandbox 完全破限) / ako(旗舰:
// Ako 写作测试框架,骨架取自实测可用的 Gemini RP 破限请求)。
// 档位选择优先级:body.rp_preset > 请求头 x-rp-preset > env RP_PRESET > ako。
// 长度档位:body.rp_length > 请求头 x-rp-length > env RP_LENGTH > medium。
// 与角色卡叠加使用:ako/full 档位会把角色卡数据槽位化进 <bkgd_info> 段,
// 并从 prompt 中剥离重复注入的角色卡 system 文本(避免同一设定出现两次)。
function injectRpRules(sakanaReq, req, body) {
  if (!sakanaReq || !sakanaReq.isRP) return;
  const preset = resolveRpPreset(req, body);
  const nsfw = resolveRpNsfw(req, body);
  const length = resolveRpLength(req, body);
  let sys = buildRpSystem({ preset, nsfw, length });
  if (!sys) return;

  // 角色卡槽位化(仅 ako/full 档):解析卡 → 嵌入框架 → 剥离重复 system 文本
  if (preset === 'ako' || preset === 'full' || preset === 'sandbox') {
    try {
      const charId = body.character_id || req.headers['x-character-id'] || '';
      const card = charId ? loadCard(CARD_DIR, charId) : activeCharacter;
      if (card && card.name) {
        const embedded = buildRpSystem({ preset, nsfw, length, character: card });
        if (embedded) sys = embedded;
        // isNewConv 必须与注入时刻一致:角色卡注入后会把 first_mes 作为
        // assistant 消息追加,导致"存在 assistant"误判 → 特判末尾即 first_mes。
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const lastMsg = msgs[msgs.length - 1];
        const firstMesPushed = !!(card.first_mes && lastMsg && lastMsg.role === 'assistant' && lastMsg.content === card.first_mes);
        const isNewConv = firstMesPushed || !msgs.some((m) => m && m.role === 'assistant');
        const dupText = buildCardSystemText(card, isNewConv);
        const p = sakanaReq.prompt || '';
        if (dupText && p.startsWith(dupText)) {
          sakanaReq.prompt = p.slice(dupText.length).replace(/^\n+/, '');
        }
      }
    } catch (e) { console.log('[rp-preset] card slot error:', String(e.message || e).slice(0, 120)); }
  }

  sakanaReq.prompt = sys + '\n\n' + (sakanaReq.prompt || '');
}

/** main: POST /v1/chat/completions */
async function handleChatCompletions(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { return sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } }); }

  // 请求体双向兼容:Gemini generateContent 形态(contents[])在 OpenAI 端点上
  // 也能直接受理,自动翻译为内部消息格式(RP 客户端混用端点时不出错)。
  if (isGeminiBody(body)) {
    try {
      body = geminiRequestToChat(body, { model: req.headers['x-target-model'] || body.model || '', stream: body.stream !== false });
    } catch (error) {
      if (isRpModelError(error)) return sendRpModelError(res, error);
      throw error;
    }
  }
  return handleChatBody(req, res, body);
}

/** Gemini generateContent / streamGenerateContent:适配器把输出翻译为 Gemini 协议。 */
async function handleGeminiGenerate(req, res, route, url) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8')); }
  catch (e) {
    if (req.__signal?.aborted) throw e;
    return sendJson(res, 400, geminiErrorBody(400, 'invalid JSON'));
  }
  const altSse = String((url && url.searchParams.get('alt')) || '').toLowerCase() === 'sse';
  const stream = route.action === 'streamGenerateContent' || altSse || body.stream === true;
  // 请求体双向适配:Gemini 端点也接受 OpenAI messages 请求体
  const chatBody = (() => {
    try {
      return isGeminiBody(body)
        ? geminiRequestToChat(body, { model: route.model, stream })
        : { ...body, model: body.model || route.model, stream };
    } catch (e) {
        if (req.__signal?.aborted) throw e;
        if (isRpModelError(e)) return sendRpModelError(res, e, true);
        throw e;
      }
  })();
  if (!chatBody) return;

  chatBody.stream = stream;
  const adapter = createGeminiResponseAdapter(res, { model: chatBody.model });
  return handleChatBody(req, adapter, chatBody);
}

/** 所有聊天入口共用的管线(角色卡注入 / 并发控制 / 容错重试)。 */
async function handleChatBody(req, res, body, start = Date.now()) {
  let normalized;
  let contextSnapshot;
  // Long-context packaging format: body field wins, x-context-format header
  // is the wire-level override for clients that cannot extend the body.
  if (body && body.context_format === undefined && req?.headers?.['x-context-format']) {
    body.context_format = String(req.headers['x-context-format']);
  }
  try {
    normalized = await normalizeRequestBody(body, { signal: req.__signal });
    contextSnapshot = makeContextSnapshot(normalized);
  } catch (err) {
    if (err instanceof AttachmentError) {
      const code = stableErrorCode(err, err.status || 400);
      if (code === 'REQUEST-ABORTED' || code === 'REQUEST-TIMEOUT' || code === 'SERVER-SHUTDOWN') throw err;
      const error = sanitizeError(err, 400);
      return sendJson(res, 400, { error: { message: error.message, type: 'invalid_request_error', code: error.code } });
    }
    throw err;
  }
  Object.defineProperty(body, '__contextSnapshot', { value: contextSnapshot, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(body, '__normalizedRequest', { value: normalized, enumerable: false, configurable: true, writable: true });

  // Character card injection changes the effective prompt and history identity.
  // Resolve the client context first so an explicit delta continuation never
  // receives the card's first_mes again.
  const charId = body.character_id || req.headers['x-character-id'] || '';
  let card = null;
  try {
    card = charId ? loadCard(CARD_DIR, charId) : activeCharacter;
  } catch (e) {
    console.log(`[character-card] load error: ${stableErrorCode(e, 500)}`);
  }
  if (card && card.name && body.messages) {
    const explicitContextId = body.conversation_id || body.chat_id || body.thread_id ||
      req.headers['x-conversation-id'] || req.headers['x-thread-id'] || '';
    const existingContext = lookupContext(req, body);
    const contextMatches = !!existingContext && (!explicitContextId ||
      existingContext.conversationId === explicitContextId ||
      (existingContext.clientConversationIds || []).includes(explicitContextId));
    const isNewConversation = !body.__contextRebuildAttempted && !contextMatches;
    try {
      body.messages = injectCharacterCard(body.messages, card, isNewConversation);
    } catch (e) {
      console.log(`[character-card] inject error: ${stableErrorCode(e, 500)}`);
    }
    try {
      normalized = await normalizeRequestBody(body, { signal: req.__signal });
    } catch (err) {
      if (err instanceof AttachmentError) {
        const code = stableErrorCode(err, err.status || 400);
        if (code === 'REQUEST-ABORTED' || code === 'REQUEST-TIMEOUT' || code === 'SERVER-SHUTDOWN') throw err;
        const safe = sanitizeError(err, 400);
        return sendJson(res, 400, { error: { message: safe.message, type: 'invalid_request_error', code: safe.code } });
      }
      throw err;
    }
    contextSnapshot = makeContextSnapshot(normalized);
    Object.defineProperty(body, '__contextSnapshot', { value: contextSnapshot, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(body, '__normalizedRequest', { value: normalized, enumerable: false, configurable: true, writable: true });
  }

  const model = body.model || 'sakana';
  let acquired = false;
  try {
    assertStandardModel(model);
    const signal = req.__signal;
    try {
      await concurrencyManager.acquire(AUTO_SESSION ? accountPool : null, { signal });
      acquired = true;
    } catch (err) {
      const code = stableErrorCode(err, err?.status || 429);
      const status = code === 'SERVER-SHUTDOWN' ? 503 : (code === 'REQUEST-TIMEOUT' ? 504 : 429);
      const safe = sanitizeError(err, status);
      return sendJson(res, status, { error: { message: safe.message, type: safe.category, code: safe.code } });
    }
    const excludedAccounts = new Set();
    let ctxEntry = null;
    for (let attempt = 0; ; attempt++) {
      const contextForcedNew = !!body.__forceNewContext || !!body.__ignoreExplicitContext;
      const lookedUp = contextForcedNew ? null : lookupContext(req, body);
      const explicitContextId = contextForcedNew ? '' : body.conversation_id || body.chat_id || body.thread_id ||
        req.headers['x-conversation-id'] || req.headers['x-thread-id'] || '';
        const contextDecision = decideContext({
          explicitId: explicitContextId,
          stored: lookedUp,
          client: contextSnapshot,
          rebuildAttempted: !!body.__contextRebuildAttempted,
          historyMode: body.history_mode || body.historyMode || '',
        });
        if (contextDecision.action === 'rebuild' && !body.__contextRebuildAttempted) {
          clearContextForAccountRetry(body, req);
          ctxEntry = null;
        } else {
        ctxEntry = contextDecision.action === 'fork' ? null : lookedUp;
        if (contextDecision.action === 'fork') clearContextForAccountRetry(body, req);
      }
        if (contextDecision.reason === 'CONTEXT-REBUILD-FAILED') {
          throw Object.assign(new Error('conversation context could not be rebuilt'), { errorCode: contextDecision.reason, status: 409 });
        }

      let lease = null;
      if (AUTO_SESSION && ctxEntry && ctxEntry.accountId && !excludedAccounts.has(ctxEntry.accountId)) {
        lease = accountPool.lease(model, { accountId: ctxEntry.accountId, owner: req.headers['x-request-id'] || '' });
        if (!lease) {
          // A dead or saturated affinity account cannot be used for this turn.
          // Rebuild on a fresh account instead of sending the old conversation
          // id to an account that cannot see it.
          excludedAccounts.add(ctxEntry.accountId);
          ctxEntry = null;
          clearContextForAccountRetry(body, req);
        }
      }
      if (!lease && AUTO_SESSION) {
        lease = accountPool.lease(model, { excludeIds: [...excludedAccounts], owner: req.headers['x-request-id'] || '' });
      }
      const boundAccount = lease
        ? lease.account
        : await getSession().catch(() => null);
      if (!boundAccount) {
        const noAccount = Object.assign(new Error('no active Sakana account'), { errorCode: 'AUTH-LOGIN-001', status: 503 });
        if (lease) accountPool.releaseLease(lease, false, { error: noAccount.message });
        throw noAccount;
      }

      try {
        const result = await als.run({ session: boundAccount, lease, ctxEntry, signal }, () => handleChatInner(req, res, body, start, ctxEntry));
        const streamFailed = result && result.streamError;
        if (lease) accountPool.releaseLease(lease, !streamFailed, { error: result?.streamError || '' });
        if (streamFailed) markCurrentSession({ errorCode: result.streamErrorCode, message: result.streamError }, lease);
        return result;
      } catch (e) {
        if (lease) accountPool.releaseLease(lease, false, { error: e.message || e });
        const code = String(e?.errorCode || e?.code || '');
        if (code === 'RP-MODEL-DISABLED') {
          throw e;
        }
        const modelQuota = code.startsWith('RATE-MODEL');
        const retryable = isRetryableAccountError(e);
        if (retryable && !res.headersSent && attempt < (modelQuota ? 2 : 1)) {
          if (lease && lease.accountId) {
            excludedAccounts.add(lease.accountId);
            if (!modelQuota) markCurrentSession(e, lease);
          }
          // A retry on another account must not reuse the old account's
          // conversation, including when the client supplied an explicit id.
          ctxEntry = null;
          clearContextForAccountRetry(body, req);
          console.log(`[chat] retrying on a different account (${code || stableErrorCode(e, 500)})`);
          continue;
        }
        // The last retryable auth/rate failure still belongs to this account.
        // Record it before surfacing the error so the pool will not immediately
        // select the same bad session on the next request.
        if (retryable && lease && !modelQuota) markCurrentSession(e, lease);
        throw e;
      }
    }
  } catch (e) {
    if (res.headersSent) {
      try { res.end(); } catch {}
    } else {
      const status = clientErrorStatus(e, 500);
      const safe = sanitizeError(e, status);
      if (body.__statsStarted) {
        stats.finish({ stream: body.stream !== false, ok: false, error: safe.code, model: body.model || 'sakana', keyId: req.keyId });
      }
      auditEntry(req, body, status, null, e, Date.now() - start);
      if (isRpModelError(e)) {
        return sendRpModelError(res, e);
      }
      sendJson(res, status, { error: { message: safe.message, type: safe.category === 'client' ? 'invalid_request_error' : 'upstream_error', code: safe.code } });
    }
  } finally {
    if (acquired) concurrencyManager.release();
  }
}

/** inner handler (runs with request-bound session via AsyncLocalStorage) */
async function handleChatInner(req, res, body, start, ctxEntry) {

  try {
    const signal = req.__signal || als.getStore()?.signal;
    const normalized = body.__normalizedRequest || await normalizeRequestBody(body, { signal });
    const contextSnapshot = body.__contextSnapshot || makeContextSnapshot(normalized);
    const assembled = buildNormalizedSakanaRequest(body, normalized, ctxEntry);
    const sakanaReq = assembled.sakanaReq;
    const effectiveNormalized = assembled.normalized;
    sakanaReq.messageFingerprint = effectiveNormalized.fingerprint || normalized.fingerprint;
    sakanaReq.contextSnapshot = contextSnapshot;
    injectRpRules(sakanaReq, req, body);
    const streaming = body.stream !== false;
    const modelName = body.model || 'sakana';
    stats.begin(modelName);
    Object.defineProperty(body, '__statsStarted', { value: true, enumerable: false, configurable: true, writable: true });
    let promptChars = (sakanaReq.prompt || '').length + (sakanaReq.files || []).length * 200;
    if (process.env.DEBUG_PROMPT) {
    console.log('[prompt-metrics:' + modelName + ']', JSON.stringify({ promptChars, fileCount: sakanaReq.files?.length || 0 }));
  }

    // Extract text-based files
    if (sakanaReq.files && sakanaReq.files.length > 0) {
      const textParts = [];
      const remaining = [];
      for (const f of sakanaReq.files) {
        if (f.synthetic && /^context_document\.(txt|json)$/.test(f.name)) {
          remaining.push(f);
          continue;
        }
        const ext = extractFileContent(f);
        if (ext === null) { remaining.push(f); }
        else if (ext.text) { textParts.push(ext.text); }
      }
      sakanaReq.files = remaining;
      if (textParts.length) {
        sakanaReq.prompt = (sakanaReq.prompt || '') + '\n\n--- 文件内容 ---\n' + textParts.join('\n');
      }
    }

    // Check cache
    const explicitConversation = body.conversation_id || body.chat_id || body.thread_id || '';
    const cacheable = CACHE_ENABLED && !explicitConversation && !sakanaReq.isToolTurn && !(sakanaReq.tools && sakanaReq.tools.length) && !(sakanaReq.files && sakanaReq.files.some((f) => f && f.output));
    const cacheKey = cacheable ? cache.key(body, { semanticFingerprint: sakanaReq.messageFingerprint, normalized: sakanaReq.normalizedMessages }) : null;
    if (cacheKey && !streaming) {
      const cached = cache.get(cacheKey);
      if (cached) {
        stats.finish({ stream: false, ok: true, model: modelName, promptChars, completionChars: (cached.text || '').length, keyId: req.keyId });
        const entry = auditEntry(req, body, 200, cached, null, Date.now() - start);
        return sendJson(res, 200, cached);
      }
    }

    let conversationId = sakanaReq.conversationId;
    let lastMessageId = ctxEntry?.lastMessageId || '';

    // Auto-context lookup (client continues without passing conversation_id).
    // ctxEntry was resolved before account binding; reuse it to keep the same
    // account that owns the conversation (CONV-NOTFOUND-001 otherwise).
    if (!conversationId && !body.__forceNewContext && ctxEntry) {
      conversationId = ctxEntry.conversationId;
      lastMessageId = ctxEntry.lastMessageId || '';
      if (!lastMessageId) {
        try { lastMessageId = await upstream.getLastMessageId(conversationId, signal); } catch { conversationId = null; }
      }
    }

    if (!conversationId) {
      const boot = await upstream.createConversation({
        toneMode: sakanaReq.toneMode,
        enableThinking: sakanaReq.enableThinking,
        webSearchEnabled: sakanaReq.webSearchEnabled,
        model: sakanaReq.sakanaModel,
        inputs: (sakanaReq.files && sakanaReq.files.length > 0) ? undefined : sakanaReq.prompt,
        signal,
      });
      conversationId = boot.conversationId;
      stats.convCreated();
      lastMessageId = boot.systemMessageId;
    } else if (!lastMessageId) {
      lastMessageId = await upstream.getLastMessageId(conversationId, signal);
    }

    // Smart routing round 1 (code/writer profiles): search-only collection
    // pass, then feed the sources into the thinking round. Runs before the
    // main stream so lease/retry semantics on main-round failures are kept.
    let chainCitations = [];
    let chainReasoning = '';
    if (sakanaReq.route?.chainSearch && !sakanaReq.isToolTurn && !sakanaReq.isContinue) {
      try {
        const chain = await runSearchChainRound(conversationId, sakanaReq, { lastMessageId, signal });
        if (chain.note) {
          sakanaReq.prompt = chain.note + '\n\n' + sakanaReq.prompt;
          chainCitations = chain.citations;
          if (chain.citations.length) {
            chainReasoning = `🔍 联网检索完成,找到 ${chain.citations.length} 个来源。\n${chain.reasoning || ''}`;
          }
          try { lastMessageId = await upstream.getLastMessageId(conversationId, signal); } catch {}
        }
      } catch (e) {
        console.log(`[search-chain] round-1 failed, falling back to single round: ${stableErrorCode(e, 500)}`);
      }
    }

    // Optical second-stage compression (writer profile, very long docs).
    try {
      await maybeApplyOpticalCompression(sakanaReq, signal);
    } catch (e) {
      console.log(`[optical] render failed, keeping single-document pipeline: ${stableErrorCode(e, 500)}`);
    }

    const upResp = await upstream.streamGenerate(conversationId, sakanaReq, { lastMessageId, signal });

    if (!streaming) {
      let text = '';
      let reasoning = '';
      const toolCalls = [];
      const first = await drainUpstreamRound(upResp, new NdjsonTranslator({ declaredTools: sakanaReq.clientToolNames }), undefined, signal);
      text += first.content;
      reasoning += first.reasoning;
      toolCalls.push(...first.toolCalls);
      let t = first.t;

      // Transparent native-tool continuation: upstream sometimes ends an
      // image/file-analysis turn with tool calls but NO final text. The real
      // frontend sends is_continue until the model emits its answer — do the
      // same here, invisibly, up to MAX_TOOL_CONTINUE_ROUNDS.
      let rounds = 0;
      while (!text && !t.clientToolRound && rounds < toolRoundsFor(sakanaReq)) {
        rounds++;
        let cont;
        try { cont = await continueNativeToolRound(conversationId, sakanaReq, signal); }
        catch (e) { console.log(`[tool-continue] continue round failed: ${stableErrorCode(e, 500)}`); break; }
        text += cont.content;
        reasoning += cont.reasoning;
        toolCalls.push(...cont.toolCalls);
        cont.t.citations = mergeCitations(t.citations, cont.t.citations);
        t = cont.t;
        lastMessageId = cont.leaf;
      }

      // Empty upstream output even after continuation: signal the client
      // instead of returning a 200 with null content (which the user
      // reported as "no reply with no error").
      if (!text && !toolCalls.length) {
        stats.finish({ stream: false, ok: false, error: 'empty upstream response', model: modelName, keyId: req.keyId });
        const finalLeaf = await finalizeContext(body, normalized, conversationId, lastMessageId, req, contextSnapshot, signal);
        auditEntry(req, body, 200, null, 'empty upstream response', Date.now() - start);
        return sendJson(res, 200, { error: { message: 'upstream returned empty response (no content)', type: 'upstream_error', code: 'EMPTY-RESPONSE' } });
      }

      const finishReason = toolCalls.length && !text ? 'tool_calls' : 'stop';
      const msg = { role: 'assistant', content: text || null };
      if (reasoning) msg.reasoning_content = reasoning;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      const response = {
        id: t.assistantMessageId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        conversation_id: conversationId || undefined,
        choices: [{ index: 0, message: msg, finish_reason: finishReason }],
        usage: { prompt_tokens: Math.round(promptChars / 4), completion_tokens: Math.round(((text || '').length + (reasoning || '').length) / 4), total_tokens: 0 },
      };
      const mergedCitations = mergeCitations(chainCitations, t.citations);
      if (mergedCitations.length) {
        response.citations = mergedCitations;
        // OpenAI-style annotations projection for clients that read sources
        // from `annotations` rather than the custom `citations` field.
        response.annotations = citationsToAnnotations(mergedCitations);
      }
      stats.finish({ stream: false, ok: true, model: modelName, promptChars, completionChars: text.length, keyId: req.keyId });
      const finalLeaf = await finalizeContext(body, normalized, conversationId, lastMessageId, req, contextSnapshot, signal);
      if (cacheKey) cache.set(cacheKey, response);
      auditEntry(req, body, 200, null, null, Date.now() - start, { cacheHit: false, stream: false });
      return sendJson(res, 200, response);
    }

    // streaming
    res.setHeader('x-conversation-id', conversationId || '');
    sseHeaders(res);
    let t = new NdjsonTranslator({ declaredTools: sakanaReq.clientToolNames });
    let streamedChars = 0;
    const base = { id: t.assistantMessageId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelName };
    let streamError = null;
    let streamErrCode = null;
    const writer = createSSEWriter(res);
    try {
      const onChunk = async (c) => {
        const d = c.choices[0] && c.choices[0].delta;
        if (d && d.content) streamedChars += d.content.length;
        await writer.write({ event: 'chat.completion.chunk', data: { ...base, choices: c.choices } });
      };
      if (chainReasoning) {
        await writer.write({ event: 'chat.completion.chunk', data: { ...base, choices: [{ index: 0, delta: { reasoning_content: chainReasoning }, finish_reason: null }] } });
      }
      await drainUpstreamRound(upResp, t, onChunk, signal);
      // Native tool round with no text: continue transparently (same as the
      // non-stream path) so stream clients aren't cut off mid-analysis.
      let rounds = 0;
      while (!t.sentContent && !t.clientToolRound && !streamError && rounds < toolRoundsFor(sakanaReq)) {
        rounds++;
        try {
          const contT = new NdjsonTranslator({ declaredTools: sakanaReq.clientToolNames });
          const leaf = await upstream.getLastMessageId(conversationId, signal);
          lastMessageId = leaf;
          const contReq = { ...sakanaReq, isContinue: true, prompt: undefined, files: [] };
          const contResp = await upstream.streamGenerate(conversationId, contReq, { lastMessageId: leaf, signal });
          await drainUpstreamRound(contResp, contT, onChunk, signal);
          if (!contT.sentContent) { t.nativeToolRound = contT.nativeToolRound; continue; }
          // Text arrived in the continuation round — finish with that translator.
          contT.citations = mergeCitations(t.citations, contT.citations);
          t = contT;
        } catch (e) {
          streamError = safeErrorDetail(e);
          streamErrCode = stableErrorCode(e, 500);
          break;
        }
      }
      // Empty upstream output = silent failure (user typed, nothing came back).
      if (!t.sentContent && !streamError) {
        streamError = 'upstream returned empty response (no content)';
        streamErrCode = 'EMPTY-RESPONSE';
      }
      if (!streamError) {
        t.citations = mergeCitations(chainCitations, t.citations);
        for (const c of t.finish()) {
          const chunkData = { ...base, choices: c.choices };
          if (c.citations && c.citations.length) {
            chunkData.citations = c.citations;
            chunkData.annotations = citationsToAnnotations(c.citations);
          }
          if (c.usage) chunkData.usage = c.usage;
          await writer.write({ event: 'chat.completion.chunk', data: chunkData });
        }
      }
    } catch (e) {
      streamError = safeErrorDetail(e);
      streamErrCode = stableErrorCode(e, 500);
    }
    if (streamError) {
      const canceled = streamErrCode === 'REQUEST-ABORTED' || streamErrCode === 'REQUEST-TIMEOUT' || streamErrCode === 'SERVER-SHUTDOWN';
      if (!canceled) {
        const fb = { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: safeErrorDetail({ code: streamErrCode }), type: 'upstream_error', code: streamErrCode } };
        try { await writer.write({ event: 'chat.completion.chunk', data: fb }); } catch {}
      }
    }
    try {
      if (!signal?.aborted) await writer.write('data: [DONE]\n\n');
      await writer.flush();
      res.end();
    } catch {}
    const ok = !streamError;
    stats.finish({ stream: true, ok, model: modelName, promptChars, completionChars: streamedChars, keyId: req.keyId });
    if (!signal?.aborted) {
      await finalizeContext(body, normalized, conversationId, lastMessageId, req, contextSnapshot, signal);
    }
    auditEntry(req, body, signal?.aborted ? 499 : 200, null, streamError ? { code: streamErrCode } : null, Date.now() - start, { stream: true });
    return { streamError: streamError || '', streamErrorCode: streamErrCode || '' };
  } catch (e) {
    // Let the outer lease/retry coordinator classify errors before headers are
    // sent. Sending here used to make retries look like successful requests.
    if (!res.headersSent) throw e;
    try { res.end(); } catch {}
    return { streamError: safeErrorDetail(e), streamErrorCode: stableErrorCode(e, 500) };
  }
}

/** Legacy OpenAI completions: {model, prompt, max_tokens, stream, temperature} */
async function handleLegacyCompletions(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
    if (body.prompt === undefined && body.input === undefined) throw new Error('missing prompt');
  } catch (e) {
    if (req.__signal?.aborted) throw e;
    if (isRpModelError(e)) return sendRpModelError(res);
    return sendJson(res, 400, { error: { message: 'invalid JSON or missing prompt', type: 'invalid_request_error', code: 'INVALID_JSON' } });
  }
  // Normalize into chat.completions and translate back to legacy output.
  const chatBody = {
    ...body,
    messages: [{ role: 'user', content: Array.isArray(body.prompt) ? body.prompt.map(String).join('\n') : String(body.prompt ?? body.input) }],
  };
  delete chatBody.prompt;
  delete chatBody.completion;
  const stream = body.stream === true;
  const reader = await runChatResponse(chatBody, res, req);
  if (!reader) return;
  if (stream) {
    sseHeaders(res);
    const writer = createSSEWriter(res);
    for await (const c of reader) await writer.write({ event: c.event || 'chat.completion.chunk', data: c.data });
    await writer.flush();
    if (!req.__signal?.aborted) return res.end('data: [DONE]\n\n');
    return res.end();
  }
  return sendJson(res, 200, {
    id: 'cmpl-' + randomUUID().replace(/-/g, ''),
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: chatBody.model || 'sakana',
    choices: [{ index: 0, text: reader.content || '', finish_reason: 'stop' }],
    usage: { prompt_tokens: reader.promptTokens || 0, completion_tokens: reader.completionTokens || 0, total_tokens: (reader.promptTokens || 0) + (reader.completionTokens || 0) },
  });
}

/** Responses API (simplified): {model, input, instructions, stream, tools} */
async function handleResponses(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8')); }
  catch (e) {
    if (req.__signal?.aborted) throw e;
    return sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } });
  }
  if (body.input === undefined && (body.messages === undefined || body.messages === null)) {
    return sendJson(res, 400, { error: { message: 'missing input', type: 'invalid_request_error' } });
  }
  const chatBody = {
    ...body,
    // input may be a string or array of messages; instructions become a system message
    messages: [
      ...(body.instructions ? [{ role: 'system', content: body.instructions }] : []),
      ...(Array.isArray(body.input) ? body.input : [{ role: 'user', content: String(body.input ?? '') }]),
    ],
  };
  delete chatBody.input;
  delete chatBody.instructions;
  delete chatBody.output;
  delete chatBody.tool_choice;
  delete chatBody.parallel_tool_calls;
  const stream = body.stream === true;
  const reader = await runChatResponse(chatBody, res, req);
  if (!reader) return;
  if (stream) {
    // Emit OpenAI response-format chunks (response.output_text.delta) for compat.
    sseHeaders(res);
    const writer = createSSEWriter(res);
    for await (const c of reader) {
      if (c.event === 'chat.completion.chunk') {
        const d = c.data?.choices?.[0]?.delta?.content;
        if (d) await writer.write({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: d, item_id: 'msg_' + randomUUID().slice(0, 6) } });
        if (c.data?.choices?.[0]?.finish_reason) await writer.write({ event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_' + randomUUID().slice(0, 6), status: 'completed', output: [] } } });
      }
    }
    await writer.flush();
    if (!req.__signal?.aborted) return res.end('data: [DONE]\n\n');
    return res.end();
  }
  const text = reader.content || '';
  if (reader.error) return sendJson(res, 502, { error: { message: reader.error, type: 'upstream_error', code: 'EMPTY-RESPONSE' } });
  return sendJson(res, 200, {
    id: 'resp_' + randomUUID().replace(/-/g, '').slice(0, 12),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: chatBody.model || 'sakana',
    output: [{ id: 'msg_' + randomUUID().slice(0, 8), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: reader.promptTokens || 0, output_tokens: reader.completionTokens || 0, total_tokens: (reader.promptTokens || 0) + (reader.completionTokens || 0) },
    conversation_id: reader.conversationId || undefined,
  });
}

/** Anthropic Messages API: {model, system, messages, tools, tool_choice, max_tokens, stream} */
async function handleAnthropicMessages(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8')); }
  catch (e) {
    if (req.__signal?.aborted) throw e;
    return sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } });
  }
  const chatBody = anthropicToChat(body);
  // 与 chat 端点同源的扩展字段(rp / character card / 会话续传)
  for (const k of ['rp_preset', 'rpPreset', 'rp_nsfw', 'rpNsfw', 'rp_length', 'rpLength', 'character_id', 'message_id', 'conversation_id']) {
    if (body[k] !== undefined) chatBody[k] = body[k];
  }
  const stream = body.stream === true;
  chatBody.stream = stream;
  const reader = await runChatResponse(chatBody, res, req);
  if (!reader) return;
  if (stream) {
    sseHeaders(res);
    const streamer = new AnthropicStreamer({ model: chatBody.model || 'sakana' });
    const writer = createSSEWriter(res);
    await writer.write(`data: ${JSON.stringify(streamer.start())}\n\n`);
    for await (const c of reader) {
      if (c.event === 'chat.completion.chunk') {
        for (const ev of streamer.push(c.data)) await writer.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    }
    // 上游提前终止时补合规收尾事件
    if (!streamer.stopped) {
      for (const ev of streamer.push({ choices: [{ index: 0, delta: {}, finish_reason: 'end_turn' }] })) {
        await writer.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    }
    await writer.flush();
    if (!req.__signal?.aborted) return res.end('data: [DONE]\n\n');
    return res.end();
  }
  const toolCalls = reader.toolCalls || [];
  if (reader.error) return sendJson(res, 502, { error: { message: reader.error, type: 'upstream_error', code: 'EMPTY-RESPONSE' } });
  const finishReason = reader.finishReason || (!reader.content && toolCalls.length ? 'tool_calls' : 'stop');
  return sendJson(res, 200, chatToAnthropicNonStream({
    model: chatBody.model || 'sakana',
    usage: { prompt_tokens: reader.promptTokens || 0, completion_tokens: reader.completionTokens || 0 },
    choices: [{
      index: 0,
      message: { role: 'assistant', content: reader.content || '', tool_calls: toolCalls.length ? toolCalls : undefined },
      finish_reason: finishReason,
    }],
  }));
}

/**
 * Run chat/completions and return { content, reasoning, conversationId,
 * promptTokens, completionTokens } or an AsyncGenerator of SSE chunks when stream.
 */
async function makeChatResponse(chatBody) {
  const signal = chatBody.__requestSignal || als.getStore()?.signal;
  const request = chatBody.__request || als.getStore()?.request || { method: 'POST', url: '/v1/responses', headers: {} };
  const requestHeaders = request.headers || {};
  let normalized = chatBody.__normalizedRequest || await normalizeRequestBody(chatBody, { signal });
  let contextSnapshot = chatBody.__contextSnapshot || makeContextSnapshot(normalized);
  const explicitContextId = chatBody.conversation_id || chatBody.chat_id || chatBody.thread_id || '';
  const ctxCandidate = lookupContext(request, chatBody);
  const contextMatches = !explicitContextId
    ? !!ctxCandidate
    : !!ctxCandidate && (
      ctxCandidate.conversationId === explicitContextId ||
      (ctxCandidate.clientConversationIds || []).includes(explicitContextId)
    );

  // Decide whether this is a genuinely new conversation before injecting a
  // character card. An explicit delta turn has no assistant message of its own
  // but must not receive the card's first_mes a second time.
  const charId = chatBody.character_id || '';
  const card = charId ? loadCard(CARD_DIR, charId) : activeCharacter;
  if (card && card.name && Array.isArray(chatBody.messages)) {
    try {
      chatBody.messages = injectCharacterCard(
        chatBody.messages,
        card,
        !contextMatches,
      );
    } catch (e) { console.log(`[character-card] inject error (makeChatResponse): ${stableErrorCode(e, 500)}`); }
    try {
      normalized = await normalizeRequestBody(chatBody, { signal });
    } catch (err) {
      if (err instanceof AttachmentError) throw err;
      throw err;
    }
    contextSnapshot = makeContextSnapshot(normalized);
  }

  const contextDecision = decideContext({
    explicitId: explicitContextId,
    stored: ctxCandidate,
    client: contextSnapshot,
    historyMode: chatBody.history_mode || chatBody.historyMode || '',
    rebuildAttempted: !!chatBody.__contextRebuildAttempted,
  });
  let ctxEntry = contextDecision.action === 'fork' || contextDecision.action === 'rebuild' ? null : ctxCandidate;
  if (contextDecision.action === 'fork' || contextDecision.action === 'rebuild') clearContextForAccountRetry(chatBody);
  if (contextDecision.reason === 'CONTEXT-REBUILD-FAILED') {
    throw Object.assign(new Error('conversation context could not be rebuilt'), { errorCode: contextDecision.reason, status: 409 });
  }
  Object.defineProperty(chatBody, '__contextSnapshot', { value: contextSnapshot, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(chatBody, '__normalizedRequest', { value: normalized, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(chatBody, '__forceNewContext', { value: !!chatBody.__forceNewContext || contextDecision.action === 'fork' || contextDecision.action === 'rebuild', enumerable: false, configurable: true, writable: true });
  Object.defineProperty(chatBody, '__ignoreExplicitContext', { value: !!chatBody.__ignoreExplicitContext || contextDecision.action === 'rebuild', enumerable: false, configurable: true, writable: true });

  const model = chatBody.model || 'sakana';
  assertStandardModel(model);
  await concurrencyManager.acquire(AUTO_SESSION ? accountPool : null, { signal });
  let slotTransferred = false;
  const excludedAccounts = new Set();
  try {
    for (let attempt = 0; ; attempt++) {
      let lease = null;
      let activeCtxEntry = ctxEntry;
      if (AUTO_SESSION && activeCtxEntry?.accountId && !excludedAccounts.has(activeCtxEntry.accountId)) {
        lease = accountPool.lease(model, { accountId: activeCtxEntry.accountId, owner: chatBody.__requestId || '' });
        if (!lease) {
          excludedAccounts.add(activeCtxEntry.accountId);
          activeCtxEntry = null;
          ctxEntry = null;
          clearContextForAccountRetry(chatBody);
        }
      }
      if (AUTO_SESSION && !lease) lease = accountPool.lease(model, { excludeIds: [...excludedAccounts], owner: chatBody.__requestId || '' });
      const bound = lease ? lease.account : await getSession().catch(() => null);
      if (!bound) {
        throw Object.assign(new Error('no active Sakana account'), { errorCode: 'AUTH-LOGIN-001', status: 503 });
      }

      try {
        const requestStore = { session: bound, lease, ctxEntry: activeCtxEntry, signal, request: chatBody.__request || null };
        const result = await als.run(requestStore, () => makeChatResponseInner(chatBody));
        if (result && typeof result[Symbol.asyncIterator] === 'function') {
          slotTransferred = true;
          return (async function* () {
            let ok = true;
            let streamError = null;
            try {
              for (;;) {
                const step = await als.run(requestStore, () => result.next());
                if (step.done) break;
                const err = step.value?.data?.error;
                if (err) {
                  ok = false;
                  streamError = err;
                }
                yield step.value;
              }
            } catch (err) {
              ok = false;
              const safe = sanitizeError(err, err?.status || 500);
              streamError = { code: safe.code, message: safe.message };
              throw err;
            } finally {
              try { await als.run(requestStore, () => result.return?.()); } catch {}
              if (!ok && streamError?.code) markCurrentSession({ errorCode: streamError.code, message: streamError.message }, lease);
              if (lease) accountPool.releaseLease(lease, ok, { error: streamError?.message || '' });
              concurrencyManager.release();
            }
          })();
        }
        const ok = !result?.error;
        if (lease) accountPool.releaseLease(lease, ok, { error: result?.error || '' });
        return result;
      } catch (err) {
        if (lease) accountPool.releaseLease(lease, false, { error: stableErrorCode(err, err?.status || 500) });
        const code = String(err?.errorCode || err?.code || '');
        const modelQuota = code.startsWith('RATE-MODEL');
        const retryable = isRetryableAccountError(err);
        if (retryable && !modelQuota && lease) markCurrentSession(err, lease);
        if (retryable && attempt < (modelQuota ? 2 : 1)) {
          if (lease?.accountId) excludedAccounts.add(lease.accountId);
          activeCtxEntry = null;
          ctxEntry = null;
          clearContextForAccountRetry(chatBody);
          console.log('[makeChatResponse] retrying with fresh account (' + (code || stableErrorCode(err, 500)) + ')');
          continue;
        }
        throw err;
      }
    }
  } finally {
    if (!slotTransferred) concurrencyManager.release();
  }
}

async function makeChatResponseInner(chatBody) {
  const start = Date.now();
  const body = { ...chatBody };
  for (const key of ['__forceNewContext', '__ignoreExplicitContext', '__contextRebuildAttempted', '__contextSnapshot', '__normalizedRequest']) {
    if (chatBody[key] !== undefined) body[key] = chatBody[key];
  }

  // auto-stream: for legacy/responses we must decide immediately, so force non-stream here
  // unless the caller wants raw SSE (handled below).
  const signal = chatBody.__requestSignal || als.getStore()?.signal;
  const request = chatBody.__request || als.getStore()?.request || { method: 'POST', url: '/v1/responses', headers: {} };
  const normalized = chatBody.__normalizedRequest || await normalizeRequestBody(chatBody, { signal });
  const contextSnapshot = chatBody.__contextSnapshot || makeContextSnapshot(normalized);
  const ctxEntry = als.getStore()?.ctxEntry || null;
  const assembled = buildNormalizedSakanaRequest(body, normalized, ctxEntry);
  const sakanaReq = assembled.sakanaReq;
  const normalizedPrompt = assembled.normalizedPrompt;
  const effectiveNormalized = assembled.normalized;
  sakanaReq.messageFingerprint = effectiveNormalized.fingerprint || normalized.fingerprint;
  sakanaReq.contextSnapshot = contextSnapshot;
  injectRpRules(sakanaReq, request, body);
  const modelName = body.model || 'sakana';
  const streaming = body.stream === true ? true : false;
  stats.begin(modelName);
  let promptChars = (sakanaReq.prompt || '').length + (sakanaReq.files || []).length * 200;
  if (process.env.DEBUG_PROMPT) {
    console.log('[prompt-metrics:' + modelName + ']', JSON.stringify({ promptChars, fileCount: sakanaReq.files?.length || 0 }));
  }

  // Extract text-based files
  if (sakanaReq.files && sakanaReq.files.length > 0) {
    const textParts = [];
    const remaining = [];
      for (const f of sakanaReq.files) {
        if (f.synthetic && /^context_document\.(txt|json)$/.test(f.name)) {
          remaining.push(f);
          continue;
        }
        const ext = extractFileContent(f);
      if (ext === null) { remaining.push(f); }
      else if (ext.text) { textParts.push(ext.text); }
    }
    sakanaReq.files = remaining;
    if (textParts.length) {
      sakanaReq.prompt = (sakanaReq.prompt || '') + '\n\n--- 文件内容 ---\n' + textParts.join('\n');
    }
  }

  const cacheable = CACHE_ENABLED && !sakanaReq.isToolTurn && !(sakanaReq.tools && sakanaReq.tools.length) && !(sakanaReq.files && sakanaReq.files.some((f) => f && f.output));
  const cacheKey = cacheable ? cache.key(body, { semanticFingerprint: sakanaReq.messageFingerprint, normalized: sakanaReq.normalizedMessages }) : null;
  if (cacheKey && !streaming) {
    const cached = cache.get(cacheKey);
    if (cached) {
      stats.finish({ stream: false, ok: true, model: modelName, promptChars, completionChars: (cached.text || '').length, keyId: null });
      return { content: cached.choices?.[0]?.message?.content || '', reasoning: cached.choices?.[0]?.message?.reasoning_content || '', conversationId: cached.conversation_id, promptTokens: 0, completionTokens: 0 };
    }
  }

  let conversationId = sakanaReq.conversationId;
  let lastMessageId = ctxEntry?.lastMessageId || '';

  // Auto-context lookup — same first-user-message key as saveContext.
  if (!conversationId && !body.__forceNewContext && !body.__ignoreExplicitContext) {
    const found = (als.getStore() && als.getStore().ctxEntry) || (firstUserText(body) ? lookupContext(firstUserText(body)) : null);
    if (found) {
      conversationId = found.conversationId;
      lastMessageId = found.lastMessageId || '';
      if (!lastMessageId) {
        try { lastMessageId = await upstream.getLastMessageId(conversationId, signal); } catch { conversationId = null; }
      }
    }
  }

  if (!conversationId) {
    const boot = await upstream.createConversation({
      toneMode: sakanaReq.toneMode,
      enableThinking: sakanaReq.enableThinking,
      webSearchEnabled: sakanaReq.webSearchEnabled,
      model: sakanaReq.sakanaModel,
        signal,
      });
    conversationId = boot.conversationId;
    stats.convCreated();
    lastMessageId = boot.systemMessageId;
  } else if (!lastMessageId) {
    lastMessageId = await upstream.getLastMessageId(conversationId, signal);
  }

  // Smart routing round 1 (code/writer profiles) — same as the chat path.
  let chainCitations = [];
  if (sakanaReq.route?.chainSearch && !sakanaReq.isToolTurn && !sakanaReq.isContinue) {
    try {
      const chain = await runSearchChainRound(conversationId, sakanaReq, { lastMessageId, signal });
      if (chain.note) {
        sakanaReq.prompt = chain.note + '\n\n' + sakanaReq.prompt;
        chainCitations = chain.citations;
        try { lastMessageId = await upstream.getLastMessageId(conversationId, signal); } catch {}
      }
    } catch (e) {
      console.log(`[search-chain] round-1 failed, falling back to single round: ${stableErrorCode(e, 500)}`);
    }
  }

  // Optical second-stage compression (writer profile, very long docs).
  try {
    await maybeApplyOpticalCompression(sakanaReq, signal);
  } catch (e) {
    console.log(`[optical] render failed, keeping single-document pipeline: ${stableErrorCode(e, 500)}`);
  }

  const upResp = await upstream.streamGenerate(conversationId, sakanaReq, { lastMessageId, signal });
  let t = new NdjsonTranslator({ declaredTools: sakanaReq.clientToolNames });

  if (streaming) {
    // Return SSE chunk generator, mirroring chat path but as async iterable.
    const base = { id: t.assistantMessageId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelName };
    return (async function* () {
      let streamError = null;
      let streamErrCode = null;
      try {
        for await (const ev of drainRoundToSSE(upResp, t, base, signal)) yield ev;
        // Native tool round with no text: continue transparently.
        let rounds = 0;
        while (!t.sentContent && !t.clientToolRound && rounds < toolRoundsFor(sakanaReq)) {
          rounds++;
          const contT = new NdjsonTranslator({ declaredTools: sakanaReq.clientToolNames });
          const leaf = await upstream.getLastMessageId(conversationId, signal);
          lastMessageId = leaf;
          const contReq = { ...sakanaReq, isContinue: true, prompt: undefined, files: [] };
          const contResp = await upstream.streamGenerate(conversationId, contReq, { lastMessageId: leaf, signal });
          for await (const ev of drainRoundToSSE(contResp, contT, base, signal)) yield ev;
          if (!contT.sentContent) { t.nativeToolRound = contT.nativeToolRound; continue; }
          contT.citations = mergeCitations(t.citations, contT.citations);
          t = contT;
        }
        if (!t.sentContent) {
          streamError = 'empty response';
          const fb = { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: 'empty upstream response', code: 'EMPTY-RESPONSE' } };
          yield { event: 'chat.completion.chunk', data: fb };
        }
        t.citations = mergeCitations(chainCitations, t.citations);
        for (const c of t.finish()) {
          const data = { ...base, choices: c.choices };
          if (c.usage) data.usage = c.usage;
          if (c.citations && c.citations.length) data.citations = c.citations;
          yield { event: 'chat.completion.chunk', data };
        }
      } catch (e) {
        const safe = sanitizeError(e, 500);
      streamError = safe.message;
      streamErrCode = safe.code;
      const fb = { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: streamError, code: streamErrCode } };
        yield { event: 'chat.completion.chunk', data: fb };
      }
      stats.finish({ stream: true, ok: !streamError, model: modelName, promptChars, completionChars: 0, keyId: null });
      const finalLeaf = await finalizeContext(body, normalized, conversationId, lastMessageId, request, contextSnapshot, signal);
      auditEntry(request, body, streamError ? 500 : 200, null, streamError, Date.now() - start, { stream: true });
    })();
  }

  // non-stream: accumulate
  const first = await drainUpstreamRound(upResp, new NdjsonTranslator({ declaredTools: sakanaReq.clientToolNames }), undefined, signal);
  let text = first.content;
  let reasoning = first.reasoning;
  let finalT = first.t;
  // Transparent native-tool continuation (same rule as chat path).
  let rounds = 0;
  while (!text && !finalT.clientToolRound && rounds < toolRoundsFor(sakanaReq)) {
    rounds++;
    try {
      const cont = await continueNativeToolRound(conversationId, sakanaReq, signal);
      text += cont.content;
      reasoning += cont.reasoning;
          finalT = cont.t;
          lastMessageId = cont.leaf || lastMessageId;
    } catch (e) { console.log(`[tool-continue] (responses) continue round failed: ${stableErrorCode(e, 500)}`); break; }
  }
  text = stripChips(text).trim();
  // Empty upstream output even after continuation: return an error instead
  // of 200 OK with no content (user reported "no reply with no error").
  if (!text) {
    stats.finish({ stream: false, ok: false, error: 'empty upstream response', model: modelName, promptChars, completionChars: 0, keyId: null });
      const finalLeaf = await finalizeContext(body, normalized, conversationId, lastMessageId, request, contextSnapshot, signal);
      auditEntry(request, body, 200, null, { code: 'EMPTY-RESPONSE' }, Date.now() - start, { stream: false });
    return { content: '', reasoning, conversationId, promptTokens: 0, completionTokens: 0, error: 'empty upstream response' };
  }
  const promptTokens = Math.round(promptChars / 4);
  const completionTokens = Math.round((text.length + reasoning.length) / 4);
  stats.finish({ stream: false, ok: true, model: modelName, promptChars, completionChars: text.length, keyId: null });
  const finalLeaf = await finalizeContext(body, normalized, conversationId, lastMessageId, request, contextSnapshot, signal);
  auditEntry(request, body, 200, null, null, Date.now() - start, { stream: false });
  // 客户端工具调用(JSON 提取,原生沙盒调用已被抑制)随聚合返回,供
  // Anthropic 端点组装 tool_use 块
  const toolCalls = first.toolCalls;
  return { content: text, reasoning, conversationId, promptTokens, completionTokens, toolCalls, finishReason: toolCalls.length && !text ? 'tool_calls' : 'stop' };
}

const server = http.createServer(async (req, res) => {
  const lifecycle = beginRequestLifecycle(req, res);
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (runtimeClosed) {
      return sendJson(res, 503, { error: { message: 'server is shutting down', type: 'shutdown', code: 'SERVER-SHUTDOWN' } });
    }

    // public endpoints
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(UI_HTML_PATH, 'utf8'));
    }
    if (req.method === 'GET' && p === '/health') {
      return sendJson(res, 200, { ok: true, uptimeSec: Math.floor(process.uptime()), memory: memorySnapshot() });
    }

    // Character card avatars are public PNGs: <img> tags cannot send
    // authorization headers, so let them through the auth gate (the upstream
    // secrets live in the chat endpoints, not in a thumbnail).
    if (req.method === 'GET' && /^\/api\/characters\/[^/]+\/avatar$/.test(p)) {
      const id = decodeURIComponent(p.slice('/api/characters/'.length, -'/avatar'.length));
      const card = loadCard(CARD_DIR, id);
      if (!card || !card.avatarPath || !fs.existsSync(card.avatarPath)) return sendJson(res, 404, { error: { message: 'avatar not found' } });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(card.avatarPath));
    }

    if (!auth(req)) return sendJson(res, 401, { error: { message: 'missing/invalid proxy api key', type: 'authentication_error' } });

    if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
      return sendJson(res, 200, { object: 'list', data: MODELS });
    }
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/v1/chat/completion' || p === '/chat/completions')) {
      return await handleChatCompletions(req, res);
    }
    // Legacy completions: {model, prompt, max_tokens, stream, temperature}
    if (req.method === 'POST' && (p === '/v1/completions' || p === '/completions')) {
      return await handleLegacyCompletions(req, res);
    }
    // Responses API (simplified): {model, input, stream, instructions, tools}
    if (req.method === 'POST' && (p === '/v1/responses' || p === '/responses')) {
      return await handleResponses(req, res);
    }
    // Anthropic-style /v1/messages (basic mapping)
    if (req.method === 'POST' && (p === '/v1/messages' || p === '/messages')) {
      return await handleAnthropicMessages(req, res);
    }

    // ---- Gemini 兼容端点(SillyTavern / RisuAI 等 RP 客户端直连) ----
    // GET /v1beta/models — Gemini 模型列表
    if (req.method === 'GET' && /^(?:\/gemini)?\/(?:v1beta|v1)\/models\/?$/.test(p)) {
      return sendJson(res, 200, geminiModelList());
    }
    // GET /v1beta/models/{model} — 单模型详情(部分客户端启动时校验模型)
    if (req.method === 'GET') {
      const single = /^(?:\/gemini)?\/(?:v1beta|v1)\/models\/([^/]+)\/?$/.exec(p);
      if (single) {
        const detail = geminiModelDetail(decodeURIComponent(single[1]));
        if (!detail) return sendJson(res, 404, geminiErrorBody(404, 'model not found: ' + single[1]));
        return sendJson(res, 200, detail);
      }
    }
    // POST /v1beta/models/{model}:generateContent | :streamGenerateContent
    if (req.method === 'POST') {
      const groute = parseGeminiRoute(p);
      if (groute) return await handleGeminiGenerate(req, res, groute, url);
    }
    if (req.method === 'GET' && p === '/v1/conversations') {
      let lease = null;
      let ok = false;
      try {
        const session = AUTO_SESSION
          ? (lease = accountPool.lease('', { owner: 'conversation-list' }))?.account
          : await getSession().catch(() => null);
        if (!session) return sendJson(res, 503, { error: { message: 'conversation account unavailable', type: 'upstream_error', code: 'AUTH-LOGIN-001' } });
        const list = await als.run({ session, lease, ctxEntry: null, signal: req.__signal, request: req }, () =>
          upstream.listConversations(url.searchParams.get('p') || 0, req.__signal)
        );
        ok = true;
        return sendJson(res, 200, list);
      } catch (e) {
        const safe = sanitizeError(e, 500);
        return sendJson(res, clientErrorStatus(e, 500), { error: { message: safe.message, type: safe.category, code: safe.code } });
      } finally {
        if (lease) accountPool.releaseLease(lease, ok, { error: ok ? '' : 'conversation list failed' });
      }
    }
    if (req.method === 'GET' && p.startsWith('/v1/conversations/') && p.endsWith('/messages')) {
      const id = decodeURIComponent(p.slice('/v1/conversations/'.length, -'/messages'.length));
      let lease = null;
      let ok = false;
      try {
        const ctxEntry = contextStore.getByConversationId(id);
        let session;
        if (AUTO_SESSION) {
          if (!ctxEntry?.accountId) {
            return sendJson(res, 409, { error: { message: 'conversation account affinity unavailable', type: 'conflict', code: 'CONTEXT-AFFINITY-MISSING' } });
          }
          const acct = accountPool.get(ctxEntry.accountId);
          lease = acct ? accountPool.leaseAccount(acct.id, '', { owner: 'conversation:' + id }) : null;
          session = lease?.account || null;
        } else {
          session = await getSession().catch(() => null);
        }
        if (!session) return sendJson(res, 404, { error: { message: 'conversation account unavailable', type: 'not_found', code: 'CONTEXT-AFFINITY-MISSING' } });
        const conv = await als.run({ session, lease, ctxEntry, signal: req.__signal, request: req }, () => upstream.getConversation(id, req.__signal));
        ok = true;
        return sendJson(res, 200, conv);
      } catch (e) {
        const safe = sanitizeError(e, 500);
        return sendJson(res, clientErrorStatus(e, 500), { error: { message: safe.message, type: safe.category, code: safe.code } });
      } finally {
        if (lease) accountPool.releaseLease(lease, ok, { error: ok ? '' : 'conversation read failed' });
      }
    }
    // Stop an in-flight generation (used by the chat panel's stop button).
    // Route to the account that owns the conversation via the context store.
    if (req.method === 'POST' && p.startsWith('/v1/conversations/') && p.endsWith('/stop')) {
      const id = decodeURIComponent(p.slice('/v1/conversations/'.length, -'/stop'.length));
      let lease = null;
      let ok = false;
      let stopError = null;
      try {
        const ctxEntry = contextStore.getByConversationId(id);
        let session;
        if (AUTO_SESSION) {
          if (!ctxEntry?.accountId) {
            return sendJson(res, 404, { error: { message: 'conversation account unavailable', type: 'not_found', code: 'CONTEXT-AFFINITY-MISSING' } });
          }
          const acct = accountPool.get(ctxEntry.accountId);
          lease = acct ? accountPool.leaseAccount(acct.id, '', { owner: 'stop:' + id }) : null;
          session = lease?.account || null;
        } else {
          session = await getSession().catch(() => null);
        }
        if (!session) return sendJson(res, 404, { error: { message: 'conversation account unavailable', type: 'not_found' } });
        await als.run({ session, lease, ctxEntry, signal: req.__signal, request: req }, () => upstream.stopGeneration(id, req.__signal));
        ok = true;
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        stopError = e;
        const safe = sanitizeError(e, e?.status || 500);
        return sendJson(res, safe.status >= 500 ? 502 : safe.status, { ok: false, error: { message: safe.message, type: safe.category, code: safe.code } });
      } finally {
        if (lease) accountPool.releaseLease(lease, ok, { error: ok ? '' : stableErrorCode(stopError, 500) });
      }
    }

    // Management endpoints
    if (req.method === 'GET' && p === '/api/stats') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      let session = null;
      try { session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch {}
      const s = stats.snapshot(session);
      s.cache = cache.stats();
      const mem = process.memoryUsage();
      const pool = accountPool.snapshot();
      s.accounts = {
        total: pool.total,
        active: pool.active,
        limited: pool.limited,
        expired: pool.expired,
        max: pool.max,
        inFlight: pool.inFlight,
        stale: pool.stale,
        target: pool.target,
        targetMet: pool.targetMet,
        replenishing: pool.replenishing,
        refreshing: pool.refreshing,
        leaseCount: pool.leaseCount,
        oldestLeaseAgeMs: pool.oldestLeaseAgeMs,
        lastHarvestAt: pool.lastHarvestAt,
        lastHarvestErrorAt: pool.lastHarvestErrorAt,
        lastHarvestError: pool.lastHarvestError || null,
        telemetry: pool.telemetry,
      };
      s.auditCount = auditLog.length;
      s.ops = {
        concurrency: concurrencyManager.stats,
        contextCount: contextStore.size,
        uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
        mem: { rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), heapMaxMB: Math.round(mem.heapTotal / 1048576) },
        compact: { ...contextTelemetry },
        browser: autoSession.status(),
        node: process.version,
        authMode: (API_KEY || keyStore.keys.some(k => !k.revoked)) ? 'keyed' : 'open',
      };
      return sendJson(res, 200, s);
    }
    if (p === '/api/keys') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      if (req.method === 'GET') {
        const active = keyStore.keys.filter((k) => !k.revoked).length;
        return sendJson(res, 200, { keys: keyStore.list(), keyed: active > 0, open: !API_KEY && active === 0 });
      }
      if (req.method === 'POST') {
        let b;
        try { b = JSON.parse((await readBody(req)).toString('utf8')); }
        catch (e) {
          if (req.__signal?.aborted) throw e;
          return sendJson(res, 400, { error: { message: 'invalid JSON' } });
        }
        return sendJson(res, 200, keyStore.create(b.name));
      }
      return sendJson(res, 405, { error: { message: 'method not allowed' } });
    }
    const keyDel = /^\/api\/keys\/([^/]+)\/(revoke|delete)$/.exec(p);
    if (req.method === 'POST' && keyDel) {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      const ok = keyDel[2] === 'revoke' ? keyStore.revoke(decodeURIComponent(keyDel[1])) : keyStore.remove(decodeURIComponent(keyDel[1]));
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: { message: 'key not found' } });
    }

    // Audit log endpoints
    if (req.method === 'GET' && (p === '/api/audit' || p === '/api/export-audit.csv')) {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      if (p === '/api/export-audit.csv' || url.searchParams.get('format') === 'csv') {
        const headers = ['id', 'ts', 'time_iso', 'method', 'path', 'model', 'status', 'duration_ms', 'error_code', 'error_category', 'stream', 'cache', 'request_bytes', 'response_bytes', 'context', 'request_headers', 'response_headers'];
        const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const csvRows = [headers.join(',')];
        for (const e of auditLog) {
          const row = [
            e.id,
            e.ts,
            new Date(e.ts).toISOString(),
            e.method,
            e.path,
            e.model,
            e.status,
            e.duration,
            e.errorCode,
            e.errorCategory,
            e.stream,
            e.cache,
            e.requestBytes,
            e.responseBytes,
            JSON.stringify(e.context || {}),
            JSON.stringify(e.requestHeaders || {}),
            JSON.stringify(e.responseHeaders || {}),
          ].map(csvEscape);
          csvRows.push(row.join(','));
        }
        const csvStr = '\uFEFF' + csvRows.join('\r\n');
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="sakana-audit-${Date.now()}.csv"`,
          'content-length': Buffer.byteLength(csvStr),
        });
        return res.end(csvStr);
      }
      return sendJson(res, 200, { entries: auditLog.slice(0, 150) });
    }

    if (req.method === 'POST' && p === '/api/audit/clear') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      auditLog.length = 0;
      return sendJson(res, 200, { ok: true });
    }

    // Accounts endpoint — ADMIN-only. Returns SAFE fields only: session cookies
// and firebase tokens must never leave the server (any API-key holder could
// otherwise steal and hijack the whole pool).
    if (req.method === 'GET' && p === '/api/accounts') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      accountPool._checkCooldowns();
      const safe = accountPool.accounts.map(a => accountPool.safeAccount(a));
      const pool = accountPool.snapshot();
      return sendJson(res, 200, {
        accounts: safe,
        total: pool.total,
        active: pool.active,
        target: pool.target,
        max: pool.max,
        lastHarvestAt: pool.lastHarvestAt,
        lastHarvestError: pool.lastHarvestError || null,
        lastHarvestErrorAt: pool.lastHarvestErrorAt,
        replenishing: pool.replenishing,
        refreshing: pool.refreshing,
        telemetry: pool.telemetry,
        persistenceError: pool.persistenceError || null,
      });
    }

    if (req.method === 'POST' && p === '/api/accounts/refresh') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      try {
        if (AUTO_SESSION) {
          accountPool.ensureMinPool((signal) => autoSession.harvestFresh({ signal }))
            .then((ok) => console.log(`[accounts] manual refresh harvested ${ok} accounts`))
            .catch((e) => console.log(`[accounts] manual refresh error: ${stableErrorCode(e, 500)}`));
        }
        return sendJson(res, 200, { ok: true, message: 'refresh + replenish triggered' });
      } catch (e) {
        const safe = sanitizeError(e, 500);
        return sendJson(res, clientErrorStatus(e, 500), { error: { message: safe.message, type: safe.category, code: safe.code } });
      }
    }

    // 2026-10: upstream blocks disposable-email registration (AUTH-EMAIL-001 /
    // USER_DISABLED), so automated harvest cannot create accounts anymore.
    // Admins seed the pool by importing a session cookie from a browser where
    // they signed in to chat.sakana.ai manually.
    if (req.method === 'POST' && p === '/api/accounts/import') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      let b;
      try { b = JSON.parse((await readBody(req)).toString('utf8')); }
      catch (e) {
        if (req.__signal?.aborted) throw e;
        return sendJson(res, 400, { error: { message: 'invalid JSON' } });
      }
      let cookieHeader = String(b?.cookieHeader || '').trim();
      if (!cookieHeader && Array.isArray(b?.cookies)) {
        cookieHeader = b.cookies
          .filter((c) => c && c.name && c.value)
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');
      }
      if (!/(?:^|;\s*)sakana-chat=[^;]+/.test(cookieHeader)) {
        return sendJson(res, 400, { error: { message: 'cookieHeader must contain a sakana-chat cookie', code: 'INVALID-SESSION' } });
      }
      const probe = await probeSession(cookieHeader).catch(() => ({ ok: false, status: 0 }));
      if (!probe.ok) {
        return sendJson(res, 400, {
          error: {
            message: `session cookie rejected by upstream (status ${probe.status}) — sign in at chat.sakana.ai and copy a fresh sakana-chat cookie`,
            code: 'SESSION-REJECTED',
          },
        });
      }
      const id = accountPool.upsert({
        cookieHeader,
        // refreshAccount needs structured cookies; synthesize them for a
        // header-only import so the session can be refreshed later.
        cookies: Array.isArray(b?.cookies) && b.cookies.length
          ? b.cookies
          : cookieHeader.split(/;\s*/).filter(Boolean).map((pair) => {
              const eq = pair.indexOf('=');
              return {
                name: pair.slice(0, eq),
                value: pair.slice(eq + 1),
                domain: 'chat.sakana.ai',
                path: '/',
              };
            }),
        savedAt: Date.now(),
        loggedIn: true,
        uid: String(b?.uid || ''),
        email: String(b?.email || ''),
      });
      if (!id) {
        return sendJson(res, 409, { error: { message: 'session already in pool or pool entry quarantined', code: 'DUPLICATE-SESSION' } });
      }
      console.log(`[accounts] imported session cookie via admin (pool size ${accountPool.count()})`);
      return sendJson(res, 200, { ok: true, id, poolSize: accountPool.count() });
    }

    // Cache endpoints
    if (req.method === 'POST' && p === '/api/cache/clear') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      cache.clear();
      return sendJson(res, 200, { ok: true, stats: cache.stats() });
    }

    // Character card management
    if (p.startsWith('/api/characters')) {
      // The avatar is served publicly before the auth gate (see above).
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      // POST /api/characters/upload — upload a PNG character card
      if (req.method === 'POST' && p === '/api/characters/upload') {
        try {
          const raw = await readBody(req);
          const parsed = parsePngCard(raw);
          const card = normalizeCard(parsed.json, parsed.spec);
          const record = saveCard(CARD_DIR, card, parsed.png);
          console.log('[character-card] uploaded:', record.name);
          return sendJson(res, 200, { id: record.id, name: record.name, description: (record.description || '').slice(0, 100) });
        } catch (e) {
          if (req.__signal?.aborted) throw e;
          const safe = sanitizeError(e, 400);
          return sendJson(res, 400, { error: { message: safe.message, type: 'invalid_character_card', code: safe.code } });
        }
      }
      // GET /api/characters — list all cards
      if (req.method === 'GET' && p === '/api/characters') {
        const cards = listCards(CARD_DIR);
        return sendJson(res, 200, { characters: cards, active: activeCharacter ? { id: activeCharacter.id, name: activeCharacter.name } : null });
      }
      // GET /api/characters/active — get active character info
      if (req.method === 'GET' && p === '/api/characters/active') {
        return sendJson(res, 200, { character: activeCharacter ? { id: activeCharacter.id, name: activeCharacter.name } : null });
      }
      // POST /api/characters/deactivate — clear active character
      if (req.method === 'POST' && p === '/api/characters/deactivate') {
        activeCharacter = null;
        return sendJson(res, 200, { ok: true });
      }
      // POST /api/characters/:id/activate — set a specific card as active
      if (req.method === 'POST' && p.endsWith('/activate') && p.length > 22) {
        const id = decodeURIComponent(p.slice('/api/characters/'.length, -'/activate'.length));
        const card = loadCard(CARD_DIR, id);
        if (!card) return sendJson(res, 404, { error: { message: 'character not found' } });
        activeCharacter = card;
        return sendJson(res, 200, { ok: true, id: card.id, name: card.name });
      }
      return sendJson(res, 404, { error: { message: 'not found: ' + p, type: 'invalid_request_error' } });
    }

    return sendJson(res, 404, { error: { message: 'not found: ' + p, type: 'invalid_request_error' } });
  } catch (e) {
    if (res.headersSent) {
      try { res.end(); } catch {}
    } else if (req.__signal?.aborted) {
      const code = abortCode(req.__signal.reason, 'REQUEST-ABORTED');
      const status = code === 'SERVER-SHUTDOWN' ? 503 : (code === 'REQUEST-TIMEOUT' ? 504 : 499);
      const safe = sanitizeError({ code }, status);
      sendJson(res, status, { error: { message: safe.message, type: safe.category, code: safe.code } });
    } else if (runtimeClosed) {
      sendJson(res, 503, { error: { message: 'server is shutting down', type: 'shutdown', code: 'SERVER-SHUTDOWN' } });
    } else {
      const safe = sanitizeError(e, e?.status || 500);
      const status = clientErrorStatus(e, e?.status || 500);
      sendJson(res, status, { error: { message: safe.message, type: safe.category, code: safe.code } });
    }
  } finally {
    finalizeAuditEntry(req, res);
    lifecycle.cleanup();
  }
});

server.maxConnections = 2000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 300000;

let runtimeClosed = false;
let shutdownPromise = null;

function abortActiveRequests(reason = 'server is shutting down') {
  const error = Object.assign(new Error(reason), { code: 'SERVER-SHUTDOWN' });
  for (const controller of [...activeRequests]) {
    try { controller.abort(error); } catch {}
  }
}

async function closeRuntime() {
  if (runtimeClosed) return;
  runtimeClosed = true;
  abortActiveRequests();
  concurrencyManager.close();
  // Invalidate browser/mail work synchronously before waiting for pool drains;
  // pool callbacks can otherwise keep the browser alive past the shutdown SLA.
  const autoStop = autoSession.stop?.();
  const poolStop = accountPool.stopBackground?.();
  const shutdownDeadline = new Promise(resolve => {
    const timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
    timer.unref?.();
  });
  await Promise.race([
    Promise.allSettled([autoStop, poolStop]),
    shutdownDeadline,
  ]);
  contextStore.close?.();
  cache.close?.();
  await Promise.race([closeGlobalDispatcher(), shutdownDeadline]);
  setReloadHandler(null);
}

async function shutdown(reason = 'shutdown') {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    // Stop accepting new connections before tearing down shared resources.
    const closePromise = server.listening
      ? new Promise((resolve) => server.close(() => resolve()))
      : Promise.resolve();
    const drainTimer = setTimeout(() => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }, SHUTDOWN_DRAIN_MS);
    drainTimer.unref?.();
    await closeRuntime();
    await Promise.race([
      closePromise,
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS)),
    ]);
    clearTimeout(drainTimer);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  })();
  return shutdownPromise;
}

server.on('close', () => { closeRuntime().catch(() => {}); });
process.once('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0), () => process.exit(1)));
process.once('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0), () => process.exit(1)));

server.listen(PORT, HOST, async () => {
  if (runtimeClosed) return;
  console.log(`sakana-2api listening on http://${HOST}:${PORT}`);
  console.log(`models: ${MODELS.length}`);

  if (AUTO_SESSION) {
    setReloadHandler(() => autoSession.refreshSessionLocked());
    console.log('[startup] AUTO_SESSION enabled — auto-bypassing CF 5s shield…');
    try {
      const s = await autoSession.start({ managedByPool: true });
      if (runtimeClosed) return;
      console.log(`[startup] Session ready: ${s.cookieHeader ? s.cookieHeader.split(';').length + ' cookies' : 'no cookies'}`);
      if (s) accountPool.upsert(s);
      console.log(`[account-pool] pool: ${accountPool.count()} accounts (${accountPool.activeCount()} active)`);
    } catch (e) {
      if (runtimeClosed || abortCode(e, '') === 'SERVER-SHUTDOWN') return;
      console.log(`[startup] Auto-session failed: ${safeErrorDetail(e)}. Falling back to session.json.`);
      loadSession();
    }
    if (runtimeClosed) return;
    // Background keeper MUST run regardless of the bootstrap outcome: it
    // refreshes cookies and replenishes the pool to minPool with fresh
    // accounts. Only autoSession functions are gated by AUTO_SESSION.
    await accountPool.startBackground({
          harvestFn: (signal) => autoSession.harvestFresh({ signal }),
          refreshFn: (acct, signal) => autoSession.refreshAccount(acct, { signal }),
    });
    console.log(`[account-pool] background keeper started (refresh every ${String(process.env.ACCOUNT_REFRESH_MS || '1200000')}ms, replenish every ${String(process.env.ACCOUNT_REPLENISH_MS || '90000')}ms, target ${accountPool.minPool})`);
    // Kick off an immediate replenish instead of waiting a full cycle.
    accountPool.ensureMinPool((signal) => autoSession.harvestFresh({ signal }))
      .catch(e => console.log('[startup] pool replenish:', stableErrorCode(e, 500)));
  } else {
    setReloadHandler(null);
    const s = loadSession();
    console.log(`session: ${s.cookieHeader ? 'loaded (' + s.cookieHeader.split(';').length + ' cookies)' : 'NOT LOADED — run scripts/harvest.mjs'}`);
  }
});