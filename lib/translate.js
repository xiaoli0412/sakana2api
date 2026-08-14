// OpenAI <-> Sakana web chat protocol translation.
// Built from https://chat.sakana.ai protocol reverse-engineering (see protocol.md).

const { randomUUID } = require('crypto');

// ---- model / style mapping -------------------------------------------------

// Real upstream models exposed by the web chat (both free once logged in)
const UPSTREAM_MODELS = [
  { id: 'sakana-namazu', api: 'sakana-namazu', name: 'Namazu' },
  { id: 'sakana-fugu', api: 'fugu', name: 'Fugu' },
];

// style tokens accepted in a model id, mapped to the API toneMode.
// Sakana's API only accepts: default (Standard 🐟), jp-vibes (Polite 🐠), osaka (Osaka 🐙)
const STYLE_ALIASES = {
  default: 'default', standard: 'default', normal: 'default', '一般': 'default',
  polite: 'jp-vibes', 'ていねい': 'jp-vibes', '礼貌': 'jp-vibes',
  osaka: 'osaka', '大阪': 'osaka',
};

const STYLE_TOKENS = [
  { token: '', label: 'Standard 🐟', tone: 'default' },
  { token: 'standard', label: 'Standard 🐟', tone: 'default' },
  { token: 'polite', label: 'Polite 🐠', tone: 'jp-vibes' },
  { token: 'osaka', label: 'Osaka 🐙', tone: 'osaka' },
];

// mode tokens. The upstream rejects enableThinking=true + webSearchEnabled=true
// with INPUT-MODE-001, but enableThinking=false still produces reasoning
// (the model thinks automatically). So "default" = enableThinking:false +
// search:true (both thinking and search active), and "thinking-search" = the
// same mapping (also both active). Pure separate options are provided for
// explicit control.
const MODE_TOKENS = [
  { token: '', label: '思考+搜索', think: false, search: true },
  { token: 'thinking', label: '思考链', think: true, search: false },
  { token: 'search', label: 'Web搜索', think: false, search: true },
  { token: 'thinking-search', label: '思考+搜索', think: false, search: true },
];

// Full model matrix: 2 models × 4 styles × 4 modes = 32 ids,
// joined with `-` (e.g. sakana-namazu-osaka-thinking-search).
const MODELS = (() => {
  const out = [];
  for (const { id: base, api, name } of UPSTREAM_MODELS) {
    for (const { token: st, label, tone } of STYLE_TOKENS) {
      for (const { token: md, label: mdLabel, think, search } of MODE_TOKENS) {
        const parts = [base, st, md].filter(Boolean);
        const id = parts.join('-');
        const mdDisp = mdLabel || '';
        const desc = `${name} · ${label}${mdDisp ? ' · ' + mdDisp : ''}`;
        out.push({
          id, object: 'model', created: 0, owned_by: 'sakana',
          description: desc,
          apiModel: api, tone, thinking: think, search,
        });
      }
    }
  }
  return out;
})();

/**
 * Parse a model id (hyphen or legacy colon form) into upstream settings:
 *   { sakanaModel, toneMode, enableThinking, webSearchEnabled }
 * Accepts e.g. sakana-namazu, sakana-fugu-polite-thinking-search,
 * sakana-namazu:osaka (legacy) — tokens are order-insensitive.
 *
 * Mode mapping (upstream rejects enableThinking=true + search=true):
 *   - '' (default)     → think:false, search:true  (both active)
 *   - thinking         → think:true,  search:false
 *   - search           → think:false, search:true
 *   - thinking-search  → think:false, search:true  (both active, same as default)
 */
function parseModel(model) {
  const tokens = String(model || 'sakana-namazu').toLowerCase().split(/[-:]/).filter(Boolean);
  const sakanaModel = tokens.includes('fugu') ? 'fugu' : 'sakana-namazu';
  let toneMode = 'default';
  for (const t of tokens) if (STYLE_ALIASES[t]) toneMode = STYLE_ALIASES[t];
  const hasThink = tokens.some((t) => t === 'thinking' || t === 'think' || t === 'reason');
  const hasSearch = tokens.some((t) => t === 'search' || t === 'web' || t === 'websearch');
  let enableThinking, webSearchEnabled;
  if (hasThink && !hasSearch) {
    enableThinking = true; webSearchEnabled = false;
  } else if (hasSearch && !hasThink) {
    enableThinking = false; webSearchEnabled = true;
  } else if (hasThink && hasSearch) {
    // both present → use compatible combo (both active via auto-thinking)
    enableThinking = false; webSearchEnabled = true;
  } else {
    // default (no flags) → both active
    enableThinking = false; webSearchEnabled = true;
  }
  return { sakanaModel, toneMode, enableThinking, webSearchEnabled };
}

