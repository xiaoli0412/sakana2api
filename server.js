// sakana-2api — OpenAI-compatible reverse proxy for chat.sakana.ai web chat.
// Run: node server.js   (PORT=8787 SAKANA_SESSION_FILE=session.json)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { MODELS, openaiRequestToSakana, NdjsonTranslator, sse, clean, stripChips, extractFileContent } = require('./lib/translate');
const { SakanaUpstream, UpstreamError } = require('./lib/upstream');
const { getSession, loadSession } = require('./lib/session');
const { autoSession } = require('./lib/auto-session');
const { Stats, KeyStore } = require('./lib/stats');
const { AccountPool } = require('./lib/account-pool');
const { Cache } = require('./lib/cache');

// Bind ONE account to the whole request: createConversation + streamGenerate
// must use the same session or the upstream 404s with CONV-NOTFOUND-001.
const als = new AsyncLocalStorage();

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
  // One account per request (AsyncLocalStorage): createConversation and
  // streamGenerate must share the same session, else CONV-NOTFOUND-001.
  const bound = als.getStore();
  if (bound && bound.session) return bound.session;
  // Fallback for non-request contexts (bootstrap keep-alive etc.)
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

/** Mark the session that served the failing request (rate-limit/expiry). */
function markCurrentSession(err) {
  const sess = upstream.lastSession;
  if (!sess) return;
  if (err && (err.errorCode === 'AUTH-LOGIN-001' || err.errorCode === 'RATE-LIMIT-001')) {
    if (sess.id) accountPool.markRateLimited(sess.id);
    else accountPool.markRateLimited(sess.id);
  }
  if (err && (err.errorCode === 'CF-403' || err.errorCode === 'AUTH-TOKEN-001')) {
    if (sess.id) accountPool.markExpired(sess.id);
  }
}

// Conversation context continuity (auto-continue: no need to pass conversation_id)
const CONTEXT_TTL = 24 * 60 * 60 * 1000;
const contextMap = new Map();
function hash(s) { return require('crypto').createHash('md5').update(s).digest('hex'); }
function lookupContext(prevMsg) {
  if (!prevMsg) return null;
  const h = hash(prevMsg);
  const entry = contextMap.get(h);
  if (entry && Date.now() - entry.ts < CONTEXT_TTL) return entry;
  if (entry) contextMap.delete(h);
  return null;
}
function saveContext(lastMsg, conversationId, lastMessageId) {
  if (!lastMsg) return;
  const h = hash(lastMsg);
  const bound = als.getStore();
  const prev = contextMap.get(h);
  contextMap.set(h, {
    conversationId,
    accountId: (bound && bound.session && bound.session.id) || (prev && prev.accountId) || '',
    lastMessageId: lastMessageId || (prev && prev.lastMessageId) || '',
    ts: Date.now(),
  });
  if (contextMap.size > 200) {
    const old = [...contextMap.entries()].filter(([, e]) => Date.now() - e.ts > CONTEXT_TTL);
    for (const [k] of old) contextMap.delete(k);
  }
}

// Raw text of the FIRST user message in the request — the stable context key.
// A multi-turn client sends the full history each time, so the first user
// message identifies the conversation. (NOT the translated prompt: after
// tool-hint injection sakanaReq.prompt no longer equals the client's user
// text, which broke auto-continuation.)
function lastUserText(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => p && (p.text || p.content || '')).join(' ') : '');
  }
  return '';
}
function firstUserText(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => p && (p.text || p.content || '')).join(' ') : '');
  }
  return '';
}

/** main: POST /v1/chat/completions */
async function handleChatCompletions(req, res) {
  const start = Date.now();
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { const e = sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } }); return; }

  const RETRYABLE = /CONV-NOTFOUND-001|RATE-LIMIT-001|AUTH-LOGIN-001|CF-403|UPSTREAM-TIMEOUT/;
  for (let attempt = 0; ; attempt++) {
    // A continuation (auto-context) MUST reuse the account that owns the
    // conversation, or upstream 404s (CONV-NOTFOUND-001).
    let boundAccount = null;
    const prevText = firstUserText(body);
    const ctxEntry = prevText ? lookupContext(prevText) : null;
    if (ctxEntry && ctxEntry.accountId) {
      boundAccount = accountPool.get(ctxEntry.accountId) || null;
    }
    if (!boundAccount) {
      const acct = accountPool.next();
      boundAccount = acct || await getSession().catch(() => null);
    }
    try {
      return await als.run({ session: boundAccount, ctxEntry }, () => handleChatInner(req, res, body, start, ctxEntry));
    } catch (e) {
      const code = (e && (e.errorCode || e.code)) || '';
      if (attempt === 0 && !res.headersSent && (!code || RETRYABLE.test(String(code) + ' ' + String(e.message)))) {
        // Rotate the account and retry once (account pool分流/容错).
        if (boundAccount && boundAccount.id) accountPool.markRateLimited(boundAccount.id);
        console.log(`[chat] retrying with fresh account (${code || e.message})`);
        continue;
      }
      throw e;
    }
  }
}

