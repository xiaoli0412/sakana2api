// Dump the RAW NDJSON for a search+stream turn (bypass translation) to inspect structure.
import fs from 'fs';
const { SakanaUpstream } = await import('../lib/upstream.js');
const { loadSession } = await import('../lib/session.js');
loadSession();
const up = new SakanaUpstream(async () => loadSession());
const boot = await up.createConversation({ toneMode: 'default', enableThinking: false, webSearchEnabled: true, model: 'sakana-namazu', inputs: '今天东京天气如何?简短回答' });
const resp = await up.streamGenerate(boot.conversationId, { prompt: '今天东京天气如何?简短回答', toneMode: 'default', enableThinking: false, webSearchEnabled: true, sakanaModel: 'sakana-namazu' }, { lastMessageId: boot.systemMessageId });
console.log('status:', resp.status);
const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = '', all = '', count = 0, types = {};
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    count++;
    let j; try { j = JSON.parse(line); } catch { continue; }
    types[j.type] = (types[j.type] || 0) + 1;
    if (count <= 80) {
      const s = JSON.stringify(j);
      all += (s.length > 350 ? s.slice(0, 350) + '…' : s) + '\n';
    }
  }
}
console.log('total lines:', count, 'types:', JSON.stringify(types));
console.log('--- first 80 lines ---');
console.log(all);
fs.writeFileSync('raw_search_stream.txt', buf.length ? buf : all);
