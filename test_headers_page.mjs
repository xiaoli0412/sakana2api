import { findPageTarget, CdpSession } from './lib/cdp.js';
const target = await findPageTarget();
const sess = await CdpSession.connect(target.webSocketDebuggerUrl);
const r = await sess.evaluate(`(async () => {
  const out = {};
  const boot = await fetch('/api/conversation', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ inputs: '头部测试', enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' })
  }).then(r => r.json());
  const fd = new FormData();
  fd.append('data', JSON.stringify({ inputs: '头部测试', id: boot.systemMessageId, is_retry: false, is_continue: false, enableThinking: false, toneMode: 'default', webSearchEnabled: false, userMessageId: crypto.randomUUID(), model: 'sakana-namazu' }));
  // WITH datadog-trace style headers (realistic)
  const trace = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('');
  const span = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('');
  const resp = await fetch('/api/conversation/' + boot.conversationId, {
    method: 'POST', body: fd, credentials: 'include',
    headers: {
      'x-datadog-origin': 'rum',
      'x-datadog-trace-id': trace,
      'x-datadog-parent-id': span,
      'x-datadog-sampling-priority': '1',
      traceparent: '00-0000000000000000' + trace + '-' + span + '-01',
      tracestate: 'dd=s:1;o:rum',
    }
  });
  return { status: resp.status, head: (await resp.text()).slice(0, 120) };
})()`);
console.log(JSON.stringify(r, null, 1));
sess.close();
