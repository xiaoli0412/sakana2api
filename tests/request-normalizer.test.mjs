import assert from 'node:assert/strict';

const { normalizeRequestBody, fingerprintMessages, AttachmentError } = (await import('../lib/request-normalizer.js')).default;
const {
  clipUtf8ByBytes,
  clipTextByBytes,
  estimateMultipartBytes,
  estimateTokens,
  resolveBudgetOptions,
} = (await import('../lib/context-budget.js')).default;

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const pdf = Buffer.from('%PDF-1.7 demo');

const normalized = await normalizeRequestBody({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '先看第一张图' },
      { type: 'image_url', image_url: { url: `data:application/octet-stream;base64,${png.toString('base64')}` } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
      { type: 'text', text: '再看文档' },
    ],
  }],
});
assert.equal(normalized.messages[0].parts.length, 4);
assert.equal(normalized.attachments.length, 2);
assert.equal(normalized.attachments[0].mime, 'image/png');
assert.equal(normalized.attachments[1].mime, 'application/pdf');
assert.deepEqual(normalized.messages[0].parts.map((p) => p.kind), ['text', 'attachment', 'attachment', 'text']);
assert.equal(normalized.attachments[0].order, 0);
assert.equal(normalized.attachments[1].order, 1);
assert.equal(normalized.textBytes, Buffer.byteLength('先看第一张图再看文档'));
assert.equal(normalized.attachmentBytes, png.length + pdf.length);
assert.equal(normalized.estimatedTokens, [...'先看第一张图再看文档'].length / 4);
assert.equal(normalized.estimatedMultipartBytes, estimateMultipartBytes({
  fields: [['data', JSON.stringify(normalized.messages)]],
  attachments: normalized.attachments,
}));

const stableA = fingerprintMessages(normalized.messages);
const stableB = fingerprintMessages(JSON.parse(JSON.stringify(normalized.messages)));
assert.equal(stableA, stableB, 'semantic fingerprint is stable');

await assert.rejects(
  () => normalizeRequestBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/large.png' } }] }] }, {
    maxAttachmentBytes: 4,
    fetchRemote: async () => ({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array(5).buffer,
    }),
  }),
  (err) => err.code === 'ATTACHMENT_TOO_LARGE',
);

// Clipping is bounded in UTF-8 bytes and never cuts a surrogate pair.
const unicodeText = '😀你好abc';
const clipped = clipTextByBytes(unicodeText, 7);
assert.equal(clipped.text, '😀你');
assert.equal(clipped.bytes, 7);
assert.equal(clipped.originalBytes, Buffer.byteLength(unicodeText));
assert.equal(clipUtf8ByBytes('😀abc', 3), '');
assert.equal(clipUtf8ByBytes('😀abc', 4), '😀');
assert.equal(/\uD800|\uDC00/.test(JSON.stringify(clipped.text)), false);

const clippedRequest = await normalizeRequestBody({
  messages: [{ role: 'user', content: [{ type: 'text', text: unicodeText }] }],
}, { maxTextBytes: 7 });
assert.equal(clippedRequest.messages[0].parts[0].text, '😀你');
assert.equal(clippedRequest.messages[0].parts[0].clipping.code, 'TEXT_CLIPPED');
assert.equal(clippedRequest.clipping[0].originalBytes, Buffer.byteLength(unicodeText));
assert.equal(clippedRequest.clipping[0].bytes, 7);
assert.equal(clippedRequest.measurements.clipped, true);

// Aggregate text and attachment budgets are independent and produce stable
// AttachmentError codes. Aggregate text can be clipped deterministically.
const aggregateText = await normalizeRequestBody({
  messages: [
    { role: 'user', content: 'abcd' },
    { role: 'assistant', content: '你好' },
  ],
}, { maxTextBytes: 100, maxTotalTextBytes: 7, clipTextToBudget: true });
assert.equal(aggregateText.textBytes, 7);
assert.equal(aggregateText.messages[1].parts[0].text, '你');
assert.equal(aggregateText.clipping.at(-1).reason, 'aggregate_budget');

await assert.rejects(
  () => normalizeRequestBody({ messages: [{ role: 'user', content: '12345' }] }, {
    maxTotalTextBytes: 4,
  }),
  (err) => err instanceof AttachmentError && err.code === 'TEXT_BUDGET_EXCEEDED' && err.maxTotalTextBytes === 4,
);

await assert.rejects(
  () => normalizeRequestBody({ messages: [{ role: 'user', content: [
    { type: 'file', source: { type: 'base64', media_type: 'application/octet-stream', data: Buffer.from('123').toString('base64') } },
    { type: 'file', source: { type: 'base64', media_type: 'application/octet-stream', data: Buffer.from('456').toString('base64') } },
  ] }] }, { maxTotalAttachmentBytes: 5 }),
  (err) => err instanceof AttachmentError && err.code === 'ATTACHMENT_BUDGET_EXCEEDED' && err.maxTotalAttachmentBytes === 5,
);

await assert.rejects(
  () => normalizeRequestBody({ messages: [{ role: 'user', content: '1234567890' }] }, {
    maxMultipartBytes: 1,
  }),
  (err) => err instanceof AttachmentError && err.code === 'MULTIPART_BUDGET_EXCEEDED' && err.maxMultipartBytes === 1,
);

const envBudget = resolveBudgetOptions({ env: {
  MAX_TEXT_BYTES: '12',
  MAX_TOTAL_TEXT_BYTES: '34',
  MAX_TOTAL_ATTACHMENT_BYTES: '56',
  MAX_MULTIPART_BYTES: '78',
} });
assert.deepEqual({
  maxTextBytes: envBudget.maxTextBytes,
  maxTotalTextBytes: envBudget.maxTotalTextBytes,
  maxTotalAttachmentBytes: envBudget.maxTotalAttachmentBytes,
  maxMultipartBytes: envBudget.maxMultipartBytes,
}, {
  maxTextBytes: 12,
  maxTotalTextBytes: 34,
  maxTotalAttachmentBytes: 56,
  maxMultipartBytes: 78,
});
assert.equal(estimateTokens('123456789'), 2.25);
assert.equal(estimateTokens('123456789', 4), 2.25);

// Preserve assistant tool calls and tool results instead of flattening them.
const toolHistory = await normalizeRequestBody({
  messages: [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"Tokyo"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temperature":20}' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_2', name: 'lookup', input: { q: 'Osaka' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: 'done' }] }],
    },
  ],
});
assert.equal(toolHistory.messages[0].role, 'assistant');
assert.equal(toolHistory.messages[0].tool_calls[0].id, 'call_1');
assert.equal(toolHistory.messages[0].parts[0].kind, 'tool_call');
assert.equal(toolHistory.messages[0].parts[0].name, 'lookup');
assert.equal(toolHistory.messages[1].role, 'tool');
assert.equal(toolHistory.messages[1].tool_call_id, 'call_1');
assert.equal(toolHistory.messages[2].parts[0].id, 'call_2');
assert.deepEqual(toolHistory.messages[2].parts[0].arguments, { q: 'Osaka' });
assert.equal(toolHistory.messages[3].parts[0].kind, 'tool_result');
assert.equal(toolHistory.messages[3].parts[0].id, 'call_2');

console.log('request normalizer tests: all passed');
