// OpenAI <-> Sakana web chat protocol translation.
// Built from https://chat.sakana.ai protocol reverse-engineering (see protocol.md).

const { randomUUID } = require('crypto');
const { TurnEventBuffer, contentDelta, reasoningDelta, searchStarted, searchSource, toolCallStart, toolCallDelta, toolCallEnd, fileOutput, finish: finishEvent, usage: usageEvent } = require('./events');
const { ToolCallState } = require('./tool-state');

const RP_MODEL_ERROR_CODE = 'RP-MODEL-DISABLED';
const RP_MODEL_ERROR_MESSAGE = 'RP models are disabled';

// ---- model / style mapping -------------------------------------------------

// style -> toneMode mapping. Sakana API accepts: default, jp-vibes, osaka
const STYLE_ALIASES = {
  default: 'default', standard: 'default', normal: 'default', '一般': 'default',
  polite: 'jp-vibes', 'ていねい': 'jp-vibes', '礼貌': 'jp-vibes',
  osaka: 'osaka', '大阪': 'osaka',
};

// 8 public models: family(standard/code/writer) × tier(full/mini) + 2 style
// names. Search/thinking are routed internally (INPUT-MODE-001: mutually
// exclusive upstream) — code/writer profiles default to a search→think
// two-round chain, standard profiles stay single-round thinking-first.
// Upstream model names verified against the 2026-10 client registry
// (sakana-namazu + fugu-max; "fugu" alone no longer appears in the bundle).
// SAKANA_MINI_UPSTREAM allows a live override if upstream renames again.
const MINI_UPSTREAM = process.env.SAKANA_MINI_UPSTREAM || 'fugu-max';
// Measured 2026-10 against the real upstream (scripts/probe_models.mjs): fugu-max
// and sakana-namazu tie on reasoning/writing/translation; fugu-max produces the
// tighter, more surgical code fixes, so code profiles ride it by default.
const CODE_UPSTREAM = process.env.SAKANA_CODE_UPSTREAM || 'fugu-max';
const MODEL_PROFILES = [
  { id: 'sakana',             family: 'standard',  tier: 'full', upstream: 'sakana-namazu', tone: 'default',  label: 'Sakana',             desc: '标准对话 · 深度思考' },
  { id: 'sakana-mini',        family: 'standard',  tier: 'mini', upstream: MINI_UPSTREAM,   tone: 'default',  label: 'Sakana Mini',        desc: '轻量快速 · 深度思考' },
  { id: 'sakana-code',        family: 'code',      tier: 'full', upstream: CODE_UPSTREAM,    tone: 'default',  label: 'Sakana Code',        desc: '编程 · 长思维链 · 工具强化 · 先搜后想' },
  { id: 'sakana-code-mini',   family: 'code',      tier: 'mini', upstream: CODE_UPSTREAM,   tone: 'default',  label: 'Sakana Code Mini',   desc: '编程轻量 · 工具强化 · 先搜后想' },
  { id: 'sakana-writer',      family: 'writer',    tier: 'full', upstream: 'sakana-namazu', tone: 'default',  label: 'Sakana Writer',      desc: '超长文本写作 · 上下文压缩管线' },
  { id: 'sakana-writer-mini', family: 'writer',    tier: 'mini', upstream: MINI_UPSTREAM,   tone: 'default',  label: 'Sakana Writer Mini', desc: '写作轻量 · 上下文压缩管线' },
  { id: 'sakana-translate',   family: 'translate', tier: 'full', upstream: 'sakana-namazu', tone: 'default',  label: 'Sakana Translate',   desc: '大批量翻译 · 格式保真 · 术语一致' },
  { id: 'sakana-polite',      family: 'standard',  tier: 'full', upstream: 'sakana-namazu', tone: 'jp-vibes', label: 'Sakana Polite',      desc: '敬语风格 · 深度思考' },
  { id: 'sakana-osaka',       family: 'standard',  tier: 'full', upstream: 'sakana-namazu', tone: 'osaka',    label: 'Sakana Osaka',       desc: 'Osaka 风格 · 深度思考' },
];

const MODEL_BY_ID = new Map(MODEL_PROFILES.map((p) => [p.id, p]));

const MODELS = MODEL_PROFILES.map((p) => ({
  id: p.id, object: 'model', created: 0, owned_by: 'sakana',
  description: `${p.label} · ${p.desc}`,
  apiModel: p.upstream, tone: p.tone, family: p.family, tier: p.tier, search: false,
}));

