// Gemini API 兼容层 —— 让 SillyTavern/RisuAI 等 Gemini 协议 RP 客户端
// 直接对接本代理。
//
// 入站:POST /v1beta/models/{model}:generateContent | :streamGenerateContent
//   请求头:x-goog-api-key / x-api-key / api-key / Authorization: Bearer
//   请求体:{ contents:[{role,parts:[{text|inlineData|functionCall}]}],
//            systemInstruction, generationConfig, safetySettings, tools }
//   也接受 OpenAI messages 体(双向兼容,自动嗅探)。
// 出站:GenerateContentResponse JSON 或 Gemini SSE(data: {candidates:[...]})。
//
// 出站转换通过 createGeminiResponseAdapter 实现:它伪装成 res 对象接入现有
// OpenAI 管线(handleChatBody),把 SSE/JSON 输出实时翻译成 Gemini 协议,
// 从而完整复用管线的重试/工具续轮/审计/会话粘性逻辑。

const { MODELS } = require('./translate');

/** 默认上游模型(Gemini 客户端的请求一律落到 RP 完全破限链路) */
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_DEFAULT_MODEL || 'sakana-namazu-rp';

/** 判断请求体是否为 Gemini generateContent 格式 */
function isGeminiBody(body) {
  return !!(body && Array.isArray(body.contents));
}

/**
 * 把 Gemini 模型名映射到本代理模型。
 *  1. 名字本身就是本代理模型 id → 直接用
 *  2. 名字含 namazu/fugu 关键词 → 匹配到的代理模型
 *  3. 其它(gemini-2.5-flash 之类)→ GEMINI_DEFAULT_MODEL
 */
