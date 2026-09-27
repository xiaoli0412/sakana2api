import assert from 'node:assert/strict';

const policy = (await import('../lib/context-policy.js')).default;
const messages = [
  { role: 'user', parts: [{ kind: 'text', text: 'hello' }] },
  { role: 'assistant', parts: [{ kind: 'text', text: 'hi' }] },
];
const snapshot = policy.makeContextSnapshot({ messages });
const stored = { conversationId: 'conv-1', lastMessageId: 'msg-1', ...snapshot };

assert.equal(policy.decideContext({ stored, client: snapshot }).action, 'reuse');
assert.equal(policy.decideContext({ explicitId: 'conv-1', stored, client: snapshot }).action, 'reuse');
assert.equal(policy.decideContext({ explicitId: 'missing', stored: null, client: snapshot }).action, 'rebuild');
assert.equal(policy.decideContext({ explicitId: 'missing', stored: null, client: snapshot, rebuildAttempted: true }).reason, 'CONTEXT-REBUILD-FAILED');
assert.equal(policy.decideContext({ stored, client: { ...snapshot, firstMessageFingerprint: 'different' } }).reason, 'HISTORY_FORK');
assert.equal(policy.decideContext({ stored: null, client: snapshot }).action, 'new');

const changedFirst = { ...snapshot, firstMessageFingerprint: 'different' };
assert.equal(
  policy.decideContext({ explicitId: 'conv-1', stored, client: changedFirst, historyMode: 'delta' }).action,
  'reuse',
);
assert.equal(
  policy.decideContext({ explicitId: 'conv-1', stored, client: changedFirst, historyMode: 'full' }).reason,
  'HISTORY_FORK',
);
const clientAlias = { ...stored, clientConversationIds: ['client-1'] };
assert.equal(policy.decideContext({ explicitId: 'client-1', stored: clientAlias, client: snapshot, historyMode: 'delta' }).action, 'reuse');
assert.equal(policy.decideContext({ stored, client: { ...snapshot, messageCount: 1 } }).reason, 'HISTORY_TRUNCATED');