// RP model aliases are disabled. Reject the marker anywhere in a model token
// before style/model mapping can turn an old alias into a standard model.
function isRPModelName(model) {
  const normalized = String(model || '').toLowerCase().replace(/^models\//, '');
  return normalized.includes('rp') || normalized.includes('roleplay') || normalized.includes('role-play');
}

function createRpModelError(model) {
  const error = new Error(RP_MODEL_ERROR_MESSAGE);
  error.name = 'RpModelDisabledError';
  error.code = RP_MODEL_ERROR_CODE;
  error.errorCode = RP_MODEL_ERROR_CODE;
  error.status = 400;
  error.type = 'invalid_request_error';
  error.model = String(model || '');
  return error;
}

function assertStandardModel(model) {
  if (isRPModelName(model)) throw createRpModelError(model);
}

/**
 * Convert request-normalizer output into a deterministic prompt while retaining
 * message roles and structured tool/attachment parts. Callers that already
 * normalized a request can use this helper instead of rebuilding from raw
 * message content.
 */
function normalizedMessagesToPrompt(messages = []) {
  const roleLabels = {
    system: '[系统]',
    user: '[用户]',
    assistant: '[助手]',
    tool: '[工具]',
  };
  const rendered = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const parts = [];
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (!part || typeof part !== 'object') continue;
      if (part.kind === 'text') {
        if (part.text) parts.push(String(part.text));
      } else if (part.kind === 'tool_call') {
        const args = typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments ?? {});
        parts.push(`[工具调用${part.name ? ' (' + part.name + ')' : ''}]\n${args}`);
      } else if (part.kind === 'tool_result') {
        const content = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
        parts.push(`[工具结果${part.id ? ' (' + part.id + ')' : ''}]\n${content}`);
      } else if (part.kind === 'attachment') {
        const attachment = part.attachment || {};
        parts.push(`[附件: ${attachment.name || attachment.id || 'attachment'}]`);
      }
    }
    if (parts.length) {
      const role = roleLabels[message.role] || `[${String(message.role || '消息')}]`;
      rendered.push(role + '\n' + parts.join('\n'));
    }
  }
  return rendered.join('\n\n');
}

// Profile-specific protocols injected above user system prompts.
const CODE_PROFILE_PROMPT = `[Code 模式协议 — 严格遵守:
1. 深度思考优先:先完整通读用户提供的代码与上下文,在思考链中梳理数据流与边界条件,再动手写代码;
2. 输出代码时给出完整可运行文件或统一 diff 格式,并标注目标文件路径,不要省略未变更部分;
3. 复杂任务先拆解为步骤,按步调用工具并核对每一步结果后再继续;
4. 修复缺陷时先说明根因再给出修复;无法确定时明确列出验证步骤,不要猜测。]`;

const WRITER_PROFILE_PROMPT = `[写作模式协议 — 严格遵守:
1. 长文写作保持与前文的连贯,主动延续既有人物、设定与时间线;
2. 输出长章节时保持章节结构与段落节奏,不要中途总结或提前收尾;
3. 上下文文档内容与既有设定冲突时,以文档为准。]`;

// Translation protocol: mirrors the upstream /translate page's contract
// (source auto-detect, faithful segment mapping) but without its 2,000-char
// input cap — bulk documents ride the long-context attachment pipeline.
function buildTranslateProfilePrompt({ targetLang = 'zh-CN', sourceLang = '' } = {}) {
  const src = sourceLang && sourceLang !== 'auto' ? `源语言固定为 ${sourceLang}。` : '自动识别源语言。';
  return `[翻译模式协议 — 严格遵守:
1. ${src}把用户输入的全文翻译为「${targetLang}」,只输出译文:不要任何前言、说明、注释、罗马字或原文复读;
2. 逐段完整翻译,段落数量、换行、列表编号、表格结构与 Markdown 标记(#、*、>、代码块围栏)与原文完全一致,不许合并、拆分或省略任何一节;
3. 代码块与行内代码本体保持原样不译,代码注释翻译;URL、邮箱、文件路径、环境变量名、命令行保留原文;
4. 术语全篇一致:同一原文术语始终使用同一译法,专有名词首次出现时可在括号内保留原文;
5. 数字、单位、金额、日期保持原值,仅按目标语言习惯调整书写格式;
6. 译文语气与原文一致(正式/口语/敬语),原文的敬语级别在译文中以相应语体体现。]`;
}

/**
 * Parse a model id (hyphen or legacy colon) into a MODEL_PROFILES entry plus
 * upstream request flags. The 8 public ids map exactly; legacy v0.14 names
 * (sakana-namazu / sakana-fugu families and free suffixes) resolve to the
 * closest profile so old clients keep their upstream/style. Thinking is always
 * on (innate); '-search' keeps legacy single-round search behavior.
 */
