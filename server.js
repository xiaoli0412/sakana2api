// sakana-2api — OpenAI-compatible reverse proxy for chat.sakana.ai web chat.
// Run: node server.js   (PORT=8787 SAKANA_SESSION_FILE=session.json)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { MODELS, openaiRequestToSakana, NdjsonTranslator, sse, clean, stripChips, extractFileContent } = require('./lib/translate');
const { SakanaUpstream, UpstreamError } = require('./lib/upstream');
const { getSession, loadSession } = require('./lib/session');
const { autoSession } = require('./lib/auto-session');
const { Stats, KeyStore } = require('./lib/stats');
const { AccountPool } = require('./lib/account-pool');
const { Cache } = require('./lib/cache');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || '';
const AUTO_SESSION = process.env.AUTO_SESSION !== 'false';
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';

const stats = new Stats();
const keyStore = new KeyStore();
const accountPool = new AccountPool();
const cache = new Cache();

const upstream = new SakanaUpstream(() => {
  // Try account pool first, fall back to session.json
  const acct = accountPool.next();
  if (acct) return acct;
  return getSession();
});

// built-in web UI (read per-request so edits apply live)
const UI_HTML_PATH = path.join(__dirname, 'public', 'index.html');

// ---- request/response audit log (in-memory ring buffer) ----
const AUDIT_MAX = 500;
const auditLog = [];

