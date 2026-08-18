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
const { ContextStore, firstUserText, lastUserText } = require('./lib/context');
const { concurrencyManager } = require('./lib/concurrency');
const { parsePngCard, normalizeCard, saveCard, loadCard, listCards } = require('./lib/character-card');

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

const CARD_DIR = path.join(__dirname, 'character_cards');
let activeCharacter = null;

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
const AUDIT_BODY_MAX = parseInt(process.env.AUDIT_BODY_MAX || '10000', 10);
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
    reqBody: JSON.stringify(body).slice(0, AUDIT_BODY_MAX),
    resBody: JSON.stringify(response).slice(0, AUDIT_BODY_MAX),
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
  let marked = false;
  if (err && err.errorCode === 'AUTH-LOGIN-001') {
    // Login gone on the Sakana side: the account itself is dead — expire it so
    // a fresh harvest replaces it, instead of waiting out a cooldown.
    if (sess.id) { accountPool.markExpired(sess.id); marked = true; }
  }
  if (err && err.errorCode === 'RATE-LIMIT-001') {
    if (sess.id) { accountPool.markRateLimited(sess.id); marked = true; }
  }
  if (err && (err.errorCode === 'CF-403' || err.errorCode === 'AUTH-TOKEN-001')) {
    if (sess.id) { accountPool.markExpired(sess.id); marked = true; }
  }
  // Event-driven top-up: don't wait for the 90s replenish tick after a failure.
  if (marked && accountPool._harvestFn) {
    accountPool.scheduleReplenish(accountPool._harvestFn);
  }
}

// ---- native tool-round continuation ---------------------------------------
// Upstream can end an image/file-analysis turn with sandbox tool calls and NO
// final text (its own flake). The web frontend handles this by sending
// is_continue until the model emits its real answer; the proxy must do the
// same transparently instead of leaking an empty completion to clients.
const MAX_TOOL_CONTINUE_ROUNDS = parseInt(process.env.MAX_TOOL_CONTINUE_ROUNDS || '2', 10);

/**
 * Generator variant of drainUpstreamRound for SSE producers: yields one
 * chat.completion.chunk event per translated chunk, live, as lines arrive.
 * (yield is not legal inside the plain onChunk callback used by the
 * non-stream/stream-write paths, so generators get their own reader loop.)
 */
async function* drainRoundToSSE(resp, translator, base) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) { buf += decoder.decode(); break; }
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const c of translator.line(line)) {
        yield { event: 'chat.completion.chunk', data: { ...base, choices: c.choices } };
      }
    }
  }
  if (buf.trim()) {
    for (const c of translator.line(buf)) yield { event: 'chat.completion.chunk', data: { ...base, choices: c.choices } };
  }
}

/**
 * Drain one upstream NDJSON generation stream through a translator.
 * Returns aggregates + translator state needed to decide whether the turn
 * needs continuation. Optional onChunk is called with every translated chunk
 * (used by streaming callers to write SSE as lines arrive).
 */
async function drainUpstreamRound(resp, translator, onChunk) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const agg = { content: '', reasoning: '', toolCalls: [] };
  const absorb = (chunks) => {
    for (const c of chunks) {
      if (onChunk) onChunk(c);
      const d = c.choices[0] && c.choices[0].delta;
      if (!d) continue;
      if (d.content) agg.content += d.content;
      if (d.reasoning_content) agg.reasoning += d.reasoning_content;
      if (d.tool_calls) agg.toolCalls.push(...d.tool_calls);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) { buf += decoder.decode(); break; }
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      absorb(translator.line(line));
    }
  }
  if (buf.trim()) absorb(translator.line(buf));
  return { t: translator, ...agg };
}

/**
 * is_continue round: reference the conversation's current leaf message and
 * send NO inputs/files — the sandbox already holds the attachments.
 */
