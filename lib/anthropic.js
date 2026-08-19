'use strict';
// Anthropic Messages API <-> OpenAI chat/completions 双向转换器。
// 覆盖:
//   - 请求侧: tool_use/tool_result 块 ↔ tool_calls / role:tool 消息;
//     Anthropic tools(input_schema) 原样透传(translate.js 的提示词构建
//     同时读取 fn.parameters 与 fn.input_schema,两种格式都能驱动模型)。
//   - 响应侧: 非流式 tool_calls → tool_use 块;流式 tool_calls delta →
//     Anthropic 事件序列(content_block_start → input_json_delta →
//     content_block_stop → message_delta → message_stop)。

/** Anthropic 请求体(messages/system/tools) → OpenAI chat.completions 请求体 */
function anthropicToChat(body = {}) {
  const messages = [];

  // system:字符串或 {type:'text',text} 块数组 → 首条 system 消息
  const sysText = Array.isArray(body.system)
    ? body.system.map((s) => (typeof s === 'string' ? s : (s && s.text) || '')).join('\n')
    : body.system ? String(body.system) : '';
  if (sysText) messages.push({ role: 'system', content: sysText });

  const input = Array.isArray(body.messages) ? body.messages : [];
  for (const m of input) {
    if (!m || typeof m !== 'object' || !m.role) continue;
    if (m.role === 'assistant') {
      const textParts = [];
      const toolUses = [];
      if (typeof m.content === 'string') {
        if (m.content) textParts.push(m.content);
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_use') toolUses.push(b);
          else if (b.type === 'text' && b.text) textParts.push(b.text);
        }
      }
      const msg = { role: 'assistant', content: textParts.join('') };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((tc, i) => ({
          id: tc.id || 'call_' + Math.random().toString(36).slice(2, 12),
          index: i,
          type: 'function',
          function: {
            name: tc.name || '',
            arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
          },
        }));
      }
      messages.push(msg);
    } else if (m.role === 'user') {
      const parts = [];
      const toolResults = [];
      if (typeof m.content === 'string') {
        parts.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_result') {
            let txt = '';
            if (typeof b.content === 'string') txt = b.content;
            else if (Array.isArray(b.content)) txt = b.content.map((p) => (p && (p.text || p.content)) || '').join('\n');
            else if (b.content !== undefined && b.content !== null) txt = JSON.stringify(b.content);
            toolResults.push({ role: 'tool', tool_call_id: b.tool_use_id || '', name: b.name || '', content: txt });
          } else if (b.type === 'text') {
            parts.push({ type: 'text', text: b.text || '' });
          } else {
            // image / document 等块原样透传(translate.js 已支持这两种格式)
            parts.push(b);
          }
        }
      }
      if (parts.length) messages.push({ role: 'user', content: parts });
      if (toolResults.length) messages.push(...toolResults);
    } else {
      // 未知角色(如 tool / system)尽力透传,保持上游 pipeline 兼容
      messages.push(m);
    }
  }

  const out = { model: body.model, messages };
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.metadata) out.metadata = body.metadata;

  // Anthropic tools → OpenAI functions(保留 input_schema 键,见文件头注释)
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => {
      if (!t || typeof t !== 'object') return t;
      const name = t.name || (t.function && t.function.name);
      const description = t.description || (t.function && t.function.description) || '';
      const inputSchema = t.input_schema || (t.function && t.function.input_schema) || { type: 'object', properties: {} };
      return { type: 'function', function: { name, description, input_schema: inputSchema } };
    });
  }
  // tool_choice:{type:'auto'|'any'|'tool',name} → OpenAI 三态
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
      out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    } else if (body.tool_choice.type === 'any') {
      out.tool_choice = 'required';
    } else if (body.tool_choice.type === 'none') {
      out.tool_choice = 'none';
    } else {
      out.tool_choice = 'auto';
    }
  }
  return out;
}

