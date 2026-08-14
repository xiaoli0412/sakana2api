// OpenAI <-> Sakana web chat protocol translation.
// Built from https://chat.sakana.ai protocol reverse-engineering (see protocol.md).

const { randomUUID } = require('crypto');

// ---- model / style mapping -------------------------------------------------

// Real upstream models (both free once logged in)
const UPSTREAM_MODELS = [
  { id: 'sakana-namazu', api: 'sakana-namazu', name: 'Namazu' },
  { id: 'sakana-fugu', api: 'fugu', name: 'Fugu' },
];

// style -> toneMode mapping. Sakana API accepts: default, jp-vibes, osaka
const STYLE_ALIASES = {
  default: 'default', standard: 'default', normal: 'default', '一般': 'default',
  polite: 'jp-vibes', 'ていねい': 'jp-vibes', '礼貌': 'jp-vibes',
  osaka: 'osaka', '大阪': 'osaka',
};

// 2 models × 3 styles × 2 suffixes = 12 models.
// Thinking is INNATE (always present automatically), so only default(+search) and search mode.
// Styles: Standard (default), Polite (jp-vibes), Osaka (osaka)
// Suffix: '' = default (search+think), '-search' = explicit search
const STYLE_TOKENS = [
  { token: '', label: 'Standard 🐟', tone: 'default' },
  { token: 'polite', label: 'Polite 🐠', tone: 'jp-vibes' },
  { token: 'osaka', label: 'Osaka 🐙', tone: 'osaka' },
];
const MODE_TOKENS = [
  { token: '', label: '默认', think: false, search: true },
  { token: 'search', label: '搜索', think: false, search: true },
];

