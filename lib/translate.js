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
  // A '-think' model-id token mirrors the UI's distinct think mode: it asks the
  // proxy to run enableThinking:true (INNATE by default; the token narrows the
  // parameter so the guard in openaiRequestToSakana can see it).
  const asksThink = tokens.includes('think');
  return { sakanaModel, toneMode, enableThinking: asksThink, webSearchEnabled };
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

function sniffMimeType(buf) {
  if (!buf || buf.length < 4) return 'application/octet-stream';
  // PNG: \x89PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // JPEG: \xFF\xD8\xFF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF: GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  // PDF: %PDF-
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  // WAV: RIFF....WAVE
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  // MP3: ID3 or \xFF\xFB
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)) return 'audio/mpeg';
  // SVG: <svg
  const head = buf.slice(0, 100).toString('utf8').trim().toLowerCase();
  if (head.includes('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return 'application/octet-stream';
}

function isDataUrl(s) { return typeof s === 'string' && s.startsWith('data:'); }

function dataUrlToParts(dataUrl) {
  const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  let mime = m[1] || '';
  const meta = m[2] || '';
  const data = m[3];
  const isB64 = meta.includes('base64');
  const buf = isB64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');
  if (!mime || mime === 'application/octet-stream') {
    mime = sniffMimeType(buf);
  }
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

  // Web search explicit controls
  if (body.web_search === false || body.webSearchEnabled === false || body.search === false) {
    webSearchEnabled = false;
  } else if (body.web_search === true || body.webSearchEnabled === true || body.search === true || body.web_search_options) {
    webSearchEnabled = true;
  } else if (body.tools && body.tools.some((t) => t && t.function && t.function.name === 'search')) {
    webSearchEnabled = true;
  } else if (/\bsearch\b/.test(model) || model.endsWith(':web') || model.endsWith(':search')) {
    webSearchEnabled = true;
  }

  // INPUT-MODE-001 guard: the upstream rejects enableThinking+webSearchEnabled
  // together (verified by real-browser capture 2026-08-17: the web UI never
  // sends both — web search always sends enableThinking:false). Search wins.
  if (webSearchEnabled && enableThinking) enableThinking = false;

  // extract user text + files from messages
  let prompt = '';
  const files = [];
  let userMessageId = null;
  let isRetry = !!body.is_retry;
  let isContinue = !!body.is_continue;
  let toolResults = []; // tool-role message contents (external-framework tool calls)

  // Accept multiple request shapes: chat.completions messages[],
  // Responses-API input (string or {role,content}), legacy completions prompt.
  let msgs = Array.isArray(body.messages) ? body.messages : null;
  if (!msgs) {
    const inp = body.input;
    if (typeof inp === 'string') msgs = [{ role: 'user', content: inp }];
    else if (Array.isArray(inp)) msgs = inp.map((m) => {
      if (typeof m === 'string') return { role: 'user', content: m };
      if (m && m.type === 'message') return { role: m.role || 'user', content: m.content };
      return m;
    });
  }
  if (!msgs && body.prompt != null) {
    msgs = [{ role: 'user', content: Array.isArray(body.prompt) ? body.prompt.join('\n') : String(body.prompt) }];
  }
  msgs = msgs || [];

  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    const role = m.role;
    if (role === 'user') {
      let text = '';
      const c = m.content || m.parts; // Support OpenAI content and Gemini parts
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        for (const part of c) {
          if (!part) continue;
          // Text parts
          if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' || typeof part === 'string' || part.text !== undefined) {
            text += (typeof part === 'string' ? part : (part.text || part.content || ''));
          }
          // OpenAI Image URL
          else if (part.type === 'image_url' || part.type === 'image') {
            const src = (part.image_url && part.image_url.url) || part.url || '';
            const source = part.source; // Anthropic Claude format
            if (source && source.type === 'base64' && source.data) {
              const mime = source.media_type || 'image/png';
              const buf = Buffer.from(source.data, 'base64');
              const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
              files.push({ type: 'base64', name: `image-${files.length + 1}.${ext}`, mime, buf });
            } else if (source && source.type === 'url' && source.url) {
              files.push({ type: 'base64', name: `image-url-${files.length + 1}`, mime: null, url: source.url, pendingUrl: source.url });
            } else if (isDataUrl(src)) {
              const p = dataUrlToParts(src);
              if (p) {
                const ext = (p.mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
                files.push({ type: 'base64', name: `image-${files.length + 1}.${ext}`, mime: p.mime, buf: p.buf });
              }
            } else if (/^https?:\/\//.test(src)) {
              files.push({ type: 'base64', name: `image-url-${files.length + 1}`, mime: null, url: src, pendingUrl: src });
            }
          }
          // Claude Document / PDF format
          else if (part.type === 'document') {
            const src = part.source;
            if (src && src.type === 'base64' && src.data) {
              const mime = src.media_type || 'application/pdf';
              const buf = Buffer.from(src.data, 'base64');
              files.push({ type: 'base64', name: `doc-${files.length + 1}.pdf`, mime, buf });
            }
          }
          // Gemini inline_data / inlineData
          else if (part.inline_data || part.inlineData) {
            const idata = part.inline_data || part.inlineData;
            const mime = idata.mime_type || idata.mimeType || 'image/png';
            const buf = Buffer.from(idata.data || '', 'base64');
            const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
            files.push({ type: 'base64', name: `gemini-${files.length + 1}.${ext}`, mime, buf });
          }
          // File attachments
          else if (part.type === 'file') {
            const src = part.file_url || part.url || part.data || '';
            if (isDataUrl(src)) {
              const p = dataUrlToParts(src);
              if (p) {
                files.push({ type: 'base64', name: part.name || `file-${files.length + 1}.bin`, mime: part.mime || p.mime, buf: p.buf });
              }
            } else if (/^https?:\/\//.test(src)) {
              files.push({ type: 'base64', name: part.name || `file-${files.length + 1}`, mime: part.mime || null, url: src, pendingUrl: src });
            } else if (part.data && Buffer.isBuffer(part.data)) {
              files.push({ type: 'base64', name: part.name || `file-${files.length + 1}.bin`, mime: part.mime || sniffMimeType(part.data), buf: part.data });
            }
          }
          // Audio inputs
          else if (part.type === 'input_audio' && part.input_audio && part.input_audio.data) {
            const p = dataUrlToParts(String(part.input_audio.data).startsWith('data:') ? part.input_audio.data : 'data:audio/wav;base64,' + part.input_audio.data);
            if (p) files.push({ type: 'audio', name: 'audio.wav', mime: 'audio/wav', buf: p.buf });
          }
        }
      }
      prompt = (prompt || '') + text;
      if (m.user_message_id && !userMessageId) userMessageId = m.user_message_id;
    } else if (role === 'assistant') {
      continue; // swallow tool-call history
    } else if (role === 'tool' || role === 'function') {
      // External framework executed a tool and returns the result
      const c = m.content;
      let txt = '';
      if (typeof c === 'string') txt = c;
      else if (Array.isArray(c)) txt = c.map((p) => p && (p.text || p.content || '')).join('\n');
      toolResults.push({ name: m.name || '', tool_call_id: m.tool_call_id || '', content: txt });
      isContinue = true;
      continue;
    }
    break;
  }

  // Tool-result turns: the model resumes from the tool output.
  if (toolResults.length) {
    const parts = toolResults.map((tr) => `[工具结果${tr.name ? ' (' + tr.name + ')' : ''}]${tr.content ? '\n' + tr.content : ''}`).join('\n\n');
    prompt = (prompt ? prompt + '\n\n' : '') + '以下是上一步调用的工具返回结果,请基于这些结果继续回答:\n' + parts;
  }

  // Inject a structured tool hint so the model knows it MAY call custom tools (supports OpenAI and Anthropic formats)
  const clientTools = body.tools || body.functions;
  if (clientTools && !isContinue) {
    const custom = clientTools.filter((t) => {
      if (!t) return false;
      const fnName = (t.function && t.function.name) || t.name;
      return fnName && fnName !== 'search';
    });
    if (custom.length && process.env.TOOL_PROMPT !== '0') {
      const toolDefs = custom.map((t) => {
        const fn = t.function || t;
        const name = fn.name;
        const desc = fn.description || '';
        const params = fn.parameters || fn.input_schema || null;
        return `- ${name}: ${desc}${params ? ' 参数规范: ' + JSON.stringify(params) : ''}`;
      }).join('\n');
      prompt = (prompt ? prompt + '\n\n' : '') + `可用自定义工具列表:\n${toolDefs}\n\n如需调用工具,请直接以 JSON 格式输出: {"tool":"工具名称","arguments":{...}} 或 [{"tool":"...","arguments":{...}}]`;
    }
  }

  // Long-context optimization: auto-convert massive prompt text (>12000 chars) into sandbox text attachment
  if (prompt.length > 12000 && !files.some(f => f.name && f.name.endsWith('.txt'))) {
    const origLength = prompt.length;
    files.push({
      type: 'base64',
      name: 'context_document.txt',
      mime: 'text/plain',
      buf: Buffer.from(prompt, 'utf8'),
    });
    prompt = `[系统提示: 超长上下文内容 (共 ${origLength} 字符) 已自动封装为附件 context_document.txt 挂载至沙盒，请在沙盒中完整读取该文档并回答以下核心任务：]\n\n` +
      prompt.slice(0, 1500) + `\n\n... [文档主体内容已挂载至附件 context_document.txt] ...\n\n` +
      prompt.slice(-1500);
  }

  const messageId = body.message_id || randomUUID();

  return {
    sakanaModel, toneMode, enableThinking, webSearchEnabled,
    prompt, files, messageId, userMessageId, isRetry, isContinue,
    conversationId: body.conversation_id || body.chat_id || body.thread_id || null,
    tools: body.tools || null,
    isToolTurn: toolResults.length > 0,
  };
}

