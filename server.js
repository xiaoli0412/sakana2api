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

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.API_KEY || ''; // optional static admin key
const AUTO_SESSION = process.env.AUTO_SESSION !== 'false'; // auto-bypass CF

const stats = new Stats();
const keyStore = new KeyStore();

// Conversation context continuity: when a client sends multiple messages
// without an explicit conversation_id, we try to match the last user input
// to a recent conversation so the model remembers context.
const CONTEXT_TTL = 24 * 60 * 60 * 1000; // 24h
const contextMap = new Map(); // lastUserMsgHash -> { conversationId, ts }
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
  // evict old entries
  if (contextMap.size > 200) {
    const old = [...contextMap.entries()].filter(([, e]) => Date.now() - e.ts > CONTEXT_TTL);
    for (const [k] of old) contextMap.delete(k);
  }
}

// built-in web UI (management panel; read per-request so edits apply live)
const UI_HTML_PATH = path.join(__dirname, 'public', 'index.html');

const upstream = new SakanaUpstream(getSession);

// Auth: open when nothing is enforced. Enforced when API_KEY is set OR at
// least one ACTIVE managed key exists (revoked keys do not lock the proxy).
function auth(req) {
  const activeKeys = keyStore.keys.filter((k) => !k.revoked).length;
  if (!API_KEY && activeKeys === 0) return true;
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (API_KEY && tok === API_KEY) return true;
  const key = keyStore.validate(tok);
  if (key) {
    req.keyId = key.id;
    req.keyName = key.name;
    return true;
  }
  return false;
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

/** main: POST /v1/chat/completions */
async function handleChatCompletions(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { return sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } }); }

  try {
    const sakanaReq = openaiRequestToSakana(body);
    const streaming = body.stream !== false; // default stream true for reliability
    const modelName = body.model || 'sakana-namazu';
    stats.begin(modelName);
    const promptChars = (sakanaReq.prompt || '').length + (sakanaReq.files || []).length * 200;

    // Extract text-based files (txt, md, csv, json, etc.) into the prompt.
    // Images are left for the upstream multimodal model.
    if (sakanaReq.files && sakanaReq.files.length > 0) {
      const textParts = [];
      const remaining = [];
      for (const f of sakanaReq.files) {
        const ext = extractFileContent(f);
        if (ext === null) {
          // image — keep for upstream
          remaining.push(f);
        } else if (ext.text) {
          textParts.push(ext.text);
        }
        // else: unknown binary, skip
      }
      sakanaReq.files = remaining;
      if (textParts.length) {
        sakanaReq.prompt = (sakanaReq.prompt || '') + '\n\n--- 文件内容 ---\n' + textParts.join('\n');
      }
    }

    let conversationId = sakanaReq.conversationId;
    let lastMessageId = '';

    // Try to auto-continue conversation context when client doesn't send conversation_id
    if (!conversationId) {
      // Find the second-to-last user message (previous context) for hash lookup
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      let prevUserMsg = '';
      let userCount = 0;
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
        // When files are present, don't send inputs in bootstrap (verified: inputs=undefined
        // in bootstrap + files in stream = 200; inputs in bootstrap + files in stream = 500).
        inputs: (sakanaReq.files && sakanaReq.files.length > 0) ? undefined : sakanaReq.prompt,
      });
      conversationId = boot.conversationId;
      stats.convCreated();
      // stream turn `id` must reference an existing message (system message from bootstrap).
      // NOTE: do NOT GET the conversation between bootstrap and stream — it changes
      // server-side state and breaks the turn (verified experimentally).
      lastMessageId = boot.systemMessageId;
    } else {
      lastMessageId = await upstream.getLastMessageId(conversationId);
    }

    const upResp = await upstream.streamGenerate(conversationId, sakanaReq, { lastMessageId });
    const reader = upResp.body.getReader();
    const decoder = new TextDecoder();

    if (!streaming) {
      // accumulate full text then respond JSON (OpenAI non-stream shape)
      let text = '';
      let reasoning = '';
      const t = new NdjsonTranslator();
      let prev = ''; // LCP anchor for finalAnswer — mirror NdjsonTranslator dedup
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
            // authoritative full text; emit only the delta beyond what streamed
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
      // strip <source-chip> markup from the non-streaming answer (streaming
      // path already strips it via NdjsonTranslator)
      text = stripChips(text);
      text = text.trim();
      stats.finish({ stream: false, ok: true, model: modelName, promptChars, completionChars: text.length, keyId: req.keyId });
      saveContext(sakanaReq.prompt, conversationId);
      return sendJson(res, 200, {
        id: 'chatcmpl-' + randomUUID().replace(/-/g, ''),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        conversation_id: conversationId || undefined,
        choices: [{ index: 0, message: { role: 'assistant', content: text || null, reasoning_content: reasoning || null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: Math.round(promptChars / 4), completion_tokens: Math.round((text.length + reasoning.length) / 4), total_tokens: 0 },
      });
    }

    // streaming — expose the conversation id in a header so clients can continue
    res.setHeader('x-conversation-id', conversationId || '');
    sseHeaders(res);
    const t = new NdjsonTranslator();
    let streamedChars = 0;
    const base = { id: t.assistantMessageId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelName };
    let buf = '';
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
      // flush remaining
      if (buf.trim()) {
        for (const c of t.line(buf)) res.write(sse('chat.completion.chunk', { ...base, choices: c.choices }));
      }
      for (const c of t.finish()) res.write(sse('chat.completion.chunk', { ...base, choices: c.choices }));
    } catch (e) {
      const fb = { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      res.write(sse('chat.completion.chunk', fb));
    }
    res.write('data: [DONE]\n\n');
    res.end();
    stats.finish({ stream: true, ok: true, model: modelName, promptChars, completionChars: streamedChars, keyId: req.keyId });
    saveContext(sakanaReq.prompt, conversationId);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    stats.finish({ stream: false, ok: false, error: String(e.message || e), model: body.model || 'sakana-namazu', keyId: req.keyId });
    if (e instanceof UpstreamError) {
      sendJson(res, e.status >= 500 ? 502 : e.status, {
        error: { message: `upstream ${e.errorCode || e.status}: ${e.message}`, type: 'upstream_error', code: e.errorCode },
      });
    } else {
      sendJson(res, 500, { error: { message: String(e.message || e), type: 'internal_error' } });
    }
  }
}