/** inner handler (runs with request-bound session via AsyncLocalStorage) */
async function handleChatInner(req, res, body, start, ctxEntry) {

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

    // Auto-context lookup (client continues without passing conversation_id).
    // ctxEntry was resolved before account binding; reuse it to keep the same
    // account that owns the conversation (CONV-NOTFOUND-001 otherwise).
    if (!conversationId && ctxEntry) {
      conversationId = ctxEntry.conversationId;
      lastMessageId = ctxEntry.lastMessageId || '';
      if (!lastMessageId) {
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
      saveContext(firstUserText(body) || lastUserText(body) || sakanaReq.prompt, conversationId, lastMessageId);
      if (cacheKey) cache.set(cacheKey, response);
      res.setHeader('x-conversation-id', conversationId || '');
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
    let streamErrCode = null;
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
      // Empty upstream output = silent failure (user typed, nothing came back).
      if (!t.sentContent && !streamError) {
        streamError = 'upstream returned empty response (no content)';
        streamErrCode = 'EMPTY-RESPONSE';
      }
      if (!streamError) {
        for (const c of t.finish()) res.write(sse('chat.completion.chunk', { ...base, choices: c.choices }));
      }
    } catch (e) {
      streamError = e.message || String(e);
      streamErrCode = e.errorCode || 'STREAM-ERROR';
    }
    if (streamError) {
      const fb = { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: streamError, type: 'upstream_error', code: streamErrCode } };
      try { res.write(sse('chat.completion.chunk', fb)); } catch {}
    }
    try {
      res.write('data: [DONE]\n\n');
      res.end();
    } catch {}
    const ok = !streamError;
    stats.finish({ stream: true, ok, model: modelName, promptChars, completionChars: streamedChars, keyId: req.keyId });
    saveContext(firstUserText(body) || lastUserText(body) || sakanaReq.prompt, conversationId, lastMessageId);
    auditEntry(req, body, ok ? 200 : 500, null, streamError, Date.now() - start);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    // Detect rate-limit / session-dead errors and rotate the account
    if (e instanceof UpstreamError) {
      markCurrentSession(e);
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

/** Legacy OpenAI completions: {model, prompt, max_tokens, stream, temperature} */
async function handleLegacyCompletions(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
    if (body.prompt === undefined && body.input === undefined) throw new Error('missing prompt');
  } catch (e) {
    return sendJson(res, 400, { error: { message: 'invalid JSON or missing prompt: ' + e.message, type: 'invalid_request_error' } });
  }
  // Normalize into chat.completions and translate back to legacy output.
  const chatBody = {
    ...body,
    messages: [{ role: 'user', content: Array.isArray(body.prompt) ? body.prompt.map(String).join('\n') : String(body.prompt ?? body.input) }],
  };
  delete chatBody.prompt;
  delete chatBody.completion;
  const stream = body.stream === true;
  const reader = await makeChatResponse(chatBody);
  if (stream) {
    sseHeaders(res);
    for await (const c of reader) res.write(sse(c.event || 'chat.completion.chunk', c.data));
    return res.end('data: [DONE]\n\n');
  }
  return sendJson(res, 200, {
    id: 'cmpl-' + randomUUID().replace(/-/g, ''),
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: chatBody.model || 'sakana-namazu',
    choices: [{ index: 0, text: reader.content || '', finish_reason: 'stop' }],
    usage: { prompt_tokens: reader.promptTokens || 0, completion_tokens: reader.completionTokens || 0, total_tokens: (reader.promptTokens || 0) + (reader.completionTokens || 0) },
  });
}

/** Responses API (simplified): {model, input, instructions, stream, tools} */
async function handleResponses(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8')); }
  catch { return sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } }); }
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
  const reader = await makeChatResponse(chatBody);
  if (stream) {
    // Emit OpenAI response-format chunks (response.output_text.delta) for compat.
    sseHeaders(res);
    for await (const c of reader) {
      if (c.event === 'chat.completion.chunk') {
        const d = c.data?.choices?.[0]?.delta?.content;
        if (d) res.write(sse('response.output_text.delta', { type: 'response.output_text.delta', delta: d, item_id: 'msg_' + randomUUID().slice(0, 6) }));
        if (c.data?.choices?.[0]?.finish_reason) res.write(sse('response.completed', { type: 'response.completed', response: { id: 'resp_' + randomUUID().slice(0, 6), status: 'completed', output: [] } }));
      }
    }
    return res.end('data: [DONE]\n\n');
  }
  const text = reader.content || '';
  return sendJson(res, 200, {
    id: 'resp_' + randomUUID().replace(/-/g, '').slice(0, 12),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: chatBody.model || 'sakana-namazu',
    output: [{ id: 'msg_' + randomUUID().slice(0, 8), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: reader.promptTokens || 0, output_tokens: reader.completionTokens || 0, total_tokens: (reader.promptTokens || 0) + (reader.completionTokens || 0) },
    conversation_id: reader.conversationId || undefined,
  });
}