function mapGeminiModel(name) {
  const raw = String(name || '').replace(/^models\//, '').toLowerCase();
  const ours = MODELS.find((m) => m.id === raw);
  if (ours) return ours.id;
  if (/namazu|fugu|sakana/.test(raw)) {
    const hit = MODELS.find((m) => raw.includes(m.id) || m.id.includes(raw));
    if (hit) return hit.id;
  }
  const def = DEFAULT_GEMINI_MODEL.toLowerCase();
  return MODELS.some((m) => m.id === def) ? def : 'sakana-namazu-rp';
}

/** Gemini parts -> 文本 + OpenAI 风格 content 数组(图片/文件) */
function partsToContent(parts) {
  let text = '';
  const rich = [];
  for (const part of parts || []) {
    if (!part) continue;
    if (typeof part.text === 'string') { text += part.text; continue; }
    const inline = part.inlineData || part.inline_data;
    if (inline && inline.data) {
      const mime = inline.mimeType || inline.mime_type || 'image/png';
      rich.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${inline.data}` } });
      continue;
    }
    const fileData = part.fileData || part.file_data;
    if (fileData && (fileData.fileUri || fileData.file_uri)) {
      rich.push({ type: 'image_url', image_url: { url: fileData.fileUri || fileData.file_uri } });
      continue;
    }
    if (part.functionCall || part.function_call) {
      text += '\n[tool_call] ' + JSON.stringify(part.functionCall || part.function_call);
      continue;
    }
    if (part.functionResponse || part.function_response) {
      const fr = part.functionResponse || part.function_response;
      text += '\n[tool_result] ' + JSON.stringify(fr.response ?? fr.result ?? fr);
      continue;
    }
    // thoughtSignature 等控制字段直接忽略
  }
  return { text, rich };
}

/**
 * Gemini generateContent 请求体 -> OpenAI chat.completions 请求体。
 * 透传扩展字段(character_id / rp_preset / rp_nsfw / conversation_id 等)。
 */
function geminiRequestToChat(body, { model, stream } = {}) {
  const messages = [];
  const sys = body.systemInstruction || body.system_instruction;
  if (sys) {
    const sysParts = Array.isArray(sys.parts) ? sys.parts : [{ text: typeof sys === 'string' ? sys : '' }];
    const sysText = sysParts.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
    if (sysText.trim()) messages.push({ role: 'system', content: sysText });
  }
  for (const c of body.contents || []) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const { text, rich } = partsToContent(c.parts);
    if (!text && !rich.length) continue;
    const content = rich.length ? [...rich, ...(text ? [{ type: 'text', text }] : [])] : text;
    messages.push({ role, content });
  }
  // Gemini RP 客户端重放全量历史;上游历史由会话粘性承载,只吃最后一条 user。
  // 末尾是 assistant 轮(客户端把上一轮回复带上来了)→ 剥掉让模型重新生成。
  while (messages.length && messages[messages.length - 1].role === 'assistant') messages.pop();
  if (!messages.some((m) => m.role === 'user')) messages.push({ role: 'user', content: '(请继续)' });

  const gc = body.generationConfig || body.generation_config || {};
  const chatBody = { model: mapGeminiModel(model || body.model), messages, stream: !!stream };
  if (typeof gc.temperature === 'number') chatBody.temperature = gc.temperature;
  if (typeof gc.topP === 'number') chatBody.top_p = gc.topP;
  if (typeof gc.maxOutputTokens === 'number') chatBody.max_tokens = Math.min(gc.maxOutputTokens, 65535);
  if (Array.isArray(gc.stopSequences) && gc.stopSequences.length) chatBody.stop = gc.stopSequences;
  // safetySettings 不需要翻译:破限由 RP 预设承担。
  for (const k of ['conversation_id', 'chat_id', 'thread_id', 'character_id', 'rp_preset', 'rp_nsfw', 'rp_length', 'web_search', 'thinking']) {
    if (body[k] !== undefined) chatBody[k] = body[k];
  }
  return chatBody;
}

// ---- Gemini 出站构造 -------------------------------------------------------

const GEMINI_STATUS = {
  400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL',
  502: 'UNAVAILABLE', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED',
};

function geminiErrorBody(status, message) {
  return {
    error: {
      code: status,
      message: String(message || '').slice(0, 500),
      status: GEMINI_STATUS[status] || 'INTERNAL',
    },
  };
}

/** 非流式 OpenAI completion -> Gemini GenerateContentResponse */
function openAiCompletionToGemini(resp, model) {
  if (resp && resp.error && !resp.choices) {
    return { _geminiError: geminiErrorBody(resp.error.code === 'EMPTY-RESPONSE' ? 503 : 500, resp.error.message) };
  }
  const msg = (resp && resp.choices && resp.choices[0] && resp.choices[0].message) || {};
  const parts = [];
  if (msg.reasoning_content) parts.push({ text: msg.reasoning_content, thought: true });
  parts.push({ text: msg.content || '' });
  return {
    candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: {
      promptTokenCount: (resp && resp.usage && resp.usage.prompt_tokens) || 0,
      candidatesTokenCount: (resp && resp.usage && resp.usage.completion_tokens) || 0,
      totalTokenCount: (resp && resp.usage && resp.usage.total_tokens) || 0,
    },
    modelVersion: model || DEFAULT_GEMINI_MODEL,
  };
}

/** 单个 OpenAI SSE chunk(data 对象) -> Gemini SSE 事件对象数组 */
function openAiChunkToGemini(chunkData, model) {
  const out = [];
  if (chunkData && chunkData.error) {
    out.push({ _geminiError: geminiErrorBody(500, chunkData.error.message) });
    return out;
  }
  const choice = chunkData && chunkData.choices && chunkData.choices[0];
  if (!choice) return out;
  const delta = choice.delta || {};
  const parts = [];
  if (delta.reasoning_content) parts.push({ text: delta.reasoning_content, thought: true });
  if (delta.content) parts.push({ text: delta.content });
  if (parts.length) {
    out.push({ candidates: [{ content: { parts, role: 'model' }, index: 0 }], modelVersion: model });
  }
  if (choice.finish_reason) {
    out.push({
      candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }],
      modelVersion: model,
    });
  }
  return out;
}

/**
 * 响应适配器:把内部 OpenAI 管线的输出(写往 res 的 SSE/JSON)实时翻译为
 * Gemini 协议输出。实现了管线用到的最小 res 接口:
 * writeHead / setHeader / write / end / headersSent。
 */
function createGeminiResponseAdapter(realRes, { model }) {
  let mode = null; // 'stream' | 'json'
  let statusCode = 200;
  let sentStop = false;
  let buf = '';
  let jsonBuf = '';
  let outChars = 0; // 输出字符计数(用于流式 usageMetadata 估算)
  const extraHeaders = {};

  const emit = (obj) => {
    try { realRes.write(`data: ${JSON.stringify(obj._geminiError || obj)}\n\n`); } catch {}
  };
  const usageMeta = () => ({
    promptTokenCount: 0,
    candidatesTokenCount: Math.round(outChars / 4),
    totalTokenCount: Math.round(outChars / 4),
  });
  const stopChunk = () => ({
    candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: usageMeta(),
    modelVersion: model,
  });

  return {
    get headersSent() { return realRes.headersSent; },
    setHeader(k, v) {
      if (String(k).toLowerCase() === 'x-conversation-id') extraHeaders['x-conversation-id'] = String(v);
    },
    writeHead(status, headers = {}) {
      statusCode = status;
      const ct = String(headers['content-type'] || headers['Content-Type'] || '');
      if (ct.includes('text/event-stream')) {
        mode = 'stream';
        if (!realRes.headersSent) {
          realRes.writeHead(200, {
            'content-type': 'text/event-stream; charset=UTF-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            'x-content-type-options': 'nosniff',
            ...extraHeaders,
          });
        }
      } else {
        mode = 'json';
        jsonBuf = '';
      }
    },
    write(chunk) {
      const s = chunk == null ? '' : String(chunk);
      if (mode !== 'stream') { jsonBuf += s; return true; }
      buf += s;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const payload = dataLine.slice(6);
        if (payload === '[DONE]') continue;
        let parsed = null;
        try { parsed = JSON.parse(payload); } catch { continue; }
        for (const g of openAiChunkToGemini(parsed, model)) {
          if (g._geminiError) { emit(g); continue; }
          if (g.candidates && g.candidates[0] && g.candidates[0].finishReason) {
            sentStop = true;
            // 收尾块带 usageMetadata(与 Gemini 官方流一致)
            g.usageMetadata = usageMeta();
          }
          if (g.candidates && g.candidates[0] && g.candidates[0].content && g.candidates[0].content.parts) {
            for (const part of g.candidates[0].content.parts) {
              if (part && typeof part.text === 'string' && !part.thought) outChars += part.text.length;
            }
          }
          emit(g);
        }
      }
      return true;
    },
    end(chunk) {
      if (chunk != null) this.write(chunk);
      if (mode === 'stream') {
        if (!sentStop && statusCode === 200) {
          emit(stopChunk());
        }
        try { realRes.end(); } catch {}
        return;
      }
      // JSON 路径:整包翻译
      let parsed = null;
      try { parsed = JSON.parse(jsonBuf || '{}'); } catch {}
      if (statusCode >= 400) {
        const msg = (parsed && parsed.error && parsed.error.message) || 'HTTP ' + statusCode;
        realRes.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...extraHeaders });
        try { realRes.end(JSON.stringify(geminiErrorBody(statusCode, msg))); } catch {}
        return;
      }
      const gem = openAiCompletionToGemini(parsed, model);
      if (gem._geminiError) {
        realRes.writeHead(503, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
        try { realRes.end(JSON.stringify(gem._geminiError)); } catch {}
        return;
      }
      realRes.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
      try { realRes.end(JSON.stringify(gem)); } catch {}
    },
  };
}

/** Gemini /v1beta/models 列表(带 token 限制,供客户端上下文裁剪参考) */
function geminiModelList() {
  return {
    models: MODELS.map((m) => ({
      name: 'models/' + m.id,
      displayName: m.description || m.id,
      description: m.description || '',
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      inputTokenLimit: 1000000,
      outputTokenLimit: 65536,
    })),
  };
}

/** 单模型详情;不存在返回 null */
function geminiModelDetail(name) {
  const id = String(name || '').replace(/^models\//, '').toLowerCase();
  const m = MODELS.find((x) => x.id === id);
  if (!m) return null;
  return {
    name: 'models/' + m.id,
    displayName: m.description || m.id,
    description: m.description || '',
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    inputTokenLimit: 1000000,
    outputTokenLimit: 65536,
  };
}

/** 解析 Gemini 路由:/v1beta/models/{model}:generateContent 等 */
function parseGeminiRoute(pathname) {
  const m = /^(?:\/gemini)?\/(?:v1beta|v1)\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(pathname);
  if (!m) return null;
  return { model: decodeURIComponent(m[1]), action: m[2] };
}

module.exports = {
  isGeminiBody,
  mapGeminiModel,
  partsToContent,
  geminiRequestToChat,
  openAiCompletionToGemini,
  openAiChunkToGemini,
  createGeminiResponseAdapter,
  geminiErrorBody,
  geminiModelList,
  geminiModelDetail,
  parseGeminiRoute,
  DEFAULT_GEMINI_MODEL,
};
