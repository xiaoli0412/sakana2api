// sakana-2api — OpenAI-compatible reverse proxy for chat.sakana.ai web chat.
// Run: node server.js   (PORT=8787 SAKANA_SESSION_FILE=session.json)

const http = require('http');
const { randomUUID } = require('crypto');
const { MODELS, openaiRequestToSakana, NdjsonTranslator, sse, clean, stripChips } = require('./lib/translate');
const { SakanaUpstream, UpstreamError } = require('./lib/upstream');
const { getSession, loadSession } = require('./lib/session');
const { autoSession } = require('./lib/auto-session');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.API_KEY || ''; // optional bearer gate for the proxy itself
const AUTO_SESSION = process.env.AUTO_SESSION !== 'false'; // auto-bypass CF

const upstream = new SakanaUpstream(getSession);

function auth(req) {
  if (!API_KEY) return true;
  const h = req.headers.authorization || '';
  return h === 'Bearer ' + API_KEY || h === 'Bearer ' + API_KEY.trim();
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

    let conversationId = sakanaReq.conversationId;
    let lastMessageId = '';
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
      return sendJson(res, 200, {
        id: 'chatcmpl-' + randomUUID().replace(/-/g, ''),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'sakana-namazu',
        conversation_id: conversationId || undefined,
        choices: [{ index: 0, message: { role: 'assistant', content: text || null, reasoning_content: reasoning || null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // streaming — expose the conversation id in a header so clients can continue
    res.setHeader('x-conversation-id', conversationId || '');
    sseHeaders(res);
    const t = new NdjsonTranslator();
    const modelName = body.model || 'sakana-namazu';
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
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    if (e instanceof UpstreamError) {
      sendJson(res, e.status >= 500 ? 502 : e.status, {
        error: { message: `upstream ${e.errorCode || e.status}: ${e.message}`, type: 'upstream_error', code: e.errorCode },
      });
    } else {
      sendJson(res, 500, { error: { message: String(e.message || e), type: 'internal_error' } });
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!auth(req)) return sendJson(res, 401, { error: { message: 'missing/invalid proxy api key', type: 'authentication_error' } });

    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

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
    if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });
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