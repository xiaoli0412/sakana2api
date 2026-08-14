import fs from 'fs';
const { SakanaUpstream, buildMultipart } = await import('../lib/upstream.js');
const { loadSession } = await import('../lib/session.js');
loadSession();
const up = new SakanaUpstream(async () => loadSession());
const png = fs.readFileSync('red64.png');
// bootstrap with no inputs
const boot = await up.createConversation({ toneMode: 'default', enableThinking: false, webSearchEnabled: false, model: 'sakana-namazu' });
console.log('boot:', JSON.stringify(boot));
// stream with files
const resp = await up.streamGenerate(boot.conversationId, {
  prompt: '这张图片什么颜色',
  toneMode: 'default', enableThinking: false, webSearchEnabled: false,
  sakanaModel: 'sakana-namazu',
  files: [{ type: 'base64', name: 'red64.png', mime: 'image/png', buf: png }],
}, { lastMessageId: boot.systemMessageId });
console.log('stream status:', resp.status);
const text = await resp.text();
console.log('head:', text.slice(0, 300));