function auditEntry(req, body, status, response, error, duration) {
  const entry = {
    id: randomUUID().slice(0, 8),
    ts: Date.now(),
    method: req.method,
    path: req.url,
    model: body?.model || '',
    status,
    duration,
    error: error || null,
    reqBody: JSON.stringify(body).slice(0, 2000),
    resBody: JSON.stringify(response).slice(0, 2000),
  };
  auditLog.unshift(entry);
  if (auditLog.length > AUDIT_MAX) auditLog.length = AUDIT_MAX;
  return entry;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
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

// Auth: open when nothing enforced
function auth(req) {
  const activeKeys = keyStore.keys.filter((k) => !k.revoked).length;
  if (!API_KEY && activeKeys === 0) return true;
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (API_KEY && tok === API_KEY) return true;
  const key = keyStore.validate(tok);
  if (key) { req.keyId = key.id; req.keyName = key.name; return true; }
  return false;
}

function isAdmin(req) {
  const activeKeys = keyStore.keys.filter((k) => !k.revoked).length;
  if (!API_KEY && activeKeys === 0) return true;
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (API_KEY) return tok === API_KEY;
  if (tok) return !!keyStore.validate(tok);
  return false;
}

// Conversation context continuity
const CONTEXT_TTL = 24 * 60 * 60 * 1000;
const contextMap = new Map();
function hash(s) { return require('crypto').createHash('md5').update(s).digest('hex'); }
function lookupContext(prevMsg) {
  if (!prevMsg) return null;
  const h = hash(prevMsg);
  const entry = contextMap.get(h);
  if (entry && Date.now() - entry.ts < CONTEXT_TTL) return entry.conversationId;
  if (entry) contextMap.delete(h);
  return null;
}
function saveContext(lastMsg, conversationId) {
  if (!lastMsg) return;
  const h = hash(lastMsg);
  contextMap.set(h, { conversationId, ts: Date.now() });
  if (contextMap.size > 200) {
    const old = [...contextMap.entries()].filter(([, e]) => Date.now() - e.ts > CONTEXT_TTL);
    for (const [k] of old) contextMap.delete(k);
  }
}

/** main: POST /v1/chat/completions */
async function handleChatCompletions(req, res) {
  const start = Date.now();
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { const e = sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } }); return; }

  try {
    const sakanaReq = openaiRequestToSakana(body);
    const streaming = body.stream !== false;
    const modelName = body.model || 'sakana-namazu';
    stats.begin(modelName);
    let promptChars = (sakanaReq.prompt || '').length + (sakanaReq.files || []).length * 200;

    // Extract text-based files
    if (sakanaReq.files && sakanaReq.files.length > 0) {
      const textParts = [];
      const remaining = [];
      for (const f of sakanaReq.files) {
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
    const cacheKey = CACHE_ENABLED ? cache.key(body) : null;
    if (cacheKey && !streaming) {
      const cached = cache.get(cacheKey);
      if (cached) {
        stats.finish({ stream: false, ok: true, model: modelName, promptChars, completionChars: (cached.text || '').length, keyId: req.keyId });
        const entry = auditEntry(req, body, 200, cached, null, Date.now() - start);
        return sendJson(res, 200, cached);
      }
    }

    let conversationId = sakanaReq.conversationId;
    let lastMessageId = '';

    // Auto-context lookup
    if (!conversationId) {
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      let prevUserMsg = '';
      if (msgs.length > 1) {
        for (let i = msgs.length - 2; i >= 0; i--) {
          if (msgs[i] && msgs[i].role === 'user') {
            const c = msgs[i].content;
            prevUserMsg = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => p.text || '').join(' ') : '');
            break;
          }
        }
      }
      const found = prevUserMsg ? lookupContext(prevUserMsg) : null;
      if (found) {
        conversationId = found;
        try { lastMessageId = await upstream.getLastMessageId(conversationId); } catch { conversationId = null; }
      }
    }

    if (!conversationId) {
      const boot = await upstream.createConversation({
        toneMode: sakanaReq.toneMode,
        enableThinking: sakanaReq.enableThinking,
        webSearchEnabled: sakanaReq.webSearchEnabled,
        model: sakanaReq.sakanaModel,
        inputs: (sakanaReq.files && sakanaReq.files.length > 0) ? undefined : sakanaReq.prompt,
      });
      conversationId = boot.conversationId;
      stats.convCreated();
      lastMessageId = boot.systemMessageId;
    } else {
      lastMessageId = await upstream.getLastMessageId(conversationId);
    }

    const upResp = await upstream.streamGenerate(conversationId, sakanaReq, { lastMessageId });
    const reader = upResp.body.getReader();
    const decoder = new TextDecoder();

    if (!streaming) {
      let text = '';
      let reasoning = '';
      const t = new NdjsonTranslator();
      let prev = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const s = decoder.decode(value, { stream: true });
        for (const line of s.split('\n')) {
          if (!line.trim()) continue;
          let obj; try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type === 'reasoning') reasoning += clean(obj.token);
          else if (obj.type === 'stream') {
            const tok = clean(obj.token);
            if (!tok) continue;
            prev += tok;
            text = prev;
          } else if (obj.type === 'finalAnswer') {
            const full = clean(obj.text);
            if (!full) continue;
            const len = Math.min(prev.length, full.length);
            let i = 0;
            while (i < len && prev[i] === full[i]) i++;
            text = prev + full.slice(i);
            prev = text;
          }
        }
      }
      text = stripChips(text).trim();
      const response = {
        id: 'chatcmpl-' + randomUUID().replace(/-/g, ''),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        conversation_id: conversationId || undefined,
        choices: [{ index: 0, message: { role: 'assistant', content: text || null, reasoning_content: reasoning || null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: Math.round(promptChars / 4), completion_tokens: Math.round((text.length + reasoning.length) / 4), total_tokens: 0 },
      };
      stats.finish({ stream: false, ok: true, model: modelName, promptChars, completionChars: text.length, keyId: req.keyId });
      saveContext(sakanaReq.prompt, conversationId);
      if (cacheKey) cache.set(cacheKey, response);
      const entry = auditEntry(req, body, 200, response, null, Date.now() - start);
      return sendJson(res, 200, response);
    }

    // streaming
    res.setHeader('x-conversation-id', conversationId || '');
    sseHeaders(res);
    const t = new NdjsonTranslator();
    let streamedChars = 0;
    const base = { id: t.assistantMessageId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelName };
    let buf = '';
    let streamError = null;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          for (const c of t.line(line)) {
            const d = c.choices[0] && c.choices[0].delta;
            if (d && d.content) streamedChars += d.content.length;
            res.write(sse('chat.completion.chunk', { ...base, choices: c.choices }));
          }
        }
      }
      if (buf.trim()) {
        for (const c of t.line(buf)) res.write(sse('chat.completion.chunk', { ...base, choices: c.choices }));
      }
      for (const c of t.finish()) res.write(sse('chat.completion.chunk', { ...base, choices: c.choices }));
    } catch (e) {
      streamError = e.message;
      const fb = { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      res.write(sse('chat.completion.chunk', fb));
    }
    res.write('data: [DONE]\n\n');
    res.end();
    stats.finish({ stream: true, ok: !streamError, model: modelName, promptChars, completionChars: streamedChars, keyId: req.keyId });
    saveContext(sakanaReq.prompt, conversationId);
    auditEntry(req, body, streamError ? 500 : 200, null, streamError, Date.now() - start);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    // Detect rate-limit from upstream errors and rotate account
    if (e instanceof UpstreamError) {
      if (e.errorCode === 'AUTH-LOGIN-001' || e.errorCode === 'RATE-LIMIT-001') {
        // Rotate account
      }
      const errResp = { error: { message: `upstream ${e.errorCode || e.status}: ${e.message}`, type: 'upstream_error', code: e.errorCode } };
      stats.finish({ stream: false, ok: false, error: String(e.message || e), model: body.model || 'sakana-namazu', keyId: req.keyId });
      auditEntry(req, body, e.status >= 500 ? 502 : e.status, null, e.message, Date.now() - start);
      sendJson(res, e.status >= 500 ? 502 : e.status, errResp);
    } else {
      stats.finish({ stream: false, ok: false, error: String(e.message || e), model: body.model || 'sakana-namazu', keyId: req.keyId });
      auditEntry(req, body, 500, null, e.message, Date.now() - start);
      sendJson(res, 500, { error: { message: String(e.message || e), type: 'internal_error' } });
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // public endpoints
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(UI_HTML_PATH, 'utf8'));
    }
    if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });

    if (!auth(req)) return sendJson(res, 401, { error: { message: 'missing/invalid proxy api key', type: 'authentication_error' } });

    if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
      return sendJson(res, 200, { object: 'list', data: MODELS });
    }
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/v1/chat/completion')) {
      return await handleChatCompletions(req, res);
    }
    if (req.method === 'GET' && p === '/v1/conversations') {
      try {
        const list = await upstream.listConversations(url.searchParams.get('p') || 0);
        return sendJson(res, 200, list);
      } catch (e) { return sendJson(res, 500, { error: { message: String(e.message) } }); }
    }
    if (req.method === 'GET' && p.startsWith('/v1/conversations/') && p.endsWith('/messages')) {
      const id = decodeURIComponent(p.slice('/v1/conversations/'.length, -'/messages'.length));
      try {
        const conv = await upstream.getConversation(id);
        return sendJson(res, 200, conv);
      } catch (e) { return sendJson(res, 500, { error: { message: String(e.message) } }); }
    }

    // Management endpoints
    if (req.method === 'GET' && p === '/api/stats') {
      let session = null;
      try { session = JSON.parse(fs.readFileSync(path.join(__dirname, 'session.json'), 'utf8')); } catch {}
      const s = stats.snapshot(session);
      s.cache = cache.stats();
      s.accounts = { total: accountPool.count(), active: accountPool.activeCount(), max: 10 };
      s.auditCount = auditLog.length;
      return sendJson(res, 200, s);
    }
    if (p === '/api/keys') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      if (req.method === 'GET') {
        const active = keyStore.keys.filter((k) => !k.revoked).length;
        return sendJson(res, 200, { keys: keyStore.list(), keyed: active > 0, open: !API_KEY && active === 0 });
      }
      if (req.method === 'POST') {
        let b; try { b = JSON.parse((await readBody(req)).toString('utf8')); } catch { return sendJson(res, 400, { error: { message: 'invalid JSON' } }); }
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

    // Audit log endpoint
    if (req.method === 'GET' && p === '/api/audit') {
      return sendJson(res, 200, { entries: auditLog.slice(0, 100) });
    }

    // Accounts endpoint
    if (req.method === 'GET' && p === '/api/accounts') {
      return sendJson(res, 200, { accounts: accountPool.accounts, total: accountPool.count(), active: accountPool.activeCount() });
    }

    return sendJson(res, 404, { error: { message: 'not found: ' + p, type: 'invalid_request_error' } });
  } catch (e) {
    sendJson(res, 500, { error: { message: String(e.message || e), type: 'internal_error' } });
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`sakana-2api listening on http://${HOST}:${PORT}`);
  console.log(`models: ${MODELS.length}`);

  if (AUTO_SESSION) {
    console.log('[startup] AUTO_SESSION enabled — auto-bypassing CF 5s shield…');
    try {
      const s = await autoSession.start();
      console.log(`[startup] Session ready: ${s.cookieHeader ? s.cookieHeader.split(';').length + ' cookies' : 'no cookies'}`);
      // Add to account pool
      if (s) accountPool.add(s);
      // Ensure minimum pool
      accountPool.ensureMinPool(async () => {
        const s = await autoSession.harvestSession();
        return s;
      }).catch(e => console.log('[startup] pool replenish:', e.message));
    } catch (e) {
      console.log(`[startup] Auto-session failed: ${e.message}. Falling back to session.json.`);
      loadSession();
    }
  } else {
    const s = loadSession();
    console.log(`session: ${s.cookieHeader ? 'loaded (' + s.cookieHeader.split(';').length + ' cookies)' : 'NOT LOADED — run scripts/harvest.mjs'}`);
  }
});