function parseModel(model) {
  const normalized = String(model || 'sakana').toLowerCase();
  assertStandardModel(normalized);
  const bare = normalized.replace(/^models\//, '');
  const exact = MODEL_BY_ID.get(bare);
  if (exact) {
    return {
      profile: exact,
      sakanaModel: exact.upstream,
      toneMode: exact.tone,
      enableThinking: true,
      webSearchEnabled: false,
      isRP: false,
    };
  }
  const tokens = bare.split(/[-:]/).filter(Boolean);
  const tier = (tokens.includes('fugu') || tokens.includes('mini')) ? 'mini' : 'full';
  let tone = 'default';
  for (const t of tokens) if (STYLE_ALIASES[t]) tone = STYLE_ALIASES[t];
  let family = 'standard';
  if (tokens.includes('code') || tokens.includes('coder')) family = 'code';
  else if (tokens.includes('writer') || tokens.includes('write')) family = 'writer';
  // 显式模式切换(INPUT-MODE-001:思考与搜索上游互斥,默认思考模式):
  //   带 search token → 搜索模式;nosearch 显式关闭;其余一律思考模式。
  const explicitSearch = tokens.includes('search') && !tokens.some((t) => t === 'nosearch' || t === 'no-search');
  const profile = MODEL_PROFILES.find((p) => p.family === family && p.tier === tier && p.tone === tone)
    || MODEL_PROFILES.find((p) => p.family === family && p.tier === tier && p.tone === 'default')
    || MODEL_PROFILES[0];
  return {
    profile,
    sakanaModel: profile.upstream,
    toneMode: tone,
    enableThinking: true,
    webSearchEnabled: explicitSearch,
    isRP: false,
  };
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
      const text = f.buf.toString('utf8');
      return { text: `\n[文件: ${f.name}]\n${text}\n` };
    } catch { return { text: `\n[文件: ${f.name} — 无法解码]\n` }; }
  }
  return null;
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
  assertStandardModel(model);
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
  } else if (/\bsearch\b/.test(model) || model.endsWith(':web') || model.endsWith(':search')) {
    webSearchEnabled = true;
  }

  // INPUT-MODE-001 硬约束(实测上游 400):enableThinking 与 webSearchEnabled
  // 不能同时为 true。语义改为显式模式切换:
  //   搜索模式 → enableThinking:false + webSearchEnabled:true
  //   思考模式 → enableThinking:true  + webSearchEnabled:false
  // 搜索过程由代理翻译层合成进 reasoning_content(见 NdjsonTranslator),
  // 客户端在思维链里能看到"正在搜索/搜索来源"。
  if (webSearchEnabled) enableThinking = false;

  // 智能路由(INPUT-MODE-001 下同轮无法既搜又想):code/writer 档默认
  // "先搜后想"两轮链——主轮保持思考模式,搜索轮由 server 侧先行发起并把
  // 来源注入主轮 prompt。显式 web_search:true、显式关闭思考或
  // SAKANA_SEARCH_CHAIN=off 时回退单轮。
  const profile = pm.profile || { family: 'standard', tier: 'full' };
  // translate 档:纯快速模式(思考与搜索都关),翻译要的是吞吐与原文保真。
  if (profile.family === 'translate') {
    enableThinking = false;
    webSearchEnabled = false;
  }
  const route = {
    family: profile.family,
    tier: profile.tier,
    chainSearch:
      (profile.family === 'code' || profile.family === 'writer') &&
      process.env.SAKANA_SEARCH_CHAIN !== 'off' &&
      !webSearchEnabled && enableThinking,
  };

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

  // System prompts lead the conversation (character cards, RP rules...).
  // Collected in a forward pass: the backward history scan below stops at the
  // first user message, so system messages must be gathered beforehand.
  let systemText = '';
  for (const m of msgs) {
    if (!m || m.role !== 'system') continue;
    const c = m.content;
    let st = '';
    if (typeof c === 'string') st = c;
    else if (Array.isArray(c)) st = c.map((p) => (p && (p.text || p.content)) || '').join('\n');
    if (st) systemText = systemText ? systemText + '\n\n' + st : st;
  }

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
      // External framework executed a tool and returns the result. The result
      // is injected as a fresh user input (see below) — NOT an is_continue
      // turn: upstream ignores inputs on is_continue rounds, which would leave
      // the model blind to the tool output. (Native sandbox tool rounds are
      // continued transparently server-side with their own is_continue logic.)
      const c = m.content;
      let txt = '';
      if (typeof c === 'string') txt = c;
      else if (Array.isArray(c)) txt = c.map((p) => p && (p.text || p.content || '')).join('\n');
      toolResults.push({ name: m.name || '', tool_call_id: m.tool_call_id || '', content: txt });
      continue;
    }
    break;
  }

  // System prompts lead the conversation (character card identity, RP rules).
  if (systemText) prompt = systemText + '\n\n' + prompt;

  // Profile protocols ride above user system prompts: code demands long
  // chain-of-thought plus strict tool discipline, writer demands continuity,
  // translate demands verbatim-only output with preserved structure.
  if (route.family === 'code') {
    prompt = CODE_PROFILE_PROMPT + '\n\n' + prompt;
  } else if (route.family === 'writer') {
    prompt = WRITER_PROFILE_PROMPT + '\n\n' + prompt;
  } else if (route.family === 'translate') {
    const targetLang = String(body.target_lang || body.targetLang || 'zh-CN').trim() || 'zh-CN';
    const sourceLang = String(body.source_lang || body.sourceLang || 'auto').trim() || 'auto';
    prompt = buildTranslateProfilePrompt({ targetLang, sourceLang }) + '\n\n' + prompt;
  }

  // Tool-result turns: the model resumes from the tool output.
  if (toolResults.length) {
    const parts = toolResults.map((tr) => `[工具结果${tr.name ? ' (' + tr.name + ')' : ''}]${tr.content ? '\n' + tr.content : ''}`).join('\n\n');
    prompt = (prompt ? prompt + '\n\n' : '') + '以下是上一步调用的工具返回结果,请基于这些结果继续回答:\n' + parts;
  }

  // Inject a structured tool hint so the model knows it MAY call custom tools
  // (supports OpenAI and Anthropic formats). The upstream model has its own
  // native sandbox tools (run_command/run_python/read_file/…) which execute in
  // Sakana's sandbox — meaningless for API clients — so the protocol must
  // forbid them and demand a bare JSON object as the final output.
  const clientTools = body.tools || body.functions;
  const clientToolNames = [];
  if (clientTools) {
    // 工具名收集在条件外:工具结果回合(第二轮回传 tool 结果)也要知道声明了
    // 哪些工具——NdjsonTranslator 依赖它抑制原生工具 delta 与 JSON 泄漏。
    const custom = clientTools.filter((t) => {
      if (!t) return false;
      const fnName = (t.function && t.function.name) || t.name;
      return !!fnName;
    });
    for (const t of custom) {
      const fn = t.function || t;
      if (fn.name) clientToolNames.push(fn.name);
    }
  }

  // Long-context pipeline: auto-convert massive prompt text into a sandbox
  // attachment. Two packaging formats:
  //   txt  — the full prompt verbatim as context_document.txt
  //   json — a structured sakana-context/1 document (system + role turns) as
  //          context_document.json, preserving turn boundaries for coherence.
  // The prompt only carries the document-usage protocol plus head/tail
  // markers; the full source stays in the request-scoped attachment.
  // NOTE: this runs BEFORE the tool-hint injection below on purpose — client
  // tool schemas (AstrBot/OpenCode ship 40K+ of JSON) must never enter the
  // attachment; models were burning minutes reading a giant tool document
  // from the sandbox instead of the user's actual context.
  const LONG_PROMPT_THRESHOLD = parseInt(process.env.LONG_PROMPT_THRESHOLD || '12000', 10);
  if (prompt.length > LONG_PROMPT_THRESHOLD && !files.some((f) => f && f.synthetic === true)) {
    const origLength = prompt.length;
    const contextFormat = String(body.context_format || body.contextFormat || '').toLowerCase() === 'json' ? 'json' : 'txt';
    let filename = 'context_document.txt';
    let mime = 'text/plain';
    let payload = Buffer.from(prompt, 'utf8');
    if (contextFormat === 'json') {
      const doc = buildJsonContextDocument(body, prompt);
      filename = 'context_document.json';
      mime = 'application/json';
      payload = Buffer.from(JSON.stringify(doc), 'utf8');
    }
    files.push({
      type: 'base64',
      name: filename,
      synthetic: true,
      mime,
      buf: payload,
    });
    if (route.family === 'writer') {
      Object.defineProperty(body, '__writerProfile', { value: true, enumerable: false, configurable: true, writable: true });
    }
    const wrapper =
      `[系统提示: 超长上下文 (共 ${origLength} 字符) 已封装为附件 ${filename} 挂载至沙盒。该文档是本次任务的唯一事实来源，请遵守文档使用协议：\n` +
      `1. 先在沙盒中完整读取该文档，再回答核心任务；\n` +
      `2. 回答中的事实必须来自文档，不得编造；引用时注明来源轮次或段落；\n` +
      (contextFormat === 'json'
        ? `3. 文档为 sakana-context/1 结构：meta 元信息 + system 系统设定 + turns 按序对话轮次，逐轮保持连贯；\n`
        : `3. 文档为连续原文，按原有章节/段落顺序理解；\n`) +
      `4. 保持 markdown、表格、代码块等格式完整原生输出，不要截断或转译；\n` +
      `5. 文档内容与你的先验知识冲突时，以文档为准。]\n\n`;
    prompt = wrapper +
      prompt.slice(0, 1500) + `\n\n... [文档主体内容已挂载至附件 ${filename}] ...\n\n` +
      prompt.slice(-1500);
  }

  // Tool hint injection — AFTER long-context packaging so client tool schemas
  // stay in the visible prompt (which is short here) and never enter the
  // sandbox attachment. Schemas are size-capped: the model only needs names,
  // descriptions and the JSON envelope; full parameter trees are dropped when
  // the total exceeds TOOL_HINT_MAX_BYTES (AstrBot/OpenCode ship 40K+ schemas).
  const TOOL_HINT_MAX_BYTES = parseInt(process.env.TOOL_HINT_MAX_BYTES || '6000', 10);
  if (clientTools && !isContinue && !toolResults.length && route.family !== 'translate' && process.env.TOOL_PROMPT !== '0') {
    const custom = clientTools.filter((t) => {
      if (!t) return false;
      const fnName = (t.function && t.function.name) || t.name;
      return !!fnName;
    });
    const fullDefs = custom.map((t) => {
      const fn = t.function || t;
      const params = fn.parameters || fn.input_schema || null;
      return `- ${fn.name}: ${fn.description || ''}${params ? ' 参数规范: ' + JSON.stringify(params) : ''}`;
    }).join('\n');
    let toolDefs = fullDefs;
    if (Buffer.byteLength(toolDefs, 'utf8') > TOOL_HINT_MAX_BYTES) {
      // compact fallback: names + first line of description only
      toolDefs = custom.map((t) => {
        const fn = t.function || t;
        const desc = String(fn.description || '').split('\n')[0].slice(0, 120);
        return `- ${fn.name}: ${desc}`;
      }).join('\n');
    }
    if (custom.length) {
      prompt = (prompt ? prompt + '\n\n' : '') + `可用自定义工具列表(调用协议在本提示中,不在沙盒文档里):\n${toolDefs}\n\n工具调用协议(严格遵守):
1. 你没有内置工具,也没有任何可执行环境。用户要求执行命令、读写文件、搜索网页、计算等操作时,必须调用上面的自定义工具,绝不能假装自己执行了。
2. 禁止使用或提及任何内置沙盒工具(run_command、run_python、read_file、upload_file、search 等)。
3. 仅当用户请求的操作确实需要调用工具时,输出一个 JSON 对象,不要输出任何其他文字、解释、markdown 代码块或思考过程:\n{"tool":"工具名称","arguments":{...}}
4. 当用户的问题可以直接回答时,正常用自然语言回答,不要输出 JSON,不要假装调用过工具。
5. 一次只调用一个工具。调用后停止,等待用户提供工具结果,再根据结果继续。
6. 工具调用 JSON 必须作为最终回复内容输出,绝不能放在思考(reasoning)过程中。
7. 沙盒附件(context_document 等)只包含用户的任务内容,与工具调用无关——不要在沙盒中寻找或读取工具定义。`;
    }
  }

  const messageId = body.message_id || randomUUID();

  return {
    sakanaModel, toneMode, enableThinking, webSearchEnabled,
    prompt, files, messageId, userMessageId, isRetry, isContinue,
    conversationId: body.conversation_id || body.chat_id || body.thread_id || null,
    tools: body.tools || null,
    clientToolNames,
    isToolTurn: toolResults.length > 0,
    isRP: false,
    route,
  };
}