// Helper: Parse generative JSON / Tagged tool calls from model output
function extractJsonToolCalls(text) {
  if (!text || typeof text !== 'string') return null;
  const calls = [];

  // 1. Tagged format: <tool_call>...</tool_call> or <function_call>...</function_call>
  const tagRegex = /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(tagMatch[1].trim());
      const name = parsed.name || parsed.tool || (parsed.function && parsed.function.name);
      const args = parsed.arguments || parsed.parameters || (parsed.function && parsed.function.arguments) || {};
      if (name && typeof name === 'string' && name !== 'finalizing') {
        calls.push({
          name: String(name),
          arguments: typeof args === 'object' ? JSON.stringify(args) : String(args || '{}'),
        });
      }
    } catch {}
  }
  if (calls.length > 0) return calls;

  // 2. Markdown block: ```json ... ``` or bare JSON object/array
  const blockMatch = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text) ||
                     /^\s*(\[[\s\S]*\]|\{[\s\S]*\})\s*$/i.exec(text);
  if (blockMatch) {
    try {
      const parsed = JSON.parse(blockMatch[1].trim());
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const name = item.name || item.tool || (item.function && item.function.name);
        const args = item.arguments || item.parameters || (item.function && item.function.arguments) || {};
        if (name && typeof name === 'string' && name !== 'finalizing') {
          calls.push({
            name: String(name),
            arguments: typeof args === 'object' ? JSON.stringify(args) : String(args || '{}'),
          });
        }
      }
    } catch {}
  }

  return calls.length > 0 ? calls : null;
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
    this.inThinkingTag = false;
    this._cleanPrev = '';
    this._stream = '';
    this.hasToolCalls = false;
    this.nativeToolRound = false;
    this.clientToolRound = false;
  }

  _extractCitations(text) {
    if (!text) return;
    const re = /<source-chip\s+title="((?:[^"\\]|\\.)*)"\s+url="([^"]*)"\s*\/>/g;
    const seen = new Set(this.citations.map((c) => c.title + '|' + c.url));
    let m;
    while ((m = re.exec(text)) !== null) {
      const title = m[1].replace(/\\"/g, '"');
      const url = m[2];
      const key = title + '|' + url;
      if (!seen.has(key)) {
        this.citations.push({ title, url });
        seen.add(key);
      }
    }
  }

  _emitContent(delta) {
    if (!delta) return [];
    const out = [];
    this._stream = (this._stream || '') + clean(delta);
    let held = this._stream;

    // Buffer incomplete <source-chip ...> tags
    const chipStart = held.lastIndexOf('<source-chip');
    let committed = held;
    let holdTail = '';
    if (chipStart !== -1) {
      const chip = held.slice(chipStart);
      const closeIdx = chip.indexOf('/>');
      if (closeIdx === -1) {
        committed = held.slice(0, chipStart);
        holdTail = chip;
      }
    }

    this._extractCitations(committed);
    let cleaned = stripChips(committed);
    this._stream = holdTail;

    // Handle embedded <thinking>...</thinking> tags inside content stream
    while (cleaned.length > 0) {
      if (!this.inThinkingTag) {
        const thinkOpen = cleaned.indexOf('<thinking>');
        if (thinkOpen !== -1) {
          const before = cleaned.slice(0, thinkOpen);
          if (before) {
            const prev = this._cleanPrev || '';
            let outDelta = before.startsWith(prev) ? before.slice(prev.length) : before;
            if (outDelta) {
              this._cleanPrev = prev + outDelta;
              out.push({ choices: [{ index: 0, delta: { content: outDelta }, finish_reason: null }] });
            }
          }
          this.inThinkingTag = true;
          cleaned = cleaned.slice(thinkOpen + 10);
          this._cleanPrev = '';
        } else {
          // Normal content
          const prev = this._cleanPrev || '';
          let outDelta = cleaned.startsWith(prev) ? cleaned.slice(prev.length) : cleaned;
          this._cleanPrev = prev + outDelta;
          if (outDelta) out.push({ choices: [{ index: 0, delta: { content: outDelta }, finish_reason: null }] });
          break;
        }
      } else {
        const thinkClose = cleaned.indexOf('</thinking>');
        if (thinkClose !== -1) {
          const thinkText = cleaned.slice(0, thinkClose);
          if (thinkText) {
            out.push({ choices: [{ index: 0, delta: { reasoning_content: thinkText }, finish_reason: null }] });
          }
          this.inThinkingTag = false;
          cleaned = cleaned.slice(thinkClose + 11);
          this._cleanPrev = '';
        } else {
          // All remaining text is thinking reasoning
          out.push({ choices: [{ index: 0, delta: { reasoning_content: cleaned }, finish_reason: null }] });
          cleaned = '';
          break;
        }
      }
    }

    return out;
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
          this._extractCitations(text);
          let cleaned = stripChips(text);

          // Strip any residual <thinking>...</thinking>
          const thinkMatch = /<thinking>([\s\S]*?)<\/thinking>/i.exec(cleaned);
          if (thinkMatch) {
            out.push({ choices: [{ index: 0, delta: { reasoning_content: thinkMatch[1] }, finish_reason: null }] });
            cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
          }

          // Check if the final answer contains JSON or Tagged tool calls (single or parallel)
          const extractedTools = extractJsonToolCalls(cleaned);
          if (extractedTools && extractedTools.length > 0) {
            this.hasToolCalls = true;
            this.clientToolRound = true;
            const deltaCalls = extractedTools.map((tc, idx) => {
              const id = 'call_' + Math.random().toString(36).slice(2, 12);
              this.toolCalls.set(id, { index: idx, name: tc.name, args: tc.arguments });
              return {
                index: idx,
                id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              };
            });
            out.push({
              choices: [{
                index: 0,
                delta: { tool_calls: deltaCalls },
                finish_reason: null,
              }],
            });
            this._cleanPrev = cleaned;
            this._stream = '';
            break;
          }

          const prev = this._cleanPrev || '';
          let delta;
          if (cleaned.startsWith(prev)) delta = cleaned.slice(prev.length);
          else {
            let i = 0;
            const len = Math.min(prev.length, cleaned.length);
            while (i < len && prev[i] === cleaned[i]) i++;
            delta = cleaned.slice(i);
          }
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
        this.hasToolCalls = true;
        // Native sandbox rounds (upload_file / run_python / …) must be
        // transparently continued server-side: the upstream occasionally ends
        // such a round with an empty finalAnswer and only is_continue forces
        // the model to emit its real answer.
        if (/^functions\./.test(id)) this.nativeToolRound = true;
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
          const seen = new Set(this.citations.map((c) => c.title + '|' + c.url));
          for (const s of tr.output.sources) {
            if (s && s.title && s.url) {
              const key = s.title + '|' + s.url;
              if (!seen.has(key)) {
                this.citations.push({ title: s.title, url: s.url, snippet: s.snippet || s.content || '' });
                seen.add(key);
              }
            }
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
    const finishReason = this.hasToolCalls ? 'tool_calls' : 'stop';
    const chunk = { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
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

module.exports = { MODELS, openaiRequestToSakana, NdjsonTranslator, sse, chunkToSSE, dataUrlToParts, isDataUrl, clean, stripChips, parseModel, extractFileContent, sniffMimeType };