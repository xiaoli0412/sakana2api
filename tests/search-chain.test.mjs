// Integration test for the code/writer "search→think" two-round smart routing.
// A fake upstream records every generation and answers round 1 (search-only)
// with sources, round 2 (thinking) with the final answer.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamState = {
  nextConversation: 1,
  conversations: new Map(),
  generations: [],
};

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function ndjson(res, events) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
  for (const event of events) res.write(JSON.stringify(event) + '\n');
  res.end();
}

const upstreamServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake-upstream');
  if (req.method === 'POST' && url.pathname === '/api/conversation') {
    await readRequest(req);
    const id = `conv-${upstreamState.nextConversation++}`;
    upstreamState.conversations.set(id, { leaf: `system-${id}`, messages: [{ id: `system-${id}` }] });
    return jsonResponse(res, 200, { conversationId: id, systemMessageId: `system-${id}` });
  }
  const conversationMatch = /^\/api\/conversation\/([^/]+)$/.exec(url.pathname);
  if (conversationMatch && req.method === 'GET') {
    const conversation = upstreamState.conversations.get(decodeURIComponent(conversationMatch[1]));
    if (!conversation) return jsonResponse(res, 404, { errorCode: 'CONV-NOTFOUND-001' });
    return jsonResponse(res, 200, { messages: conversation.messages });
  }
  if (conversationMatch && req.method === 'POST') {
    const id = decodeURIComponent(conversationMatch[1]);
    const conversation = upstreamState.conversations.get(id);
    if (!conversation) return jsonResponse(res, 404, { errorCode: 'CONV-NOTFOUND-001' });
    const raw = await readRequest(req);
    const dataPart = Buffer.from(raw.toString('utf8').match(/name="data"\r\n\r\n([\s\S]*?)\r\n--/)?.[1] || '{}', 'utf8');
    const data = JSON.parse(dataPart.toString('utf8'));
    upstreamState.generations.push(data);
    const leaf = `leaf-${upstreamState.generations.length}`;
    conversation.leaf = leaf;
    conversation.messages.push({ id: leaf });
    if (data.webSearchEnabled === true && data.enableThinking === false) {
      return ndjson(res, [
        { type: 'toolCall', toolCall: { toolCallId: 'functions.search.1', toolName: 'search', input: { query: 'sakana api' } } },
        { type: 'toolResult', toolResult: { toolCallId: 'functions.search.1', toolName: 'search', output: { query: 'sakana api', sources: [
          { title: 'Sakana Docs', url: 'https://docs.example.test/sakana', snippet: 'the answer is 42' },
          { title: 'Mirror', url: 'https://mirror.example.test/sakana' },
        ] }, isError: false } },
        { type: 'stream', token: 'sources collected' },
      ]);
    }
    return ndjson(res, [
      { type: 'reasoning', token: '结合来源推理中' },
      { type: 'stream', token: '答案是 42' },
    ]);
  }
  jsonResponse(res, 404, { error: 'not found' });
});
await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstreamServer.address().port;
const serverPort = 21000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    AUTO_SESSION: 'false',
    API_KEY: '',
    PORT: String(serverPort),
    HOST: '127.0.0.1',
    SAKANA_BASE: `http://127.0.0.1:${upstreamPort}`,
    SAKANA_COOKIE: 'fake-cookie=fake',
    CACHE_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const childOutput = [];
child.stdout.on('data', (chunk) => childOutput.push(chunk.toString()));
child.stderr.on('data', (chunk) => childOutput.push(chunk.toString()));

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('server did not become ready');
}

async function chatStream(payload) {
  const response = await fetch(`http://127.0.0.1:${serverPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200, `chat status ${response.status}`);
  const text = await response.text();
  const chunks = [];
  let done = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payloadText = line.slice(6).trim();
    if (payloadText === '[DONE]') { done = true; continue; }
    try { chunks.push(JSON.parse(payloadText)); } catch {}
  }
  return { response, chunks, done };
}

try {
  await waitForServer();

  // 1. code model → two-round chain
  const first = await chatStream({ model: 'sakana-code', stream: true, messages: [{ role: 'user', content: 'sakana api 是什么?' }] });
  assert.equal(upstreamState.generations.length, 2, `expected two generations, got ${upstreamState.generations.length}`);
  const round1 = upstreamState.generations[0];
  const round2 = upstreamState.generations[1];
  assert.equal(round1.webSearchEnabled, true, 'round 1 runs with search on');
  assert.equal(round1.enableThinking, false, 'round 1 runs with thinking off');
  assert.equal(round2.enableThinking, true, 'round 2 is the thinking round');
  assert.equal(round2.webSearchEnabled, false, 'round 2 keeps search off (INPUT-MODE-001)');
  assert.ok(round2.inputs.includes('[检索资料'), 'round 2 prompt carries the source block');
  assert.ok(round2.inputs.includes('https://docs.example.test/sakana'), 'round 2 prompt carries the source url');

  const reasoningText = first.chunks
    .map((c) => c.choices?.[0]?.delta?.reasoning_content || '')
    .join('');
  assert.ok(reasoningText.includes('联网检索完成'), 'stream shows chain progress in reasoning');
  assert.ok(reasoningText.includes('正在搜索') || reasoningText.includes('[Web 搜索]'), 'round 1 search events merged into reasoning');
  const answerText = first.chunks
    .map((c) => c.choices?.[0]?.delta?.content || '')
    .join('');
  assert.ok(answerText.includes('答案是 42'), 'final answer streamed');
  const finishChunk = first.chunks.find((c) => c.choices?.[0]?.finish_reason === 'stop');
  assert.ok(finishChunk, 'finish chunk present');
  assert.ok(Array.isArray(finishChunk.citations) && finishChunk.citations.some((c) => c.url === 'https://docs.example.test/sakana'), 'citations on finish chunk');
  assert.equal(first.done, true, 'stream ends with [DONE]');

  // 2. explicit web_search:true on code model → single search round (no chain)
  const before = upstreamState.generations.length;
  await chatStream({ model: 'sakana-code', stream: true, web_search: true, messages: [{ role: 'user', content: 'q2' }] });
  assert.equal(upstreamState.generations.length - before, 1, 'explicit search stays single-round');
  assert.equal(upstreamState.generations.at(-1).webSearchEnabled, true, 'single round is the search round');

  // 3. standard model → single thinking round, no chain
  const beforeStandard = upstreamState.generations.length;
  await chatStream({ model: 'sakana', stream: true, messages: [{ role: 'user', content: 'q3' }] });
  assert.equal(upstreamState.generations.length - beforeStandard, 1, 'standard model stays single-round');
  assert.equal(upstreamState.generations.at(-1).enableThinking, true, 'standard round is thinking');

  console.log('search-chain tests: all passed');
} finally {
  child.kill('SIGKILL');
  await new Promise((resolve) => upstreamServer.close(resolve));
}