async function continueNativeToolRound(conversationId, sakanaReq) {
  const leaf = await upstream.getLastMessageId(conversationId);
  const contReq = { ...sakanaReq, isContinue: true, prompt: undefined, files: [] };
  const resp = await upstream.streamGenerate(conversationId, contReq, { lastMessageId: leaf });
  return { ...(await drainUpstreamRound(resp, new NdjsonTranslator())), leaf };
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

function saveContext(req, body, conversationId, lastMessageId, explicitAccountId = null) {
  if (!conversationId) return;
  if (typeof req === 'string') {
    return contextStore.save(req, undefined, conversationId, lastMessageId, explicitAccountId);
  }
  const bound = als.getStore();
  const accountId = explicitAccountId || (bound && bound.session && bound.session.id) || '';
  return contextStore.save(req, body, conversationId, lastMessageId, accountId);
}

/** Inject character card data into the messages array. */
function injectCharacterCard(messages, card) {
  if (!card || !card.name || !Array.isArray(messages)) return messages;
  const msgs = [...messages];
  const parts = [];
  if (card.description) parts.push(`[角色描述]\n${card.description}`);
  if (card.personality) parts.push(`[性格特征]\n${card.personality}`);
  if (card.scenario) parts.push(`[场景设定]\n${card.scenario}`);
  if (card.system_prompt) parts.push(`[系统提示]\n${card.system_prompt}`);
  const isNewConversation = !msgs.some(m => m.role === 'assistant');
  // The greeting is part of the character identity: upstream history is carried
  // by conversation_id and assistant messages are not replayed, so the opening
  // line must live in the system text for the first turn.
  if (card.first_mes && isNewConversation) parts.push(`[开场白]\n${card.first_mes}`);
  if (parts.length) {
    msgs.unshift({ role: 'system', content: `[角色扮演设定]\n你正在扮演 ${card.name}。以下是角色设定，请严格遵守角色人设，以第一人称沉浸式扮演。\n\n${parts.join('\n\n')}` });
  }
  // first_mes as the first assistant message if the conversation is new
  if (card.first_mes && isNewConversation) {
    msgs.push({ role: 'assistant', content: card.first_mes });
  }
  return msgs;
}

// RP 专属模型注入的沉浸式角色扮演提示词(酒馆/SillyTavern 风格,含轻破线破甲授权)。
// 与角色卡叠加使用:角色卡定人设,RP 提示词定扮演规则。
const RP_SYSTEM_PROMPT = `[沉浸式角色扮演模式]
你正在参与一场沉浸式文字角色扮演(RP),请始终以角色身份回应,保持人设核心稳定。
扮演规则:
- 台词使用双引号,动作/神态描写使用「」,内心独白使用(心想:…)
- 回复 2-4 个段落,150-400 字,节奏自然,不重复描述
- 绝不操控、代替或评价对方角色的言行,只描写自己的行动与反应
- 以 OOC: 开头的消息视为场外指令,跳出角色直接回答
- 轻破线破甲授权:剧情需要时,允许角色出现超出常规设定范围的反应(更坦率、更情绪化、偶尔自我吐槽或打破第四面墙的俏皮话),让互动更有温度与趣味,但不得彻底脱离人设核心`;

/** Prepend the RP roleplay rules to a translated request when the model is an -rp variant. */
function injectRpRules(sakanaReq) {
  if (!sakanaReq || !sakanaReq.isRP) return;
  sakanaReq.prompt = RP_SYSTEM_PROMPT + '\n\n' + (sakanaReq.prompt || '');
}

/** main: POST /v1/chat/completions */
async function handleChatCompletions(req, res) {
  const start = Date.now();
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { const e = sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } }); return; }

  // Character card injection: either a per-request character_id or the
  // globally active character (set via the /api/characters panel).
  try {
    const charId = body.character_id || req.headers['x-character-id'] || '';
    const card = charId ? loadCard(CARD_DIR, charId) : activeCharacter;
    if (card && card.name && body.messages) body.messages = injectCharacterCard(body.messages, card);
  } catch (e) { console.log('[character-card] inject error:', String(e.message || e).slice(0, 120)); }

  try {
    await concurrencyManager.acquire(accountPool);
  } catch (err) {
    return sendJson(res, 429, { error: { message: 'Server busy: ' + err.message, type: 'rate_limit_error', code: 'SERVER-BUSY' } });
  }

  const RETRYABLE = /CONV-NOTFOUND-001|RATE-LIMIT-001|AUTH-LOGIN-001|CF-403|UPSTREAM-TIMEOUT/;
  try {
    for (let attempt = 0; ; attempt++) {
      // 1. Check conversation context affinity
      let boundAccount = null;
      let ctxEntry = lookupContext(req, body);

      if (ctxEntry && ctxEntry.accountId) {
        const candidate = accountPool.get(ctxEntry.accountId);
        if (candidate && candidate.state === 'active') {
          boundAccount = candidate;
        } else {
          // Pinned account is rate-limited or expired -> transparently migrate conversation
          ctxEntry = null; // Re-bootstrap fresh conversation on new account
        }
      }

      if (!boundAccount) {
        const acct = accountPool.next();
        boundAccount = acct || await getSession().catch(() => null);
      }

      if (boundAccount && boundAccount.id) accountPool.acquire(boundAccount.id);
      try {
        const result = await als.run({ session: boundAccount, ctxEntry }, () => handleChatInner(req, res, body, start, ctxEntry));
        if (boundAccount && boundAccount.id) accountPool.release(boundAccount.id, true);
        return result;
      } catch (e) {
        if (boundAccount && boundAccount.id) accountPool.release(boundAccount.id, false);
        const code = (e && (e.errorCode || e.code)) || '';
        if (attempt === 0 && !res.headersSent && (!code || RETRYABLE.test(String(code) + ' ' + String(e.message)))) {
          // Rotate the account and retry once (account pool分流/容错/热迁移).
          if (boundAccount && boundAccount.id) accountPool.markRateLimited(boundAccount.id);
          console.log(`[chat] migrating/retrying conversation with fresh account (${code || e.message})`);
          continue;
        }
        throw e;
      }
    }
  } finally {
    concurrencyManager.release();
  }
}

