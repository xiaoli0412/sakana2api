import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { normalizeRequestBody } = (await import('../lib/request-normalizer.js')).default;
const { buildNormalizedSakanaRequest, requestedHistoryMode } = (await import('../lib/request-assembly.js')).default;

const novel = '第一章：潮汐把旧城的灯影揉碎。\n' + '海风穿过窗棂，记录员仍在等待下一封信。\n'.repeat(6000);
const body = {
  model: 'sakana-namazu',
  conversation_id: 'client-conversation-opaque',
  messages: [{ role: 'user', content: novel }],
};
const normalized = await normalizeRequestBody(body);
const assembled = buildNormalizedSakanaRequest(body, normalized, null);
const contextFile = assembled.sakanaReq.files.find((file) => file.name === 'context_document.txt');
assert.ok(contextFile, 'long normalized prompt keeps synthetic context file');
assert.equal(contextFile.synthetic, true);
assert.equal(contextFile.buf.toString('utf8'), novel, 'synthetic attachment preserves the raw source prompt');
assert.equal(
  crypto.createHash('sha256').update(contextFile.buf).digest('hex'),
  crypto.createHash('sha256').update(Buffer.from(novel, 'utf8')).digest('hex'),
);
assert.ok(contextFile.buf.length > 200_000, `full novel bytes preserved: ${contextFile.buf.length}`);
assert.notEqual(
  contextFile.buf.toString('utf8'),
  assembled.normalizedPrompt,
  'normalized visible prompt may contain role labels without rewriting the raw document',
);
assert.equal(assembled.sakanaReq.conversationId, 'client-conversation-opaque');

const history = {
  model: 'sakana-namazu',
  conversation_id: 'client-1',
  history_mode: 'full',
  messages: [
    { role: 'user', content: '第一幕' },
    { role: 'assistant', content: '旧回复' },
    { role: 'user', content: '第二幕' },
  ],
};
const historyNormalized = await normalizeRequestBody(history);
const suffix = buildNormalizedSakanaRequest(history, historyNormalized, {
  conversationId: 'upstream-1',
  messageCount: 2,
});
assert.equal(suffix.sakanaReq.conversationId, 'upstream-1');
assert.ok(suffix.normalizedPrompt.includes('第二幕'));
assert.equal(suffix.normalizedPrompt.includes('第一幕'), false);
assert.equal(requestedHistoryMode({ conversation_id: 'client-1' }), 'delta');
assert.equal(requestedHistoryMode({ history_mode: 'full', conversation_id: 'client-1' }), 'full');

const namedAttachment = Buffer.from('user-owned context document');
const attachmentBody = {
  model: 'sakana-namazu',
  messages: [{ role: 'user', content: [{ type: 'file', name: 'context_document.txt', data: namedAttachment.toString('base64'), mime: 'text/plain' }] }],
};
const attachmentNormalized = await normalizeRequestBody(attachmentBody);
const attachmentRequest = buildNormalizedSakanaRequest(attachmentBody, attachmentNormalized, null);
const userFile = attachmentRequest.sakanaReq.files.find((file) => file.name === 'context_document.txt');
assert.ok(userFile, 'user-owned context_document.txt remains attached');
assert.equal(userFile.synthetic, undefined);
assert.equal(userFile.buf.toString('utf8'), namedAttachment.toString('utf8'));

console.log('request assembly tests: all passed');
