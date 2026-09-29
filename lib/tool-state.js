'use strict';

const MAX_TOOL_CALLS = Math.max(1, Number.parseInt(process.env.TOOL_MAX_CALLS || '64', 10));
const MAX_TOOL_ARGUMENT_BYTES = Math.max(1, Number.parseInt(process.env.TOOL_MAX_ARGUMENT_BYTES || String(256 * 1024), 10));

function boundedArgument(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= MAX_TOOL_ARGUMENT_BYTES) return text;
  let out = text;
  while (out && Buffer.byteLength(out, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) out = out.slice(0, Math.max(0, out.length - Math.ceil(out.length / 8)));
  return out;
}

function normalizeId(value, fallback) {
  return String(value || fallback || 'call_' + Math.random().toString(36).slice(2, 12));
}

class ToolCallState {
  constructor() {
    this.calls = new Map();
    this.order = [];
  }

  start(call = {}) {
    const id = normalizeId(call.id || call.toolCallId, null);
    let state = this.calls.get(id);
    if (!state) {
      if (this.order.length >= MAX_TOOL_CALLS) return null;
      state = { id, index: Number.isFinite(call.index) ? call.index : this.order.length, type: call.type || 'function', name: call.name || call.toolName || '', arguments: '' };
      this.calls.set(id, state);
      this.order.push(id);
    }
    if (call.name || call.toolName) state.name = call.name || call.toolName;
    if (call.type) state.type = call.type;
    if (call.arguments !== undefined || call.input !== undefined) this.append(id, call.arguments ?? call.input);
    return { ...state };
  }

  append(idOrCall, fragment) {
    const id = typeof idOrCall === 'object' ? normalizeId(idOrCall.id || idOrCall.toolCallId, null) : String(idOrCall);
    const state = this.calls.get(id) || this.start({ id });
    if (!state) return null;
    const value = boundedArgument(fragment);
    if (value) {
      const next = state.arguments + value;
      state.arguments = boundedArgument(next);
    }
    return { ...state };
  }

  end(idOrCall, data = {}) {
    const id = typeof idOrCall === 'object' ? (idOrCall.id || idOrCall.toolCallId) : idOrCall;
    const state = this.calls.get(String(id)) || this.start({ ...data, id });
    if (!state) return null;
    Object.assign(state, data);
    state.arguments = boundedArgument(state.arguments || {});
    return { ...state, done: true };
  }

  get(id) { return this.calls.get(String(id)) || null; }
  values() { return this.order.map((id) => ({ ...this.calls.get(id) })); }
  clear() { this.calls.clear(); this.order.length = 0; }
}

module.exports = { ToolCallState };
