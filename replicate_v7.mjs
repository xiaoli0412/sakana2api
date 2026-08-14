import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const out = {};
  // UUIDv7 generator (time-ordered, matches browser createMessageId)
  function uuidv7() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    const t = BigInt(Date.now());
    b[0] = Number((t >> 40n) & 0xffn); b[1] = Number((t >> 32n) & 0xffn);
    b[2] = Number((t >> 24n) & 0xffn); b[3] = Number((t >> 16n) & 0xffn);
    b[4] = Number((t >> 8n) & 0xffn); b[5] = Number(t & 0xffn);
    b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  }
  const boot = await fetch('/api/conversation', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ inputs: 'v7测试', enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' })
  }).then(r => r.json());
  out.bootstrap = boot;
  const fd = new FormData();
  fd.append('data', JSON.stringify({
    inputs: 'v7测试',
    id: uuidv7(),                    // v7 like browser
    is_retry: false, is_continue: false,
    enableThinking: false, toneMode: 'default', webSearchEnabled: false,
    userMessageId: crypto.randomUUID(),   // v4 like browser
    model: 'sakana-namazu'
  }));
  const resp = await fetch('/api/conversation/' + boot.conversationId, { method: 'POST', body: fd, credentials: 'include' });
  out.stream = { status: resp.status };
  const text = await resp.text();
  out.bodyHead = text.slice(0, 300);
  return out;
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
