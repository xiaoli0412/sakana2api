const BASE = String(process.env.SAKANA_TEST_BASE || '').replace(/\/$/, '');
const KEY = String(process.env.SAKANA_TEST_KEY || '');

export function requireBenchmarkEnv() {
  if (!BASE || !KEY) {
    console.error('Set SAKANA_TEST_BASE and SAKANA_TEST_KEY for authorized benchmark runs.');
    process.exit(2);
  }
  try {
    const url = new URL(BASE);
    if (!/^https?:$/.test(url.protocol)) throw new Error('http(s) required');
  } catch {
    console.error('SAKANA_TEST_BASE must be an http(s) URL.');
    process.exit(2);
  }
  return { base: BASE, key: KEY };
}

function headers() {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${KEY}`,
  };
}

function addDelta(state, delta) {
  if (!delta || typeof delta !== 'object') return;
  if (typeof delta.content === 'string') {
    state.content += delta.content;
    state.contentChars += delta.content.length;
  }
  if (typeof delta.reasoning_content === 'string') state.reasoningChars += delta.reasoning_content.length;
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    const index = Number.isInteger(call.index) ? call.index : state.toolCalls.length;
    const current = state.toolCalls[index] || { id: '', name: '', arguments: '' };
    if (call.id) current.id += String(call.id);
    if (call.function?.name) current.name += String(call.function.name);
    if (call.function?.arguments) current.arguments += String(call.function.arguments);
    state.toolCalls[index] = current;
  }
}

function parseEvent(state, value) {
  state.buffer += value;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() || '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    if (event.error) state.errorCode = event.error.code || event.error.type || 'error';
    const choice = event.choices?.[0];
    addDelta(state, choice?.delta);
    if (choice?.finish_reason) state.finish = choice.finish_reason;
    if (Array.isArray(event.citations)) state.citations = event.citations.length;
  }
}

async function readChatResponse(response) {
  const state = {
    buffer: '', content: '', contentChars: 0, reasoningChars: 0,
    toolCalls: [], citations: 0, finish: '', errorCode: '',
  };
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parseEvent(state, decoder.decode(value, { stream: true }));
    }
    parseEvent(state, decoder.decode());
  } else {
    const raw = await response.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    const message = json?.choices?.[0]?.message;
    state.content = typeof message?.content === 'string' ? message.content : '';
    state.contentChars = state.content.length;
    state.reasoningChars = typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0;
    state.toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls.map((call) => ({
      id: String(call.id || ''),
      name: String(call.function?.name || ''),
      arguments: String(call.function?.arguments || ''),
    })) : [];
    state.citations = Array.isArray(json?.citations) ? json.citations.length : 0;
    state.errorCode = json?.error?.code || json?.error?.type || '';
    state.finish = message?.tool_calls?.length ? 'tool_calls' : 'stop';
  }
  return state;
}

export async function chat(body, { timeoutMs = 300000, contextFormat = '' } = {}) {
  const started = Date.now();
  try {
    const requestHeaders = headers();
    if (contextFormat) requestHeaders['x-context-format'] = contextFormat;
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const state = await readChatResponse(response);
    return {
      status: response.status,
      ok: response.ok,
      elapsedMs: Date.now() - started,
      contentChars: state.contentChars,
      reasoningChars: state.reasoningChars,
      toolCalls: state.toolCalls.filter((call) => call.name),
      citations: state.citations,
      finish: state.finish,
      errorCode: state.errorCode,
      text: state.content,
      conversationId: response.headers.get('x-conversation-id') || '',
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      elapsedMs: Date.now() - started,
      contentChars: 0,
      reasoningChars: 0,
      toolCalls: [],
      citations: 0,
      finish: '',
      errorCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
      text: '',
      conversationId: '',
    };
  }
}

export function summarize(result, extra = {}) {
  const { text: _text, ...safe } = result;
  return { ...safe, ...extra };
}

export function pngDataUrl() {
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
}
