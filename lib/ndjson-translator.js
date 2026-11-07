'use strict';
// NDJSON -> OpenAI SSE chunk translator, extracted from lib/translate.js (P2 split).
// Moved verbatim: the upstream event handling and chunk shapes are unchanged.
const { randomUUID } = require('crypto');
const { TurnEventBuffer, contentDelta, reasoningDelta, searchStarted, searchSource, toolCallStart, toolCallDelta, toolCallEnd, fileOutput, finish: finishEvent, usage: usageEvent } = require('./events');
const { ToolCallState } = require('./tool-state');
const { createTokenCounter } = require('./token-estimate');
const { clean, stripChips, extractJsonToolCalls } = require('./text-utils');


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
    // CJK-aware completion accounting (old flat /4 under-counted Chinese ~4x).
    this._tokCount = createTokenCounter();
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
        for (const chunk of visible) this._tokCount.feed((chunk.choices?.[0]?.delta?.content || '') + (chunk.choices?.[0]?.delta?.reasoning_content || ''));
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
            this._tokCount.feed(cleaned);

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
            this._tokCount.feed(q);
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
      this._tokCount.feed(held);
      out.push({ choices: [{ index: 0, delta: { content: held }, finish_reason: null }] });
    }
    const finishReason = this.hasToolCalls ? 'tool_calls' : 'stop';
    this.events.push(finishEvent(finishReason));
    const chunk = { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
    if (this.citations.length) chunk.citations = this.citations;
    out.push(chunk);
    // 独立流尾 usage chunk(choices 为空数组):OpenAI 官方规范 + AstrBot
    // #8306 显式放行该格式;SDK 靠它记录 token 消耗。
    const completionTokens = this._tokCount.tokens;
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

module.exports = { NdjsonTranslator };