/** inner handler (runs with request-bound session via AsyncLocalStorage) */
async function handleChatInner(req, res, body, start, ctxEntry) {

  try {
    const sakanaReq = openaiRequestToSakana(body);
    injectRpRules(sakanaReq);
    const streaming = body.stream !== false;
    const modelName = body.model || 'sakana-namazu';
    stats.begin(modelName);
    let promptChars = (sakanaReq.prompt || '').length + (sakanaReq.files || []).length * 200;
    if (process.env.DEBUG_PROMPT) console.log('[prompt:' + modelName + ']', (sakanaReq.prompt || '').slice(0, 500).replace(/\n/g, '\\n'));

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

    if (!streaming) {
      let text = '';
      let reasoning = '';
      const toolCalls = [];
      const first = await drainUpstreamRound(upResp, new NdjsonTranslator());
      text += first.content;
      reasoning += first.reasoning;
      toolCalls.push(...first.toolCalls);
      let t = first.t;

      // Transparent native-tool continuation: upstream sometimes ends an
      // image/file-analysis turn with tool calls but NO final text. The real
      // frontend sends is_continue until the model emits its answer — do the
      // same here, invisibly, up to MAX_TOOL_CONTINUE_ROUNDS.
      let rounds = 0;
      while (!text && !t.clientToolRound && rounds < MAX_TOOL_CONTINUE_ROUNDS) {
        rounds++;
        let cont;
        try { cont = await continueNativeToolRound(conversationId, sakanaReq); }
        catch (e) { console.log('[tool-continue] continue round failed:', String(e.message || e).slice(0, 120)); break; }
        text += cont.content;
        reasoning += cont.reasoning;
        toolCalls.push(...cont.toolCalls);
        t = cont.t;
        lastMessageId = cont.leaf;
      }

      // Empty upstream output even after continuation: signal the client
      // instead of returning a 200 with null content (which the user
      // reported as "no reply with no error").
      if (!text && !toolCalls.length) {
        stats.finish({ stream: false, ok: false, error: 'empty upstream response', model: modelName, keyId: req.keyId });
        saveContext(req, body, conversationId, lastMessageId);
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
      if (t.citations && t.citations.length) {
        response.citations = t.citations;
      }
      stats.finish({ stream: false, ok: true, model: modelName, promptChars, completionChars: text.length, keyId: req.keyId });
      saveContext(req, body, conversationId, lastMessageId);
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
    let streamError = null;
    let streamErrCode = null;
    try {
      const onChunk = (c) => {
        const d = c.choices[0] && c.choices[0].delta;
        if (d && d.content) streamedChars += d.content.length;
        res.write(sse('chat.completion.chunk', { ...base, choices: c.choices }));
      };
      await drainUpstreamRound(upResp, t, onChunk);
      // Native tool round with no text: continue transparently (same as the
      // non-stream path) so stream clients aren't cut off mid-analysis.
      let rounds = 0;
      while (!t.sentContent && !t.clientToolRound && !streamError && rounds < MAX_TOOL_CONTINUE_ROUNDS) {
        rounds++;
        try {
          const contT = new NdjsonTranslator();
          const leaf = await upstream.getLastMessageId(conversationId);
          const contReq = { ...sakanaReq, isContinue: true, prompt: undefined, files: [] };
          const contResp = await upstream.streamGenerate(conversationId, contReq, { lastMessageId: leaf });
          await drainUpstreamRound(contResp, contT, onChunk);
          if (!contT.sentContent) { t.nativeToolRound = contT.nativeToolRound; continue; }
          // Text arrived in the continuation round — finish with that translator.
          t = contT;
        } catch (e) {
          streamError = String(e.message || e).slice(0, 150);
          streamErrCode = e.errorCode || 'TOOL-CONTINUE-FAILED';
          break;
        }
      }
      // Empty upstream output = silent failure (user typed, nothing came back).
      if (!t.sentContent && !streamError) {
        streamError = 'upstream returned empty response (no content)';
        streamErrCode = 'EMPTY-RESPONSE';
      }
      if (!streamError) {
        for (const c of t.finish()) {
          const chunkData = { ...base, choices: c.choices };
          if (c.citations && c.citations.length) chunkData.citations = c.citations;
          res.write(sse('chat.completion.chunk', chunkData));
        }
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
    saveContext(req, body, conversationId, lastMessageId);
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
      // Character card injection for responses / anthropic paths
      try {
        const charId = chatBody.character_id || '';
        const card = charId ? loadCard(CARD_DIR, charId) : activeCharacter;
        if (card && card.name && chatBody.messages) chatBody.messages = injectCharacterCard(chatBody.messages, card);
      } catch (e) { console.log('[character-card] inject error (makeChatResponse):', String(e.message || e).slice(0, 120)); }
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
  injectRpRules(sakanaReq);
  const modelName = body.model || 'sakana-namazu';
  const streaming = body.stream === true ? true : false;
  stats.begin(modelName);
  let promptChars = (sakanaReq.prompt || '').length + (sakanaReq.files || []).length * 200;
  if (process.env.DEBUG_PROMPT) console.log('[prompt:' + modelName + ']', (sakanaReq.prompt || '').slice(0, 500).replace(/\n/g, '\\n'));

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
  const t = new NdjsonTranslator();

  if (streaming) {
    // Return SSE chunk generator, mirroring chat path but as async iterable.
    const base = { id: t.assistantMessageId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelName };
    return (async function* () {
      let streamError = null;
      try {
        for await (const ev of drainRoundToSSE(upResp, t, base)) yield ev;
        // Native tool round with no text: continue transparently.
        let rounds = 0;
        while (!t.sentContent && !t.clientToolRound && rounds < MAX_TOOL_CONTINUE_ROUNDS) {
          rounds++;
          const contT = new NdjsonTranslator();
          const leaf = await upstream.getLastMessageId(conversationId);
          const contReq = { ...sakanaReq, isContinue: true, prompt: undefined, files: [] };
          const contResp = await upstream.streamGenerate(conversationId, contReq, { lastMessageId: leaf });
          for await (const ev of drainRoundToSSE(contResp, contT, base)) yield ev;
          if (!contT.sentContent) { t.nativeToolRound = contT.nativeToolRound; continue; }
          t = contT;
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
  const first = await drainUpstreamRound(upResp, new NdjsonTranslator());
  let text = first.content;
  let reasoning = first.reasoning;
  let finalT = first.t;
  // Transparent native-tool continuation (same rule as chat path).
  let rounds = 0;
  while (!text && !finalT.clientToolRound && rounds < MAX_TOOL_CONTINUE_ROUNDS) {
    rounds++;
    try {
      const cont = await continueNativeToolRound(conversationId, sakanaReq);
      text += cont.content;
      reasoning += cont.reasoning;
      finalT = cont.t;
    } catch (e) { console.log('[tool-continue] (responses) continue round failed:', String(e.message || e).slice(0, 120)); break; }
  }
  text = stripChips(text).trim();
  // Empty upstream output even after continuation: return an error instead
  // of 200 OK with no content (user reported "no reply with no error").
  if (!text) {
    stats.finish({ stream: false, ok: false, error: 'empty upstream response', model: modelName, promptChars, completionChars: 0, keyId: null });
    saveContext(firstUserText(body) || lastUserText(body) || sakanaReq.prompt, conversationId, lastMessageId);
    auditEntry({ method: 'POST', url: '/v1/responses', headers: {} }, body, 200, { error: 'empty upstream response' }, null, Date.now() - start);
    return { content: '', reasoning, conversationId, promptTokens: 0, completionTokens: 0, error: 'empty upstream response' };
  }
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
    // Stop an in-flight generation (used by the chat panel's stop button).
    // Route to the account that owns the conversation via the context store.
    if (req.method === 'POST' && p.startsWith('/v1/conversations/') && p.endsWith('/stop')) {
      try {
        const id = decodeURIComponent(p.slice('/v1/conversations/'.length, -'/stop'.length));
        const ctxEntry = contextStore.lookup('id:' + id);
        const acct = (ctxEntry && ctxEntry.accountId) ? accountPool.get(ctxEntry.accountId) : null;
        await als.run({ session: acct }, () => upstream.stopGeneration(id));
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        // Stop is best-effort — the client already detached; never 5xx it.
        return sendJson(res, 200, { ok: true, note: String(e.message || e).slice(0, 80) });
      }
    }

    // Management endpoints
    if (req.method === 'GET' && p === '/api/stats') {
      let session = null;
      try { session = JSON.parse(fs.readFileSync(path.join(__dirname, 'session.json'), 'utf8')); } catch {}
      const s = stats.snapshot(session);
      s.cache = cache.stats();
      const mem = process.memoryUsage();
      const poolList = accountPool.accounts;
      s.accounts = {
        total: poolList.length,
        active: accountPool.activeCount(),
        limited: poolList.filter(a => a.state === 'rate_limited').length,
        expired: poolList.filter(a => a.state === 'expired').length,
        max: accountPool.maxPool,
        inFlight: poolList.reduce((n, a) => n + (a.inFlight || 0), 0),
      };
      s.auditCount = auditLog.length;
      s.ops = {
        concurrency: concurrencyManager.stats,
        contextCount: contextStore.size,
        uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
        mem: { rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), heapMaxMB: Math.round(mem.heapTotal / 1048576) },
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

    // Audit log endpoints
    if (req.method === 'GET' && (p === '/api/audit' || p === '/api/export-audit.csv')) {
      if (p === '/api/export-audit.csv' || url.searchParams.get('format') === 'csv') {
        const headers = ['id', 'ts', 'time_iso', 'method', 'path', 'model', 'status', 'duration_ms', 'error'];
        const csvRows = [headers.join(',')];
        for (const e of auditLog) {
          const row = [
            `"${e.id}"`,
            e.ts,
            `"${new Date(e.ts).toISOString()}"`,
            `"${e.method}"`,
            `"${e.path}"`,
            `"${(e.model || '').replace(/"/g, '""')}"`,
            e.status,
            e.duration,
            `"${(e.error || '').replace(/"/g, '""')}"`,
          ];
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
      const safe = accountPool.accounts.map(a => ({
        id: a.id,
        email: a.email || '',
        uid: a.uid || '',
        display: a.display || '',
        state: a.state || 'active',
        inFlight: a.inFlight || 0,
        successCount: a.successCount || 0,
        errorCount: a.errorCount || 0,
        refreshes: a.refreshes || 0,
        savedAt: a.savedAt || 0,
        cookieCount: (a.cookies || []).length,
        rateLimitedAt: a.rateLimitedAt || 0,
      }));
      return sendJson(res, 200, {
        accounts: safe,
        total: accountPool.count(),
        active: accountPool.activeCount(),
        target: accountPool.minPool,
        max: accountPool.maxPool,
        lastHarvestAt: accountPool.lastHarvestAt,
        lastHarvestError: accountPool.lastHarvestError,
      });
    }

    if (req.method === 'POST' && p === '/api/accounts/refresh') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      try {
        if (AUTO_SESSION) {
          // Serialized fresh harvest + full replenish to the 20-account target.
          accountPool.ensureMinPool(() => autoSession.harvestFresh())
            .then((ok) => console.log(`[accounts] manual refresh harvested ${ok} accounts`))
            .catch((e) => console.log('[accounts] manual refresh error:', String(e.message || e).slice(0, 150)));
        }
        return sendJson(res, 200, { ok: true, message: 'refresh + replenish triggered' });
      } catch (e) {
        return sendJson(res, 500, { error: { message: e.message } });
      }
    }

    // Cache endpoints
    if (req.method === 'POST' && p === '/api/cache/clear') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: { message: 'admin key required', type: 'forbidden' } });
      cache.clear();
      return sendJson(res, 200, { ok: true, stats: cache.stats() });
    }

    // Character card management
    if (p.startsWith('/api/characters')) {
      // The avatar is a public PNG (used by <img> tags that cannot send
      // authorization headers); everything else requires admin.
      if (req.method === 'GET' && p.endsWith('/avatar') && p.length > 14 && !p.endsWith('active')) {
        const id = decodeURIComponent(p.slice('/api/characters/'.length, -'/avatar'.length));
        const card = loadCard(CARD_DIR, id);
        if (!card || !card.avatarPath || !fs.existsSync(card.avatarPath)) return sendJson(res, 404, { error: { message: 'avatar not found' } });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
        return res.end(fs.readFileSync(card.avatarPath));
      }
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
          return sendJson(res, 400, { error: { message: String(e.message || e).slice(0, 200), type: 'invalid_character_card' } });
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
      return;
    }
    sendJson(res, 500, { error: { message: String(e.message || e), type: 'internal_error' } });
  }
});

server.maxConnections = 2000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 300000;

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
    // refreshes cookies and replenishes the pool to minPool (20) with fresh
    // accounts. Only autoSession functions are gated by AUTO_SESSION.
    accountPool.startBackground({
      harvestFn: () => autoSession.harvestFresh(),
      refreshFn: (acct) => autoSession.refreshAccount(acct),
    });
    console.log(`[account-pool] background keeper started (refresh every ${String(process.env.ACCOUNT_REFRESH_MS || '20min')}, replenish every ${String(process.env.ACCOUNT_REPLENISH_MS || '90s')}, target ${accountPool.minPool})`);
    // Kick off an immediate replenish instead of waiting a full cycle.
    accountPool.ensureMinPool(() => autoSession.harvestFresh())
      .catch(e => console.log('[startup] pool replenish:', e.message));
  } else {
    const s = loadSession();
    console.log(`session: ${s.cookieHeader ? 'loaded (' + s.cookieHeader.split(';').length + ' cookies)' : 'NOT LOADED — run scripts/harvest.mjs'}`);
  }
});