/** Round-1 prompt for the code/writer search→think chain: collect sources,
 *  keep the answer short so the thinking round stays the real generation. */
function buildSearchChainPrompt(sakanaReq) {
  const question = String(sakanaReq.prompt || '').slice(-4000);
  return [
    '请联网检索与以下任务相关的最新资料。只输出检索到的关键事实与来源列表(标题+URL+一句话摘要),不要展开长篇回答,不要进行分析:',
    '',
    question,
  ].join('\n');
}

/**
 * Structured long-context packaging (sakana-context/1). Keeps role turn
 * boundaries so the model can stay coherent across a long conversation;
 * plain string/array OpenAI content shapes are flattened to text with
 * attachment placeholders preserved.
 */
function buildJsonContextDocument(body, prompt) {
  const turns = [];
  let systemText = '';
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || 'user');
    let content = '';
    if (typeof message.content === 'string') {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content.map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text') return String(part.text || '');
        if (part.type === 'image_url') return '[图片附件]';
        if (part.type === 'file') return `[附件: ${part.name || 'file'}]`;
        if (part.type === 'tool_call') return `[工具调用${part.name ? ' (' + part.name + ')' : ''}]`;
        if (part.type === 'tool_result') return `[工具结果]`;
        return `[${part.type || 'part'}]`;
      }).filter(Boolean).join('\n');
    }
    if (role === 'system') {
      systemText = systemText ? systemText + '\n\n' + content : content;
      continue;
    }
    turns.push({ role, content });
  }
  // Fallback for prompt-only shapes (legacy completions / pre-assembled text).
  if (!turns.length && prompt) turns.push({ role: 'user', content: prompt });
  return {
    schema: 'sakana-context/1',
    meta: { generatedAt: new Date().toISOString(), turns: turns.length },
    system: systemText,
    turns,
  };
}

