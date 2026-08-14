import fs from 'fs';
const { SakanaUpstream } = await import('./lib/upstream.js');
const { loadSession } = await import('./lib/session.js');
loadSession();

// Directly replicate the server's current path: bootstrap -> stream(systemMessageId)
const up = new SakanaUpstream(async () => loadSession());
const boot = await up.createConversation({ toneMode: 'default', enableThinking: true, webSearchEnabled: false, model: 'sakana-namazu', inputs: '调试对话' });
console.log('boot:', JSON.stringify(boot));
try {
  const resp = await up.streamGenerate(boot.conversationId, {
    prompt: '调试对话', toneMode: 'default', enableThinking: true,
    webSearchEnabled: false, sakanaModel: 'sakana-namazu',
  }, { lastMessageId: boot.systemMessageId });
  console.log('STREAM STATUS:', resp.status);
  const head = (await resp.text()).slice(0, 2000);
  console.log('HEAD:', head);
} catch (e) {
  console.log('STREAM ERROR:', e.message);
  console.log('status:', e.status, 'code:', e.errorCode);
}
