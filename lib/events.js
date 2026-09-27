'use strict';

const DEFAULT_MAX_SOURCES = 64;
const DEFAULT_MAX_FILES = 32;
const DEFAULT_MAX_EVENTS = 2048;

function event(type, data = {}) {
  return { type, ts: Date.now(), ...data };
}

function contentDelta(text, meta = {}) { return event('content_delta', { text: String(text || ''), ...meta }); }
function reasoningDelta(text, kind = 'model', meta = {}) { return event('reasoning_delta', { text: String(text || ''), kind, ...meta }); }
function reasoningStatus(status, meta = {}) { return event('reasoning_status', { status: String(status || ''), ...meta }); }
function searchStarted(query) { return event('search_started', { query: String(query || '') }); }
function searchSource(source = {}) { return event('search_source', { source: { title: String(source.title || ''), url: String(source.url || ''), snippet: String(source.snippet || source.content || '') } }); }
function toolCallStart(call = {}) { return event('tool_call_start', { call: { ...call } }); }
function toolCallDelta(call = {}) { return event('tool_call_delta', { call: { ...call } }); }
function toolCallEnd(call = {}) { return event('tool_call_end', { call: { ...call } }); }
function toolResult(result = {}) { return event('tool_result', { result: { ...result } }); }
function fileOutput(file = {}) { return event('file_output', { file: { name: String(file.name || ''), sha: String(file.sha || file.hash || ''), mime: String(file.mime || 'application/octet-stream'), url: file.url || file.downloadUrl || undefined } }); }
function finish(reason = 'stop') { return event('finish', { reason: String(reason || 'stop') }); }
function usage(stats = {}) { return event('usage', { stats: { prompt_tokens: Number(stats.prompt_tokens || 0), completion_tokens: Number(stats.completion_tokens || 0), total_tokens: Number(stats.total_tokens || 0) } }); }
function status(value, meta = {}) { return event('status', { status: String(value || ''), ...meta }); }

class TurnEventBuffer {
  constructor({ maxSources = DEFAULT_MAX_SOURCES, maxFiles = DEFAULT_MAX_FILES, maxEvents = DEFAULT_MAX_EVENTS } = {}) {
    this.maxSources = maxSources;
    this.maxFiles = maxFiles;
    this.maxEvents = maxEvents;
    this.events = [];
    this.sources = new Map();
    this.files = new Map();
    this.finished = false;
    this.usageEvent = null;
  }

  push(input) {
    if (!input || !input.type) return false;
    if (input.type === 'finish') {
      if (this.finished) return false;
      this.finished = true;
    }
    if (input.type === 'usage') {
      if (this.usageEvent) return false;
      this.usageEvent = input;
    }
    if (input.type === 'search_source') {
      const source = input.source || {};
      const key = `${source.title}|${source.url}`;
      if (this.sources.has(key)) return false;
      if (this.sources.size >= this.maxSources) return false;
      this.sources.set(key, source);
    }
    if (input.type === 'file_output') {
      const file = input.file || {};
      const key = `${file.sha}|${file.name}`;
      if (this.files.has(key)) return false;
      if (this.files.size >= this.maxFiles) return false;
      this.files.set(key, file);
    }
    if (this.events.length >= this.maxEvents) return false;
    this.events.push(input);
    return true;
  }

  finish(reason = 'stop') {
    if (!this.finished) this.push(finish(reason));
    return this.snapshot();
  }

  snapshot() {
    return {
      events: this.events.slice(),
      sources: [...this.sources.values()],
      files: [...this.files.values()],
      finished: this.finished,
      usage: this.usageEvent,
    };
  }

  toOpenAiChunks({ id, model, created = Math.floor(Date.now() / 1000) } = {}) {
    const chunks = [];
    const base = { id, object: 'chat.completion.chunk', created, model };
    for (const item of this.events) {
      let delta;
      if (item.type === 'content_delta') delta = { content: item.text };
      else if (item.type === 'reasoning_delta') delta = { reasoning_content: item.text };
      else if (item.type === 'tool_call_start' || item.type === 'tool_call_delta' || item.type === 'tool_call_end') {
        const call = item.call || {};
        const tc = { index: Number(call.index || 0), id: call.id, type: call.type || 'function', function: {} };
        if (call.name) tc.function.name = call.name;
        if (call.arguments !== undefined) tc.function.arguments = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments);
        delta = { tool_calls: [tc] };
      } else if (item.type === 'file_output') delta = { file_output: item.file, content: '' };
      else if (item.type === 'search_started') delta = { reasoning_content: `🔍 [Web 搜索] 正在搜索: ${item.query}` };
      else if (item.type === 'search_source') delta = { reasoning_content: `📄 [搜索结果] ${item.source.title} — ${item.source.url}` };
      if (delta) chunks.push({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
      if (item.type === 'finish') {
        const chunk = { ...base, choices: [{ index: 0, delta: {}, finish_reason: item.reason || 'stop' }] };
        if (this.sources.size) chunk.citations = [...this.sources.values()];
        chunks.push(chunk);
      }
    }
    if (this.usageEvent) chunks.push({ ...base, choices: [], usage: this.usageEvent.stats });
    return chunks;
  }
}

module.exports = { contentDelta, reasoningDelta, reasoningStatus, searchStarted, searchSource, toolCallStart, toolCallDelta, toolCallEnd, toolResult, fileOutput, finish, usage, status, TurnEventBuffer };