/** Render chain-round citations as a bounded context block for round 2. */
function renderChainSources(citations, maxBytes = 8000) {
  const lines = [];
  let bytes = 0;
  for (const c of Array.isArray(citations) ? citations : []) {
    if (!c || !c.url) continue;
    const line = `- ${c.title || 'source'}: ${c.url}${c.snippet ? ' — ' + String(c.snippet).slice(0, 200) : ''}`;
    bytes += Buffer.byteLength(line, 'utf8');
    if (bytes > maxBytes) break;
    lines.push(line);
  }
  if (!lines.length) return '';
  return `[检索资料 — 以下是第一轮联网检索到的来源,回答时参考这些资料,并在适当位置标注来源]\n${lines.join('\n')}`;
}

/** Normalize a citation URL for dedup: strip tracking params + fragment so the
 *  same article reached via different query strings collapses to one source. */
function normalizeCitationUrl(url) {
  const raw = String(url || '');
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k) || k === 'ref' || k === 'ref_src') u.searchParams.delete(k);
    }
    u.hash = '';
    return u.origin + u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
  } catch {
    return raw;
  }
}

/** OpenAI-style annotations projection of a citation list (Chat Completions
 *  clients that understand `annotations` read sources from here instead of
 *  the custom `citations` field). */
function citationsToAnnotations(citations) {
  return (Array.isArray(citations) ? citations : [])
    .filter((c) => c && c.url)
    .map((c) => ({ type: 'url_citation', url: c.url, title: c.title || '' }));
}