/** OpenAI chat.completions 非流式响应 → Anthropic Message 对象 */
function chatToAnthropicNonStream(resp = {}) {
  const choice = resp.choices && resp.choices[0];
  const msg = (choice && choice.message) || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = tc.function.arguments || {}; }
      content.push({
        type: 'tool_use',
        id: tc.id || 'call_' + Math.random().toString(36).slice(2, 12),
        name: tc.function.name || '',
        input,
      });
    }
  }
  const stopReason = choice && choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
  return {
    id: 'msg_' + Math.random().toString(36).slice(2, 14),
    type: 'message',
    role: 'assistant',
    model: resp.model || 'sakana-namazu',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: (resp.usage && resp.usage.prompt_tokens) || 0,
      output_tokens: (resp.usage && resp.usage.completion_tokens) || 0,
    },
  };
}

/**
 * OpenAI 流式 chunk → Anthropic 事件(无状态单步转换;多轮流式请用
 * AnthropicStreamer 保持跨 chunk 状态)。
 */
function openAiChunkToAnthropicEvents(chunk, messageId) {
  const out = [];
  const choice = chunk.choices && chunk.choices[0];
  if (!choice) return out;
  const d = choice.delta || {};
  if (d.content) {
    out.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d.content } },
    );
  }
  if (Array.isArray(d.tool_calls)) {
    for (const tc of d.tool_calls) {
      const idx = tc.index || 0;
      if (tc.id && tc.function && tc.function.name) {
        out.push({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
      }
      if (tc.function && tc.function.arguments) {
        out.push({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
      }
    }
  }
  if (choice.finish_reason) {
    out.push({
      type: 'message_delta',
      delta: { stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: {},
    });
    out.push({ type: 'message_stop' });
  }
  return out;
}

/**
 * 有状态 Anthropic 流式转换器:一个实例消费一条 OpenAI 流的所有 chunk,
 * 维护 text/tool_use 块的 start/stop 状态,产出完整合规的事件序列。
 * 用法:先 start() 发 message_start,再对每个 chunk push() 发后续事件。
 */
class AnthropicStreamer {
  constructor(opts = {}) {
    this.model = opts.model || 'sakana-namazu';
    this.messageId = opts.messageId || 'msg_' + Math.random().toString(36).slice(2, 14);
    this.blocks = new Map(); // 块 index → { type:'text'|'tool_use', started, stopped, name, id }
    this.textSeen = false;
    this.stopped = false;
  }

  start() {
    return {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  }

  push(chunk) {
    if (this.stopped) return [];
    const out = [];
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return out;
    const d = choice.delta || {};

    // 文本增量:text 块固定 index 0(若先于工具块出现)
    if (d.content) {
      if (!this.textSeen) {
        this.textSeen = true;
        this.blocks.set(0, { type: 'text', started: true, stopped: false });
        out.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      }
      out.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d.content } });
    }

    // 工具调用增量:每个 OpenAI tool index 映射一个 Anthropic 块
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const bi = (this.textSeen ? 1 : 0) + (tc.index || 0);
        let block = this.blocks.get(bi);
        if (!block || !block.started) {
          block = {
            type: 'tool_use', started: true, stopped: false,
            name: (tc.function && tc.function.name) || '',
            id: tc.id || 'call_' + Math.random().toString(36).slice(2, 12),
          };
          this.blocks.set(bi, block);
          out.push({ type: 'content_block_start', index: bi, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
        }
        const argStr = tc.function && tc.function.arguments;
        if (argStr) out.push({ type: 'content_block_delta', index: bi, delta: { type: 'input_json_delta', partial_json: argStr } });
      }
    }

    // 收尾:所有已开始块 stop → message_delta(stop_reason) → message_stop
    if (choice.finish_reason) {
      this.stopped = true;
      for (const [bi, b] of this.blocks) {
        if (!b.stopped) {
          b.stopped = true;
          out.push({ type: 'content_block_stop', index: bi });
        }
      }
      out.push({
        type: 'message_delta',
        delta: { stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: chunk.usage ? { output_tokens: chunk.usage.completion_tokens || 0 } : {},
      });
      out.push({ type: 'message_stop' });
    }
    return out;
  }
}

module.exports = { anthropicToChat, chatToAnthropicNonStream, openAiChunkToAnthropicEvents, AnthropicStreamer };
