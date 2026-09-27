'use strict';

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
    const value = typeof fragment === 'string' ? fragment : JSON.stringify(fragment ?? '');
    if (value) state.arguments += value;
    return { ...state };
  }

  end(idOrCall, data = {}) {
    const id = typeof idOrCall === 'object' ? (idOrCall.id || idOrCall.toolCallId) : idOrCall;
    const state = this.calls.get(String(id)) || this.start({ ...data, id });
    Object.assign(state, data);
    state.arguments = typeof state.arguments === 'string' ? state.arguments : JSON.stringify(state.arguments || {});
    return { ...state, done: true };
  }

  get(id) { return this.calls.get(String(id)) || null; }
  values() { return this.order.map((id) => ({ ...this.calls.get(id) })); }
  clear() { this.calls.clear(); this.order.length = 0; }
}

module.exports = { ToolCallState };