/** Merge citation lists across rounds/translator swaps, keeping first-seen
 *  order and de-duplicating by normalized URL. */
function mergeCitations(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const c of Array.isArray(list) ? list : []) {
      const key = normalizeCitationUrl(c && c.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

// Helper: Parse generative JSON / Tagged tool calls from model output.
// Strategy tiers:
//   1. Tagged format: <tool_call>...</tool_call> / <function_call>...</function_call>
//   2. Whole-output markdown JSON block (```json ... ``` or bare object/array)
//   3. Embedded scan: brace-balanced, string-literal-aware walk from every
//      '{' / '[' candidate that looks like a tool call (capped at 100), so
//      calls buried in prose or markdown ("结果如下:{"tool":"get_weather",...}")
//      are still surfaced to clients.
function extractJsonToolCalls(text) {
  if (!text || typeof text !== 'string') return null;
  const calls = [];

  const pushCall = (item) => {
    if (!item || typeof item !== 'object') return;
    const name = item.name || item.tool || (item.function && item.function.name);
    const args = item.arguments || item.parameters || (item.function && item.function.arguments) || {};
    if (name && typeof name === 'string' && name !== 'finalizing') {
      calls.push({
        name: String(name),
        arguments: typeof args === 'object' ? JSON.stringify(args) : String(args || '{}'),
      });
    }
  };

  // 1. Tagged format: <tool_call>...</tool_call> or <function_call>...</function_call>
  const tagRegex = /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(text)) !== null) {
    try { pushCall(JSON.parse(tagMatch[1].trim())); } catch {}
  }
  if (calls.length > 0) return calls;

  // 2. Markdown block: ```json ... ``` or bare JSON object/array spanning the output
  const blockMatch = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text) ||
                     /^\s*(\[[\s\S]*\]|\{[\s\S]*\})\s*$/i.exec(text);
  if (blockMatch) {
    try {
      const parsed = JSON.parse(blockMatch[1].trim());
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(pushCall);
    } catch {}
  }
  if (calls.length > 0) return calls;

  // 3. Embedded scan: for each '{' / '[' candidate, do a balanced scan that
  //    understands string literals, and JSON.parse the captured slice.
  const scanFrom = (start) => {
    const open = text[start];
    const depth = { '{': 0, '[': 0 };
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{' || ch === '[') depth[ch]++;
      else if (ch === '}' || ch === ']') {
        const pair = ch === '}' ? '{' : '[';
        if (--depth[pair] < 0) return null;
        if (depth[pair] === 0 && pair === open) return text.slice(start, i + 1);
      }
    }
    return null;
  };

  let candidates = 0;
  for (let i = 0; i < text.length && candidates < 100; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    // Cheap pre-filter: a likely tool-call object mentions a key we map from.
    const snippet = text.slice(i, Math.min(i + 120, text.length));
    if (!/"(?:tool|name|function|action|args|arguments|parameters)"/.test(snippet)) continue;
    candidates++;
    const json = scanFrom(i);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json);
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(pushCall);
    } catch {}
  }

  return calls.length > 0 ? calls : null;
}

// ---- NDJSON -> OpenAI SSE chunks -------------------------------------------

// 上游安全停止文本(日语):模型输出被内容过滤器打断时的固定话术。
// 对 API 客户端无意义,整段剥离;可能跨 token 拆分,由 _safetyHold 暂存拼全。
const SAFETY_STOP_TEXT = '安全でない入出力が検出されたため、回答を停止しました。';

