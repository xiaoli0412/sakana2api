// Dump the RAW NDJSON for a search turn (through the same _headers path) to
// inspect exact update structure: stream vs toolTurnText vs finalAnswer.
import fs from 'fs';
const { SakanaUpstream } = await import('../lib/upstream.js');
const { loadSession } = await import('../lib/session.js');
loadSession();
const up = new SakanaUpstream(async () => loadSession());
const boot = await up.createConversation({ toneMode: 'default', enableThinking: false, webSearchEnabled: true, model: 'sakana-namazu', inputs: '今天东京天气?一句话。' });
console.log('conv:', boot.conversationId, 'sys:', boot.systemMessageId);
const resp = await up.streamGenerate(boot.conversationId, { prompt: '今天东京天气?一句话。', toneMode: 'default', enableThinking: false, webSearchEnabled: true, sakanaModel: 'sakana-namazu' }, { lastMessageId: boot.systemMessageId });
console.log('status:', resp.status, 'ct:', resp.headers.get('content-type'));
const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = '', all = '', count = 0, types = {};
try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      count++;
      let j; try { j = JSON.parse(line); } catch { continue; }
      types[j.type] = (types[j.type] || 0) + 1;
      if (count <= 200) {
        const s = JSON.stringify(j);
        all += (s.length > 400 ? s.slice(0, 400) + '…' : s) + '\n';
      }
    }
  }
} catch (e) { console.log('stream error:', e.cause?.code || e.message); }
console.log('lines:', count, 'types:', JSON.stringify(types, null, 0));
fs.writeFileSync('raw_search.txt', all);
console.log('--- first 200 ---');
console.log(all.slice(0, 9000));