/** Anthropic Messages API (basic): {model, system, messages, max_tokens, stream} */
async function handleAnthropicMessages(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8')); }
  catch { return sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } }); }
  const chatBody = {
    ...body,
    messages: [
      ...(body.system ? [{ role: 'system', content: Array.isArray(body.system) ? body.system.map(s => s.text || s).join('\n') : String(body.system) }] : []),
      ...(Array.isArray(body.messages) ? body.messages : [{ role: 'user', content: String(body.messages ?? '') }]),
    ],
  };
  delete chatBody.system;
  const stream = body.stream === true;
  const reader = await makeChatResponse(chatBody);
  if (stream) {
    sseHeaders(res);
    for await (const c of reader) {
      if (c.event === 'chat.completion.chunk') {
        const d = c.data?.choices?.[0]?.delta?.content;
        if (d) res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } })}\n\n`);
        if (c.data?.choices?.[0]?.finish_reason) {
          res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        }
      }
    }
    return res.end('data: [DONE]\n\n');
  }
  return sendJson(res, 200, {
    id: 'msg_' + randomUUID().replace(/-/g, '').slice(0, 12),
    type: 'message',
    role: 'assistant',
    model: chatBody.model || 'sakana-namazu',
    content: reader.content ? [{ type: 'text', text: reader.content }] : [],
    stop_reason: 'end_turn',
    usage: { input_tokens: reader.promptTokens || 0, output_tokens: reader.completionTokens || 0 },
  });
}

/**
 * Run chat/completions and return { content, reasoning, conversationId,
 * promptTokens, completionTokens } or an AsyncGenerator of SSE chunks when stream.
 */
async function makeChatResponse(chatBody) {
  // bind one account to the whole multi-call flow; retry once on account-level errors
  const RETRYABLE = /CONV-NOTFOUND-001|RATE-LIMIT-001|AUTH-LOGIN-001|CF-403|UPSTREAM-TIMEOUT/;
  // Also pin the account for auto-context continuations (same rule as chat handler).
  const ctxEntry = firstUserText(chatBody) ? lookupContext(firstUserText(chatBody)) : null;
  for (let attempt = 0; ; attempt++) {
    let bound = null;
    if (ctxEntry && ctxEntry.accountId) bound = accountPool.get(ctxEntry.accountId);
    if (!bound) bound = await accountPool.next() || await getSession().catch(() => null);
    try {
      return await als.run({ session: bound, ctxEntry }, () => makeChatResponseInner(chatBody));
    } catch (e) {
      const code = (e && (e.errorCode || e.code)) || '';
      if (attempt === 0 && (!code || RETRYABLE.test(String(code) + ' ' + String(e.message)))) {
        if (bound && bound.id) accountPool.markRateLimited(bound.id);
        console.log('[makeChatResponse] retrying with fresh account (' + (code || e.message) + ')');
        continue;
      }
      throw e;
    }
  }
}

async function makeChatResponseInner(chatBody) {
  const start = Date.now();
  const raw = JSON.stringify(chatBody);
  let body;
  try { body = JSON.parse(raw); } catch { throw new Error('bad chat body'); }

  // auto-stream: for legacy/responses we must decide immediately, so force non-stream here
  // unless the caller wants raw SSE (handled below).
  const sakanaReq = openaiRequestToSakana(body);
  const modelName = body.model || 'sakana-namazu';
  const streaming = body.stream === true ? true : false;
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

  const cacheKey = CACHE_ENABLED ? cache.key(body) : null;
  if (cacheKey && !streaming) {
    const cached = cache.get(cacheKey);
    if (cached) {
      stats.finish({ stream: false, ok: true, model: modelName, promptChars, completionChars: (cached.text || '').length, keyId: null });
      return { content: cached.choices?.[0]?.message?.content || '', reasoning: cached.choices?.[0]?.message?.reasoning_content || '', conversationId: cached.conversation_id, promptTokens: 0, completionTokens: 0 };
    }
  }

  let conversationId = sakanaReq.conversationId;
  let lastMessageId = '';

  // Auto-context lookup — same first-user-message key as saveContext.
  if (!conversationId) {
    const found = (als.getStore() && als.getStore().ctxEntry) || (firstUserText(body) ? lookupContext(firstUserText(body)) : null);
    if (found) {
      conversationId = found.conversationId;
      lastMessageId = found.lastMessageId || '';
      if (!lastMessageId) {
        try { lastMessageId = await upstream.getLastMessageId(conversationId); } catch { conversationId = null; }
      }
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
  const t = new NdjsonTranslator();

  if (streaming) {
    // Return SSE chunk generator, mirroring chat path but as async iterable.
    const base = { id: t.assistantMessageId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelName };
    return (async function* () {
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
              yield { event: 'chat.completion.chunk', data: { ...base, choices: c.choices } };
            }
          }
        }
        if (buf.trim()) {
          for (const c of t.line(buf)) yield { event: 'chat.completion.chunk', data: { ...base, choices: c.choices } };
        }
        if (!t.sentContent) {
          streamError = 'empty response';
          const fb = { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: 'empty upstream response', code: 'EMPTY-RESPONSE' } };
          yield { event: 'chat.completion.chunk', data: fb };
        }
        for (const c of t.finish()) yield { event: 'chat.completion.chunk', data: { ...base, choices: c.choices } };
      } catch (e) {
        const fb = { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { message: String(e.message || e), code: 'STREAM-ERROR' } };
        yield { event: 'chat.completion.chunk', data: fb };
      }
      stats.finish({ stream: true, ok: !streamError, model: modelName, promptChars, completionChars: 0, keyId: null });
      saveContext(firstUserText(body) || lastUserText(body) || sakanaReq.prompt, conversationId, lastMessageId);
      auditEntry({ method: 'POST', url: '/v1/responses', headers: {} }, body, streamError ? 500 : 200, null, streamError, Date.now() - start);
    })();
  }

  // non-stream: accumulate
  let text = '';
  let reasoning = '';
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
        if (full.startsWith(text)) text = full;
        else {
          const len = Math.min(prev.length, full.length);
          let i = 0;
          while (i < len && prev[i] === full[i]) i++;
          text = prev + full.slice(i);
          prev = text;
        }
      }
    }
  }
  text = stripChips(text).trim();
  const promptTokens = Math.round(promptChars / 4);
  const completionTokens = Math.round((text.length + reasoning.length) / 4);
  stats.finish({ stream: false, ok: true, model: modelName, promptChars, completionChars: text.length, keyId: null });
  saveContext(firstUserText(body) || lastUserText(body) || sakanaReq.prompt, conversationId, lastMessageId);
  const entry = auditEntry({ method: 'POST', url: '/v1/responses', headers: {} }, body, 200, { content: text.slice(0, 200) }, null, Date.now() - start);
  return { content: text, reasoning, conversationId, promptTokens, completionTokens };
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
    if (res.headersSent) {
      try { res.end(); } catch {}
      return;
    }
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
      if (s) accountPool.add(s);
      console.log(`[account-pool] pool: ${accountPool.count()} accounts (${accountPool.activeCount()} active)`);
    } catch (e) {
      console.log(`[startup] Auto-session failed: ${e.message}. Falling back to session.json.`);
      loadSession();
    }
    // Background keeper MUST run regardless of the bootstrap outcome: it
    // refreshes cookies and replenishes the pool to MIN_POOL (10) with fresh
    // accounts. Only autoSession functions are gated by AUTO_SESSION.
    accountPool.startBackground({
      harvestFn: async () => autoSession.harvestSession({ fresh: true }),
      refreshFn: (acct) => autoSession.refreshAccount(acct),
    });
    console.log('[account-pool] background keeper started (every', String(process.env.ACCOUNT_REFRESH_MS || '20min'), ')');
    // Kick off an immediate replenish instead of waiting a full cycle.
    accountPool.ensureMinPool(async () => autoSession.harvestSession({ fresh: true }))
      .catch(e => console.log('[startup] pool replenish:', e.message));
  } else {
    const s = loadSession();
    console.log(`session: ${s.cookieHeader ? 'loaded (' + s.cookieHeader.split(';').length + ' cookies)' : 'NOT LOADED — run scripts/harvest.mjs'}`);
  }
});