const MODELS = (() => {
  const out = [];
  for (const { id: base, api, name } of UPSTREAM_MODELS) {
    for (const { token: st, label, tone } of STYLE_TOKENS) {
      for (const { token: md, label: mdLabel, think, search } of MODE_TOKENS) {
        const parts = [base, st, md].filter(Boolean);
        const id = parts.join('-');
        const desc = `${name} · ${label}${mdLabel ? ' · ' + mdLabel : ''}`;
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
 * Parse a model id (hyphen or legacy colon). Thinking is always on (innate).
 * Mode: '' = search+think (default), 'search' = search+think (same),
 * 'thinking' legacy = search+think (same).
 */
function parseModel(model) {
  const tokens = String(model || 'sakana-namazu').toLowerCase().split(/[-:]/).filter(Boolean);
  const sakanaModel = tokens.includes('fugu') ? 'fugu' : 'sakana-namazu';
  let toneMode = 'default';
  for (const t of tokens) if (STYLE_ALIASES[t]) toneMode = STYLE_ALIASES[t];
  // Thinking is always on (innate). Search is the only toggle.
  const webSearchEnabled = !tokens.some((t) => t === 'nosearch' || t === 'no-search');
  return { sakanaModel, toneMode, enableThinking: false, webSearchEnabled };
}

// ---- helpers ---------------------------------------------------------------

const clean = (s) => String(s || '').replaceAll('\0', '');
const stripChips = (s) => String(s || '').replace(/<source-chip[^>]*\/>/g, '');

// Text-based file types that can be read into the prompt
const TEXT_FILE_TYPES = {
  'text/plain': true, 'text/markdown': true, 'text/csv': true, 'text/html': true,
  'text/xml': true, 'text/javascript': true, 'text/css': true,
  'application/json': true, 'application/xml': true,
  'application/javascript': true, 'application/x-yaml': true, 'application/yaml': true,
  'application/toml': true,
};
const TEXT_EXTENSIONS = /\.(txt|md|mdx|markdown|csv|tsv|json|xml|yaml|yml|toml|ini|cfg|conf|log|html|js|ts|jsx|tsx|py|rb|go|rs|java|cs|sh|bash|zsh|env|bat|ps1|css|scss|less|sql|graphql|r|m|c|cpp|h|hpp)$/i;

function extractFileContent(f) {
  const mime = (f.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return null;
  if (TEXT_FILE_TYPES[mime] || TEXT_EXTENSIONS.test(f.name)) {
    try {
      const text = f.buf.toString('utf8').slice(0, 50000);
      return { text: `\n[文件: ${f.name}]\n${text}\n` };
    } catch { return { text: `\n[文件: ${f.name} — 无法解码]\n` }; }
  }
  return { text: '' };
}

function isDataUrl(s) { return typeof s === 'string' && s.startsWith('data:'); }

function dataUrlToParts(dataUrl) {
  const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const meta = m[2] || '';
  const data = m[3];
  const isB64 = meta.includes('base64');
  const buf = isB64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');
  return { mime, buf, isB64 };
}

// ---- OpenAI request -> Sakana bootstrap+stream request ---------------------

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

  // explicit overrides
  if (body.enable_thinking !== undefined) enableThinking = !!body.enable_thinking;
  else if (body.thinking !== undefined) enableThinking = !!body.thinking;
  else if (body.reasoning_effort && body.reasoning_effort !== 'none') enableThinking = true;
  else if (body.reasoning) enableThinking = !!body.reasoning;
  if (body.web_search !== undefined) webSearchEnabled = !!body.web_search;
  else if (body.webSearchEnabled !== undefined) webSearchEnabled = !!body.webSearchEnabled;
  else if (body.web_search_options) webSearchEnabled = true;
  else if (body.tools && body.tools.some((t) => t && t.function && t.function.name === 'search')) webSearchEnabled = true;
  if (/\bsearch\b/.test(model) || model.endsWith(':web') || model.endsWith(':search')) webSearchEnabled = true;

  // extract user text + files from messages
  let prompt = '';
  const files = [];
  let userMessageId = null;
  let isRetry = !!body.is_retry;
  let isContinue = !!body.is_continue;

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    const role = m.role;
    if (role === 'user') {
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
      continue; // swallow tool-call history
    }
    break;
  }

  const messageId = body.message_id || randomUUID();

  return {
    sakanaModel, toneMode, enableThinking, webSearchEnabled,
    prompt, files, messageId, userMessageId, isRetry, isContinue,
    conversationId: body.conversation_id || null,
    tools: body.tools || null,
  };
}

// ---- NDJSON -> OpenAI SSE chunks -------------------------------------------

class NdjsonTranslator {
  constructor() {
    this.assistantMessageId = 'chatcmpl-' + randomUUID().replace(/-/g, '');
    this.sentFinish = false;
    this.sentContent = false;
    this.toolCalls = new Map();
    this.contentBuffer = '';
    this.citations = [];
  }

  _emitContent(delta) {
    if (!delta) return [];
    this._stream = (this._stream || '') + clean(delta);
    const held = this._stream;
    const chipStart = held.lastIndexOf('<source-chip');
    let committed = held;
    let holdTail = '';
    if (chipStart !== -1) {
      const chip = held.slice(chipStart);
      const closeIdx = chip.indexOf('/>');
      if (closeIdx === -1) {
        committed = held.slice(0, chipStart);
        holdTail = chip;
      } else {
        committed = held;
      }
    }
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
    else outDelta = cleaned;
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
        const t = clean(obj.text);
        if (t) out.push({ choices: [{ index: 0, delta: { tool_turn_text: t }, finish_reason: null }] });
        break;
      }
      case 'toolCall': {
        const tc = obj.toolCall || {};
        const id = tc.toolCallId || 'call_' + Math.random().toString(36).slice(2, 12);
        const name = clean(tc.toolName);
        if (name === 'finalizing') break;
        let args = '';
        if (tc.input !== undefined) args = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
        else if (tc.arguments !== undefined) args = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
        if (!args) args = '{}';
        const prev = this.toolCalls.get(id);
        if (prev) {
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
        break;
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

// ---- helpers ---------------------------------------------------------------

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function chunkToSSE(c) {
  return sse('chat.completion.chunk', { id: thisAssistantId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'sakana-namazu', choices: c.choices });
}

module.exports = { MODELS, openaiRequestToSakana, NdjsonTranslator, sse, chunkToSSE, dataUrlToParts, isDataUrl, clean, stripChips, parseModel, extractFileContent };