// Admin for key management:
//  - nothing configured (no API_KEY, no active keys) -> open (localhost trust)
//  - API_KEY set in env -> must present exactly that Bearer token
//  - otherwise -> any valid active managed key counts (panel is the owner)
function isAdmin(req) {
  const activeKeys = keyStore.keys.filter((k) => !k.revoked).length;
  if (!API_KEY && activeKeys === 0) return true;
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (API_KEY) return tok === API_KEY;
  if (tok) return !!keyStore.validate(tok);
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // public endpoints — no auth (UI + health probes)
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(UI_HTML_PATH, 'utf8'));
    }
    if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });

    if (!auth(req)) return sendJson(res, 401, { error: { message: 'missing/invalid proxy api key', type: 'authentication_error' } });
    if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
      return sendJson(res, 200, { object: 'list', data: MODELS });
    }

    // ---- management endpoints ----
    // stats: any authenticated key (or open when nothing configured)
    if (req.method === 'GET' && p === '/api/stats') {
      let session = null;
      try { session = JSON.parse(fs.readFileSync(path.join(__dirname, 'session.json'), 'utf8')); } catch {}
      return sendJson(res, 200, stats.snapshot(session));
    }
    // keys mgmt: admin-gated (see isAdmin)
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
    } catch (e) {
      console.log(`[startup] Auto-session failed: ${e.message}. Falling back to session.json.`);
      loadSession();
    }
  } else {
    const s = loadSession();
    console.log(`session: ${s.cookieHeader ? 'loaded (' + s.cookieHeader.split(';').length + ' cookies)' : 'NOT LOADED — run scripts/harvest.mjs'}`);
  }
});