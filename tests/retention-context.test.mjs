import assert from 'node:assert/strict';
import { ContextStore } from '../lib/context.js';

let now = 1000;
const pruned = [];
const store = new ContextStore({
  ttl: 10,
  capacity: 30,
  maxClientAliases: 2,
  pruneIntervalMs: 0,
  now: () => now,
  onPrune: (count) => pruned.push(count),
});

store.save({}, { conversation_id: 'client-1', messages: [{ role: 'user', content: 'same' }] }, 'conv', 'leaf');
now++;
store.save({}, { conversation_id: 'client-2', messages: [{ role: 'user', content: 'same' }] }, 'conv', 'leaf');
now++;
store.save({}, { conversation_id: 'client-3', messages: [{ role: 'user', content: 'same' }] }, 'conv', 'leaf');
const entry = store.getByConversationId('conv');
assert.deepEqual(entry.clientConversationIds, ['client-2', 'client-3']);
assert.equal(store.lookup({}, { conversation_id: 'client-1', messages: [{ role: 'user', content: 'different' }] }), null);
assert.ok(store.map.size < 10, 'old aliases are removed, not only metadata');

now += 20;
assert.ok(store.prune() > 0);
assert.ok(pruned.length > 0);
assert.equal(store.size, 0);
store.close();

console.log('context retention tests: all passed');