// ---- helpers ---------------------------------------------------------------

// Sakana streams tokens padded with NUL bytes (anti-inspection); the web app
// strips them: token.replaceAll("\0",""). We mirror that everywhere.
const clean = (s) => String(s || '').replaceAll('\0', '');

// Strip <source-chip> markup (chips can be malformed / attribute-ordered
// differently, so match any chip-shaped tag instead of requiring title+url).
const stripChips = (s) => String(s || '').replace(/<source-chip[^>]*\/>/g, '');

// Text-based file types that can be read directly into the prompt.
const TEXT_FILE_TYPES = {
  'text/plain': true, 'text/markdown': true, 'text/csv': true, 'text/html': true,
  'text/xml': true, 'text/javascript': true, 'text/css': true,
  'application/json': true, 'application/xml': true,
  'application/javascript': true,
  'application/x-yaml': true, 'application/yaml': true,
  'application/toml': true,
};
const TEXT_EXTENSIONS = /\.(txt|md|mdx|markdown|csv|tsv|json|xml|yaml|yml|toml|ini|cfg|conf|log|html|js|ts|jsx|tsx|py|rb|go|rs|java|cs|sh|bash|zsh|env|bat|ps1|css|scss|less|sql|graphql|r|m|c|cpp|h|hpp)$/i;

/**
 * Try to extract readable text from a file attachment.
 * Returns { text, image } — text to prepend to prompt, or image dataUrl.
 * For text-based files, reads the buf as UTF-8. For images, returns null.
 * For unknown types, returns empty string.
 */
function extractFileContent(f) {
  // Images: return null (handled upstream as image_url)
  const mime = (f.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return null;
  // Text-based files: decode buf as text
  if (TEXT_FILE_TYPES[mime] || TEXT_EXTENSIONS.test(f.name)) {
    try {
      const text = f.buf.toString('utf8').slice(0, 50000); // 50KB cap
      return { text: `\n[文件: ${f.name}]\n${text}\n` };
    } catch { return { text: `\n[文件: ${f.name} — 无法解码]\n` }; }
  }
  // Unknown binary: skip
  return { text: '' };
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
  return out;
}

function isDataUrl(s) {
  return typeof s === 'string' && s.startsWith('data:');
}

function dataUrlToParts(dataUrl) {
  // data:[<mediatype>][;base64],<data>
  const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const meta = m[2] || '';
  const data = m[3];
  const isB64 = meta.includes('base64');
  const buf = isB64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');
  return { mime, buf, isB64 };
}

function urlToParts(url) {
  // https://...  -> fetch then convert (done by caller)
  return { mime: null, url };
}

// ---- OpenAI request -> Sakana bootstrap+stream request ---------------------

/**
 * Parse an OpenAI /v1/chat/completions body into:
 *   { model, toneMode, enableThinking, webSearchEnabled, prompt (user text),
 *     files: [{type, name, mime, buf}], messageId, userMessageId, isRetry, isContinue }
 */
function openaiRequestToSakana(body) {
  const model = (body.model || 'sakana-namazu').toLowerCase();
  const pm = parseModel(model);
  let toneMode = pm.toneMode;
  let enableThinking = pm.enableThinking;
  let webSearchEnabled = pm.webSearchEnabled;
  let sakanaModel = pm.sakanaModel;

  // explicit style / tone_mode (overrides model-id style)
  for (const key of ['style', 'tone_mode', 'toneMode']) {
    if (body[key] && STYLE_ALIASES[String(body[key]).toLowerCase()]) {
      toneMode = STYLE_ALIASES[String(body[key]).toLowerCase()];
    }
  }

  // reasoning / thinking
  if (body.enable_thinking !== undefined) enableThinking = !!body.enable_thinking;
  else if (body.thinking !== undefined) enableThinking = !!body.thinking;
  else if (body.reasoning_effort && body.reasoning_effort !== 'none') enableThinking = true;
  else if (body.reasoning) enableThinking = !!body.reasoning;

  // web search
  if (body.web_search !== undefined) webSearchEnabled = !!body.web_search;
  else if (body.webSearchEnabled !== undefined) webSearchEnabled = !!body.webSearchEnabled;
  else if (body.web_search_options) webSearchEnabled = true;
  else if (body.tools && body.tools.some((t) => t && t.function && t.function.name === 'search')) webSearchEnabled = true;
  // model alias for search
  if (/\bsearch\b/.test(model) || model.endsWith(':web') || model.endsWith(':search')) webSearchEnabled = true;

  // extract user text + files from messages
  let prompt = '';
  const files = [];
  let userMessageId = null;
  let isRetry = !!body.is_retry;
  let isContinue = !!body.is_continue;

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  // last user message (or any final content)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    const role = m.role;
    if (role === 'user') {
      // content can be string or array of parts
      let text = '';
      const c = m.content;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        for (const part of c) {
          if (!part) continue;
          if (part.type === 'text') text += (part.text || '');
          else if (part.type === 'image_url' || part.type === 'image') {
            const src = (part.image_url && part.image_url.url) || part.url || '';
            if (isDataUrl(src)) {
              const p = dataUrlToParts(src);
              if (p) {
                const ext = (p.mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
                files.push({ type: 'base64', name: `image-${files.length + 1}.${ext}`, mime: p.mime, buf: p.buf });
              }
            } else if (/^https?:\/\//.test(src)) {
              files.push({ type: 'base64', name: `image-url-${files.length + 1}`, mime: null, url: src, pendingUrl: src });
            }
          } else if (part.type === 'file') {
            const src = part.file_url || part.url || part.data || '';
            if (isDataUrl(src)) {
              const p = dataUrlToParts(src);
              if (p) {
                files.push({ type: 'base64', name: part.name || `file-${files.length + 1}.bin`, mime: part.mime || p.mime, buf: p.buf });
              }
            } else if (/^https?:\/\//.test(src)) {
              files.push({ type: 'base64', name: part.name || `file-${files.length + 1}`, mime: part.mime || null, url: src, pendingUrl: src });
            }
          } else if (part.type === 'input_audio' && part.input_audio && part.input_audio.data) {
            const p = dataUrlToParts(String(part.input_audio.data).startsWith('data:') ? part.input_audio.data : 'data:audio/wav;base64,' + part.input_audio.data);
            if (p) files.push({ type: 'audio', name: 'audio.wav', mime: 'audio/wav', buf: p.buf });
          }
        }
      }
      prompt = (prompt || '') + text;
      if (m.user_message_id && !userMessageId) userMessageId = m.user_message_id;
    } else if (role === 'assistant') {
      // swallow tool-call history passed from OpenAI clients; Sakana re-executes tools server-side
      continue;
    }
    // stop at first user message from bottom -> Sakana uses only the LAST prompt
    break;
  }

  const messageId = body.message_id || randomUUID();

  return {
    sakanaModel, toneMode, enableThinking, webSearchEnabled,
    prompt, files, messageId, userMessageId, isRetry, isContinue,
    // passthroughs
    conversationId: body.conversation_id || null,
    tools: body.tools || null,
  };
}