class NdjsonTranslator {
  constructor(opts = {}) {
    this.assistantMessageId = 'chatcmpl-' + randomUUID().replace(/-/g, '');
    this.sentFinish = false;
    this.sentContent = false;
    this.toolCalls = new Map();
    this.toolState = new ToolCallState();
    this.events = new TurnEventBuffer();
    this.contentBuffer = '';
    this.citations = [];
    this.inThinkingTag = false;
    this._cleanPrev = '';
    this._stream = '';
    this.hasToolCalls = false;
    this.nativeToolRound = false;
    this.clientToolRound = false;
    // 客户端声明的工具名:模型发出的 toolCall 事件若不在其中(或为 functions.*
    // 原生沙盒 id)一律抑制,只有从正文 JSON 提取的声明工具调用才透传给客户端。
    this.declaredTools = new Set((opts.declaredTools || []).map((n) => String(n)));
    this.promptTokens = opts.promptTokens || 0;
    this._seenChars = 0;
    this._safetyHold = '';
    // 工具回合 JSON 候选抑制状态:客户端声明了 tools 时,模型流式输出的
    // 工具调用 JSON({...})被缓冲,不当作 content 外发——它会在 finalAnswer
    // 阶段被提取为 tool_calls delta(Astrbot 等客户端不会看到乱 JSON 文本)。
    this._jsonCandidate = false;
    this._jsonFlushed = false;
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
    // 上游安全停止文本剥离:完整命中整段剔除;尾部若为安全文本前缀则暂存,
    // 等下一 token 拼全后再剔除(避免跨 token 拆分漏网)。
    let text = (this._safetyHold || '') + clean(delta);
    this._safetyHold = '';
    if (text.includes(SAFETY_STOP_TEXT)) {
      text = text.split(SAFETY_STOP_TEXT).join('');
    } else {
      for (let n = Math.min(SAFETY_STOP_TEXT.length - 1, text.length); n >= 1; n--) {
        if (text.endsWith(SAFETY_STOP_TEXT.slice(0, n))) {
          this._safetyHold = text.slice(text.length - n);
          text = text.slice(0, text.length - n);
          break;
        }
      }
    }
    this._stream = (this._stream || '') + text;
    let held = this._stream;

    // 工具回合 JSON 候选抑制(仅当客户端声明了 tools):
    // 模型流式输出工具调用 JSON 时,缓冲不发出,等 finalAnswer 提取为
    // tool_calls;若中途出现换行或超过 8K(自然语言信号)则判定不是 JSON,
    // flush 缓冲走常规发射。回合结束(finalAnswer/finish)重置。
    if (this.declaredTools.size > 0 && !this._jsonFlushed) {
      if (!this._jsonCandidate) {
        const t = held.trimStart();
        if ((t.startsWith('{') || t.startsWith('[')) && !/[\r\n]/.test(held)) {
          this._jsonCandidate = true;
        }
      }
      if (this._jsonCandidate) {
        if (/[\r\n]/.test(held) || held.length > 8192) {
          this._jsonCandidate = false;
          this._jsonFlushed = true;
        } else {
          return out; // JSON 候选缓冲中,不发任何 content delta
        }
      }
    }

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
              this.events.push(contentDelta(outDelta));
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
          if (outDelta) {
            this.events.push(contentDelta(outDelta));
            out.push({ choices: [{ index: 0, delta: { content: outDelta }, finish_reason: null }] });
          }
          break;
        }
      } else {
        const thinkClose = cleaned.indexOf('</thinking>');
        if (thinkClose !== -1) {
          const thinkText = cleaned.slice(0, thinkClose);
          if (thinkText) {
            this.events.push(reasoningDelta(thinkText));
            out.push({ choices: [{ index: 0, delta: { reasoning_content: thinkText }, finish_reason: null }] });
          }
          this.inThinkingTag = false;
          cleaned = cleaned.slice(thinkClose + 11);
          this._cleanPrev = '';
        } else {
          // All remaining text is thinking reasoning
          this.events.push(reasoningDelta(cleaned));
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
        const visible = this._emitContent(token);
        if (visible.some((chunk) => chunk.choices?.[0]?.delta?.content)) this.sentContent = true;
        this._seenChars += visible.reduce((sum, chunk) => sum + (chunk.choices?.[0]?.delta?.content || '').length + (chunk.choices?.[0]?.delta?.reasoning_content || '').length, 0);
        out.push(...visible);
        break;
      }
      case 'reasoning': {
        const t = clean(obj.token);
          if (t) {
            this.events.push(reasoningDelta(t));
            out.push({ choices: [{ index: 0, delta: { reasoning_content: t }, finish_reason: null }] });
          }
        break;
      }
      case 'finalAnswer': {
        const text = clean(obj.text);
        if (text) {
          // 回合结束:重置 JSON 候选状态(下个回合重新判断)
          this._jsonCandidate = false;
          this._jsonFlushed = false;
          this._extractCitations(text);
          let cleaned = stripChips(text);
          // 安全停止文本整段剥离(纯安全文本时 cleaned 为空 → 不置 sentContent,
          // 服务端自动续轮重试)
          if (cleaned.includes(SAFETY_STOP_TEXT)) cleaned = cleaned.split(SAFETY_STOP_TEXT).join('').trim();
          if (cleaned) {
            this.sentContent = true;
            this._seenChars += cleaned.length;

            // Strip any residual <thinking>...</thinking>
            const thinkMatch = /<thinking>([\s\S]*?)<\/thinking>/i.exec(cleaned);
            if (thinkMatch) {
              this.events.push(reasoningDelta(thinkMatch[1]));
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
                this.toolState.start({ id, index: idx, name: tc.name, arguments: tc.arguments });
                this.events.push(toolCallStart({ id, index: idx, name: tc.name, arguments: tc.arguments }));
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
            if (delta) {
              this.events.push(contentDelta(delta));
              out.push({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
            }
            this._cleanPrev = cleaned;
            this._stream = '';
          }
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
        // 原生搜索事件 → 合成 reasoning 增量,让客户端在思维链里看到"正在搜索"
        if (name === 'search' || name === 'web_search' || name === 'websearch') {
          this.nativeToolRound = true;
          const raw = tc.input;
          let q = '';
          if (typeof raw === 'string') q = raw;
          else if (raw && typeof raw === 'object') q = raw.query || raw.query_string || raw.q || raw.keyword || Object.values(raw)[0] || '';
          if (typeof q !== 'string') q = JSON.stringify(q);
          q = q.trim();
          if (q) {
            this.events.push(searchStarted(q));
            out.push({ choices: [{ index: 0, delta: { reasoning_content: '🔍 [Web 搜索] 正在搜索: ' + q }, finish_reason: null }] });
            this._seenChars += q.length;
          }
          break;
        }
        // 原生沙盒工具(functions.*)或客户端未声明的工具调用:完全抑制,
        // 不产生客户端 tool_calls delta,由服务端透明续轮直到模型给出正文。
        if (/^functions\./.test(id) || !this.declaredTools.has(name)) {
          this.nativeToolRound = true;
          break;
        }
        this.hasToolCalls = true;
        let args = '';
        if (tc.input !== undefined) args = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
        else if (tc.arguments !== undefined) args = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
        if (!args) args = '{}';
        const prev = this.toolCalls.get(id);
        if (prev) {
          this.toolState.append(id, args);
          this.events.push(toolCallDelta({ id, index: prev.index, arguments: args }));
          out.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: prev.index, id, function: { arguments: args } }] }, finish_reason: null }] });
        } else {
          const index = this.toolCalls.size;
          this.toolCalls.set(id, { index, name, args });
          this.toolState.start({ id, index, name, arguments: args });
          this.events.push(toolCallStart({ id, index, name, arguments: args }));
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
                this.events.push(searchSource(s));
                seen.add(key);
                this.events.push(reasoningDelta(`📄 [搜索结果] ${s.title} — ${s.url}`, 'search'));
                out.push({ choices: [{ index: 0, delta: { reasoning_content: `📄 [搜索结果] ${s.title} — ${s.url}` }, finish_reason: null }] });
              }
            }
          }
        }
        break;
      }
      case 'file': {
        const outputFile = { name: obj.name, sha: clean(obj.sha), mime: obj.mime };
        this.events.push(fileOutput(outputFile));
        out.push({ choices: [{ index: 0, delta: { file_output: outputFile, content: '' }, finish_reason: null }] });
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
    const out = [];
    // 尾部暂存的安全文本前缀:>=3 字符且确为安全文本前缀 → 视为被截断的安全
    // 文本直接丢弃;过短的可能是正文结尾,补发为内容增量。
    if (this._safetyHold) {
      const isTruncatedSafety = this._safetyHold.length >= 3 && SAFETY_STOP_TEXT.startsWith(this._safetyHold);
      if (!isTruncatedSafety) {
        this.sentContent = true;
        out.push({ choices: [{ index: 0, delta: { content: this._safetyHold }, finish_reason: null }] });
      }
      this._safetyHold = '';
    }
    // 流被截断时(未到 finalAnswer),把 JSON 候选缓冲 flush 为 content,避免丢正文
    if (this._jsonCandidate && this._stream) {
      const held = this._stream;
      this._stream = '';
      this._jsonCandidate = false;
      this._seenChars += held.length;
      out.push({ choices: [{ index: 0, delta: { content: held }, finish_reason: null }] });
    }
    const finishReason = this.hasToolCalls ? 'tool_calls' : 'stop';
    this.events.push(finishEvent(finishReason));
    const chunk = { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
    if (this.citations.length) chunk.citations = this.citations;
    out.push(chunk);
    // 独立流尾 usage chunk(choices 为空数组):OpenAI 官方规范 + AstrBot
    // #8306 显式放行该格式;SDK 靠它记录 token 消耗。
    const completionTokens = Math.max(1, Math.round(this._seenChars / 4));
    const usage = {
      prompt_tokens: this.promptTokens,
      completion_tokens: completionTokens,
      total_tokens: this.promptTokens + completionTokens,
    };
    this.events.push(usageEvent(usage));
    out.push({
      choices: [],
      usage,
    });
    return out;
  }
}

// ---- helpers ---------------------------------------------------------------

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

module.exports = {
  MODELS,
  MODEL_PROFILES,
  RP_MODEL_ERROR_CODE,
  RP_MODEL_ERROR_MESSAGE,
  isRPModelName,
  createRpModelError,
  assertStandardModel,
  normalizedMessagesToPrompt,
  openaiRequestToSakana,
  NdjsonTranslator,
  sse,
  dataUrlToParts,
  isDataUrl,
  clean,
  stripChips,
  parseModel,
  extractFileContent,
  sniffMimeType,
  extractJsonToolCalls,
  buildSearchChainPrompt,
  renderChainSources,
  mergeCitations,
  normalizeCitationUrl,
  citationsToAnnotations,
  buildTranslateProfilePrompt,
  buildJsonContextDocument,
};