// ContextStore regression tests — session stickiness (会话粘性) + long-context
// key handling. The store replaces server.js's inline contextMap logic.
// Store API mirrors the legacy server.js shape: lookup(req, body) where `req`
// is request-like ({headers}) or a legacy string; save(req, body, convId, msgId, accountId).
import { ContextStore, firstUserText, lastUserText } from '../lib/context.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('  ✓', name);
  else { failures++; console.log('  ✗', name, extra); }
}

console.log('== context store tests ==');

// ---- T1: same first user message -> same conversation (the sticky path) ----
{
  const store = new ContextStore();
  const body1 = { model: 'sakana-namazu', messages: [{ role: 'user', content: '记住关键词:海豚' }, { role: 'assistant', content: '好' }] };
  store.save({}, body1, 'conv-A', 'msg-A', 'acct-1');
  const hit = store.lookup({}, { model: 'sakana-namazu', messages: [{ role: 'user', content: '记住关键词:海豚' }, { role: 'assistant', content: '好' }, { role: 'user', content: '关键词是什么?' }] });
  check('T1 same first text hits same conversation', hit && hit.conversationId === 'conv-A' && hit.lastMessageId === 'msg-A', JSON.stringify(hit));
  check('T1 accountId preserved for pinning', hit && hit.accountId === 'acct-1');
}

// ---- T2: different first text -> no cross-hit ----
{
  const store = new ContextStore();
  store.save({}, { messages: [{ role: 'user', content: 'AAAA' }] }, 'conv-B', 'msg-B', 'acct-2');
  const hit = store.lookup({}, { messages: [{ role: 'user', content: 'BBBB' }] });
  check('T2 different first text misses', hit === null);
}

// ---- T3: explicit conversation_id/channel keys ----
{
  const store = new ContextStore();
  store.save({}, { conversation_id: 'cid-77', messages: [{ role: 'user', content: 'hello' }] }, 'conv-C', 'msg-C', 'acct-3');
  const byId = store.lookup({}, { conversation_id: 'cid-77', messages: [{ role: 'user', content: 'totally different text' }] });
  check('T3 conversation_id alone recovers context', byId && byId.conversationId === 'conv-C');
  const byChatId = store.lookup({}, { chat_id: 'cid-77', messages: [{ role: 'user', content: 'x' }] });
  check('T3 chat_id alias also recovers', byChatId && byChatId.conversationId === 'conv-C');
  const byHeader = store.lookup({ headers: { 'x-conversation-id': 'cid-77' } }, { messages: [{ role: 'user', content: 'x' }] });
  check('T3 x-conversation-id header recovers', byHeader && byHeader.conversationId === 'conv-C');
}

// ---- T4: TTL expiry ----
{
  const store = new ContextStore({ ttl: 5000 });
  store.save({}, { messages: [{ role: 'user', content: 'ttl test' }] }, 'conv-D', 'msg-D', 'acct-4');
  const hitFresh = store.lookup({}, { messages: [{ role: 'user', content: 'ttl test' }] });
  check('T4 fresh hit works', hitFresh !== null);
  for (const [, e] of store.map) e.ts -= 6000; // age it out deterministically
  const hit = store.lookup({}, { messages: [{ role: 'user', content: 'ttl test' }] });
  check('T4 expired entry evicted', hit === null);
}

// ---- T5: capacity eviction (evicts oldest when over cap) ----
{
  const store = new ContextStore({ capacity: 10 });
  for (let i = 0; i < 12; i++) {
    store.save({}, { messages: [{ role: 'user', content: 'bulk-' + i }] }, 'conv-' + i, 'msg-' + i, 'acct-x');
  }
  // age order: bulk-0 oldest (11s ago), bulk-11 newest (now)
  for (const [k, e] of store.map) {
    const idx = k.includes('text:') ? -1 : -1; // placeholder, real work below
  }
  const keysOrder = [];
  for (const [k, e] of store.map.entries()) {
    const m = k.startsWith('text:') ? k : null;
    if (m) keysOrder.push({ k, e });
  }
  let i = 0;
  for (const { e } of keysOrder) { e.ts = Date.now() - (11 - i) * 1000; i++; }
  check('T5 size capped', store.size <= 10, `size=${store.size}`);
  const earliest = store.lookup({}, { messages: [{ role: 'user', content: 'bulk-0' }] });
  check('T5 oldest evicted', earliest === null, JSON.stringify(earliest));
  const newest = store.lookup({}, { messages: [{ role: 'user', content: 'bulk-11' }] });
  check('T5 newest retained', newest !== null);
}

// ---- T6: legacy string-compat path ----
{
  const store = new ContextStore();
  store.save('hello world', undefined, 'conv-E', 'msg-E', 'acct-5');
  const hit = store.lookup('hello world');
  check('T6 string save/lookup round-trip', hit && hit.conversationId === 'conv-E' && hit.accountId === 'acct-5');
  check('T6 string lookup miss', store.lookup('other text') === null);
}

// ---- T7: save updates lastMessageId but keeps conversationId/accountId ----
{
  const store = new ContextStore();
  const body = { messages: [{ role: 'user', content: 'sticky-turn' }] };
  store.save({}, body, 'conv-F', 'msg-1', 'acct-6');
  store.save({}, body, 'conv-F', 'msg-9', 'acct-6');
  const hit = store.lookup({}, body);
  check('T7 lastMessageId advances', hit && hit.lastMessageId === 'msg-9' && hit.conversationId === 'conv-F' && hit.accountId === 'acct-6', JSON.stringify(hit));
}

// ---- T8: tool turns do not break the sticky key ----
{
  const bodyTool = { messages: [{ role: 'user', content: 'base question' }, { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: 'result' }] };
  check('T8 firstUserText stable with tool turns', firstUserText(bodyTool) === 'base question');
  check('T8 lastUserText skips tool turns', lastUserText(bodyTool) === 'base question');
}

console.log(failures ? `\nRESULT: ${failures} FAILED` : '\nRESULT: all passed');
process.exit(failures ? 1 : 0);