// ---- NDJSON -> OpenAI SSE chunks -------------------------------------------

class NdjsonTranslator {
  /**
   * translates a Sakana NDJSON line into an array of OpenAI SSE payloads
   * (or null when nothing to emit).
   * state carries: assistantMessageId, toolCallAccumulator, finishedWork
   */
  constructor() {
    this.assistantMessageId = 'chatcmpl-' + randomUUID().replace(/-/g, '');
    this.sentFinish = false;
    this.sentContent = false;
    this.toolCalls = new Map(); // toolCallId -> { index, name, args }
    this.contentBuffer = '';    // full accumulated content for source-chip stripping
    this.citations = [];        // collected source chips
  }

  // strip <source-chip .../> from content, collect chips, return clean text delta.
// Chips can arrive split across chunks; we hold the tail of the stream
// whenever a chip is incomplete and emit only what is guaranteed clean.
// NOTE: tokens are CONSECUTIVE slices of the final text (NUL-padded), so we
// accumulate the cumulative cleaned text and emit only the delta beyond what
// was already emitted — never compare per-token strings (they are not
// necessarily prefixes of each other).
_emitContent(delta) {
  if (!delta) return [];
  this._stream = (this._stream || '') + clean(delta);
  const held = this._stream;
  const chipStart = held.lastIndexOf('<source-chip');
  let committed = held;      // text we are sure is chip-free
  let holdTail = '';
  if (chipStart !== -1) {
    // check if the chip region is complete (ends with '/>')
    const chip = held.slice(chipStart);
    const closeIdx = chip.indexOf('/>');
    if (closeIdx === -1) {
      // incomplete chip: hold everything from chipStart; commit the prefix
      committed = held.slice(0, chipStart);
      holdTail = chip;
    } else {
      committed = held;
    }
  }
  // extract chips from the committed portion
  const re = /<source-chip\s+title="((?:[^"\\]|\\.)*)"\s+url="([^"]*)"\s*\/>/g;
  const seen = new Set(this.citations.map((c) => c.title + '|' + c.url));
  let m;
  while ((m = re.exec(committed)) !== null) {
    const key = m[1] + '|' + m[2];
    if (!seen.has(key)) { this.citations.push({ title: m[1], url: m[2] }); seen.add(key); }
  }
  const cleaned = stripChips(committed);
  this._stream = holdTail;
  const prev = this._cleanPrev || '';
  let outDelta;
  if (cleaned.startsWith(prev)) outDelta = cleaned.slice(prev.length);
  else outDelta = cleaned; // unexpected jump (e.g. search restart) — resync
  this._cleanPrev = prev + outDelta;
  return outDelta ? [{ choices: [{ index: 0, delta: { content: outDelta }, finish_reason: null }] }] : [];
}

  line(raw, state = {}) {
    const out = [];
    let obj;
    try { obj = JSON.parse(raw); } catch { return out; }
    if (!obj || typeof obj !== 'object' || !obj.type) return out;

    switch (obj.type) {
      case 'stream': {
        const token = clean(obj.token);
        if (!token) break;
        this.sentContent = true;
        out.push(...this._emitContent(token));
        break;
      }
      case 'reasoning': {
        const t = clean(obj.token);
        if (t) out.push({ choices: [{ index: 0, delta: { reasoning_content: t }, finish_reason: null }] });
        break;
      }
      case 'finalAnswer': {
        // finalAnswer carries the authoritative full text (may include chips and
        // can differ slightly from what stream tokens emitted, e.g. after
        // keepAlive interruptions). Align via longest common prefix so the
        // client sees a monotonic, non-duplicated stream.
        const text = clean(obj.text);
        if (text) {
          this.sentContent = true;
          const re = /<source-chip\s+title="((?:[^"\\]|\\.)*)"\s+url="([^"]*)"\s*\/>/g;
          const seen = new Set(this.citations.map((c) => c.title + '|' + c.url));
          let m;
          while ((m = re.exec(text)) !== null) {
            const key = m[1] + '|' + m[2];
            if (!seen.has(key)) { this.citations.push({ title: m[1], url: m[2] }); seen.add(key); }
          }
          const cleaned = stripChips(text);
          const prev = this._cleanPrev || '';
          // longest common prefix
          const len = Math.min(prev.length, cleaned.length);
          let i = 0;
          while (i < len && prev[i] === cleaned[i]) i++;
          const delta = cleaned.slice(i);
          if (delta) out.push({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
          this._cleanPrev = cleaned;
          this._stream = '';
        }
        break;
      }
      case 'toolTurnText': {
        // visible progress text -> emit as reasoning? No: it is the turn text UI shows.
        // Map to `magic` for clients that support it; otherwise skip to keep content clean.
        const t = clean(obj.text);
        if (t) out.push({ choices: [{ index: 0, delta: { tool_turn_text: t }, finish_reason: null }] });
        break;
      }
      case 'toolCall': {
        const tc = obj.toolCall || {};
        const id = tc.toolCallId || 'call_' + Math.random().toString(36).slice(2, 12);
        const name = clean(tc.toolName);
        if (name === 'finalizing') break; // internal marker
        // the actual args field is `input` (not `arguments`) in the web protocol
        let args = '';
        if (tc.input !== undefined) args = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
        else if (tc.arguments !== undefined) args = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
        if (!args) args = '{}';
        const prev = this.toolCalls.get(id);
        if (prev) {
          // subsequent partials (finalizing) may refine -> replace
          out.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: prev.index, id, function: { arguments: args } }] }, finish_reason: null }] });
        } else {
          const index = this.toolCalls.size;
          this.toolCalls.set(id, { index, name, args });
          out.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] }, finish_reason: null }] });
        }
        break;
      }
      case 'toolResult': {
        const tr = obj.toolResult || {};
        // emit as a tool message content-free marker for clients that track it;
        // OpenAI tool_calls round-trip expects the client to append a "tool" role
        // message — we intentionally do NOT synthesize one, because Sakana
        // executes tools server-side. For agentic clients (Claude Code etc.)
        // the tool call events let them observe the workflow.
        if (tr.toolName === 'search' && tr.output && tr.output.sources) {
          for (const s of tr.output.sources) {
            if (s && s.title && s.url) this.citations.push({ title: s.title, url: s.url });
          }
        }
        break;
      }
      case 'file': {
        out.push({ choices: [{ index: 0, delta: { file_output: { name: obj.name, sha: clean(obj.sha), mime: obj.mime }, content: '' }, finish_reason: null }] });
        break;
      }
      default:
        break; // status etc.
    }
    return out;
  }

  finish() {
    if (this.sentFinish) return [];
    this.sentFinish = true;
    const chunk = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    if (this.citations.length) chunk.citations = this.citations;
    return [chunk];
  }
}

// ---- helper: format an SSE event from a JSON payload -----------------------

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function chunkToSSE(c) {
  return sse('chat.completion.chunk', { id: thisAssistantId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'sakana-namazu', choices: c.choices });
}

module.exports = { MODELS, openaiRequestToSakana, NdjsonTranslator, sse, chunkToSSE, dataUrlToParts, isDataUrl, clean, stripChips, parseModel, extractFileContent };