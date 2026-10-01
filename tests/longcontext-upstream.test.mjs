import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamState = {
  nextConversation: 1,
  conversations: new Map(),
  generations: [],
  gets: 0,
  compacts: 0,
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseMultipart(body, contentType) {
  const boundaryMatch = /boundary=([^;]+)/i.exec(contentType || '');
  assert.ok(boundaryMatch, 'upstream request has multipart boundary');
  const boundary = boundaryMatch[1].replace(/^"|"$/g, '');
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = body.indexOf(marker);
  while (cursor !== -1) {
    const start = cursor + marker.length;
    const next = body.indexOf(marker, start);
    if (next === -1) break;
    let part = body.subarray(start, next);
    if (part.subarray(0, 2).equals(Buffer.from('\r\n'))) part = part.subarray(2);
    if (part.subarray(-2).equals(Buffer.from('\r\n'))) part = part.subarray(0, -2);
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    if (separator !== -1) {
      const headers = part.subarray(0, separator).toString('utf8');
      const content = part.subarray(separator + 4);
      const name = /name="([^"]+)"/i.exec(headers)?.[1] || '';
      const filename = /filename="([^"]+)"/i.exec(headers)?.[1] || '';
      parts.push({ name, filename, headers, content });
    }
    cursor = next;
  }
  return parts;
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const upstreamServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake-upstream');
  if (req.method === 'POST' && url.pathname === '/api/conversation') {
    const raw = await readRequest(req);
    const parsed = JSON.parse(raw.toString('utf8') || '{}');
    const id = `upstream-conv-${upstreamState.nextConversation++}`;
    upstreamState.conversations.set(id, { leaf: `system-${id}`, messages: [{ id: `system-${id}` }], create: parsed });
    return jsonResponse(res, 200, { conversationId: id, systemMessageId: `system-${id}` });
  }

  const conversationMatch = /^\/api\/conversation\/([^/]+)$/.exec(url.pathname);
  if (conversationMatch && req.method === 'GET') {
    const id = decodeURIComponent(conversationMatch[1]);
    upstreamState.gets++;
    const conversation = upstreamState.conversations.get(id);
    if (!conversation) return jsonResponse(res, 404, { errorCode: 'CONV-NOTFOUND-001' });
    return jsonResponse(res, 200, { messages: conversation.messages });
  }

  const compactMatch = /^\/api\/conversation\/([^/]+)\/compact$/.exec(url.pathname);
  if (compactMatch && req.method === 'POST') {
    upstreamState.compacts++;
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{}');
  }

  if (conversationMatch && req.method === 'POST') {
    const id = decodeURIComponent(conversationMatch[1]);
    const conversation = upstreamState.conversations.get(id);
    if (!conversation) return jsonResponse(res, 404, { errorCode: 'CONV-NOTFOUND-001' });
    const raw = await readRequest(req);
    const parts = parseMultipart(raw, req.headers['content-type']);
    const dataPart = parts.find((part) => part.name === 'data');
    assert.ok(dataPart, 'generation includes data part');
    const data = JSON.parse(dataPart.content.toString('utf8'));
    const files = parts.filter((part) => part.name === 'files').map((part) => ({
      filename: part.filename,
      bytes: part.content.length,
      sha256: sha256(part.content),
      decoded: part.filename.startsWith('base64;') ? Buffer.from(part.content.toString('utf8'), 'base64') : part.content,
    }));
    const generation = { id, data, files, rawBytes: raw.length };
    upstreamState.generations.push(generation);
    const leaf = `leaf-${id}-${upstreamState.generations.length}`;
    conversation.leaf = leaf;
    conversation.messages.push({ id: leaf });
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
    res.end(JSON.stringify({ type: 'stream', token: `reply-${upstreamState.generations.length}` }) + '\n');
    return;
  }

  jsonResponse(res, 404, { error: 'not found' });
});
await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstreamServer.address().port;
const serverPort = 20000 + Math.floor(Math.random() * 1000);
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
    CONTEXT_COMPACT_THRESHOLD_BYTES: '1',
    NODE_OPTIONS: '--max-old-space-size=512',
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

async function chat(payload) {
  const response = await fetch(`http://127.0.0.1:${serverPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { response, body: JSON.parse(text) };
}

try {
  await waitForServer();
  const novel15k = `START-15K\n${'潮汐与灯塔。'.repeat(2200)}\nMID-15K\n${'旧城档案。'.repeat(2200)}\nEND-15K`;
  const first = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: novel15k }] });
  assert.equal(first.response.status, 200, `first response failed: ${JSON.stringify(first.body)}\n${childOutput.join('')}`);
  assert.equal(first.body.choices[0].message.content, 'reply-1');
  const firstGeneration = upstreamState.generations[0];
  const firstFile = firstGeneration.files.find((file) => file.filename === 'base64;context_document.txt');
  assert.ok(firstFile, '15KB prompt is a real multipart context file');
  const firstDecoded = firstFile.decoded.toString('utf8');
  assert.ok(firstDecoded.includes('START-15K') && firstDecoded.includes('MID-15K') && firstDecoded.includes('END-15K'));
  assert.equal(sha256(firstFile.decoded), sha256(Buffer.from(novel15k, 'utf8')));
  assert.equal(firstFile.decoded.length, Buffer.byteLength(novel15k, 'utf8'));

  const conversationId = first.body.conversation_id;
  assert.ok(conversationId);
  const getsBeforeSecond = upstreamState.gets;
  const second = await chat({
    model: 'sakana-namazu',
    stream: false,
    history_mode: 'full',
    conversation_id: conversationId,
    messages: [
      { role: 'user', content: novel15k },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'SECOND-TURN-MARKER' },
    ],
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.body.conversation_id, conversationId);
  const secondGeneration = upstreamState.generations[1];
  assert.equal(secondGeneration.id, conversationId);
  assert.ok(String(secondGeneration.data.inputs).includes('SECOND-TURN-MARKER'));
  assert.equal(String(secondGeneration.data.inputs).includes('START-15K'), false, 'full history sends only new suffix');
  assert.equal(upstreamState.gets, getsBeforeSecond + 1, 'cached leaf avoids a preflight GET; finalization performs one refresh');

  const delta = await chat({
    model: 'sakana-namazu',
    stream: false,
    conversation_id: conversationId,
    messages: [{ role: 'user', content: 'DELTA-TURN-MARKER' }],
  });
  assert.equal(delta.response.status, 200);
  assert.equal(delta.body.conversation_id, conversationId);
  assert.ok(String(upstreamState.generations[2].data.inputs).includes('DELTA-TURN-MARKER'));

  const novel200k = `START-200K\n${'春雨落在纸页上。'.repeat(15000)}\nMID-200K\n${'远方的列车穿过雪线。'.repeat(15000)}\nEND-200K`;
  const large = await chat({ model: 'sakana-namazu', stream: false, messages: [{ role: 'user', content: novel200k }] });
  assert.equal(large.response.status, 200);
  const largeFile = upstreamState.generations[3].files.find((file) => file.filename === 'base64;context_document.txt');
  assert.ok(largeFile, '200KB novel is uploaded as a context file');
  const largeDecoded = largeFile.decoded.toString('utf8');
  assert.ok(largeDecoded.includes('START-200K') && largeDecoded.includes('MID-200K') && largeDecoded.includes('END-200K'));
  assert.ok(largeFile.decoded.length > 200_000, `200KB file remains complete: ${largeFile.decoded.length}`);

  const attachment = `ATTACHMENT-START\n${'附件正文。'.repeat(18000)}\nATTACHMENT-END`;
  const attached = await chat({
    model: 'sakana-namazu',
    stream: false,
    messages: [{ role: 'user', content: [
      { type: 'text', text: '请阅读附件全文' },
      { type: 'file', name: 'novel.txt', source: { type: 'base64', media_type: 'text/plain', data: Buffer.from(attachment).toString('base64') } },
    ] }],
  });
  assert.equal(attached.response.status, 200);
  const attachmentGeneration = upstreamState.generations[4];
  const attachmentFile = attachmentGeneration.files.find((file) => file.filename === 'base64;novel.txt');
  const attachmentPayload = attachmentFile ? attachmentFile.decoded.toString('utf8') : String(attachmentGeneration.data.inputs || '');
  assert.ok(attachmentPayload.includes('ATTACHMENT-START') && attachmentPayload.includes('ATTACHMENT-END'));
  const attachmentStart = attachmentPayload.indexOf('ATTACHMENT-START');
  const attachmentSlice = attachmentPayload.slice(attachmentStart, attachmentStart + attachment.length);
  assert.equal(sha256(Buffer.from(attachmentSlice)), sha256(Buffer.from(attachment)));
  assert.ok(attachmentPayload.length > attachment.length, `text attachment is not truncated before upstream: ${attachmentPayload.length}`);

  assert.equal(upstreamState.compacts, 3, `each conversation compacts once: ${upstreamState.compacts}`);

  // JSON packaging (context_format:'json'): turn-structured context document.
  const jsonTurnA = `JSON-CH1\n${'第一章内容。'.repeat(2200)}\nMID-CH1`;
  const jsonTurnB = `JSON-CH2\n${'第二章内容。'.repeat(2200)}\nEND-CH2`;
  const jsonDoc = await chat({
    model: 'sakana-namazu',
    stream: false,
    context_format: 'json',
    messages: [
      { role: 'system', content: '你是连载小说续写助手' },
      { role: 'user', content: jsonTurnA },
      { role: 'assistant', content: '好的,我已读完第一章。' },
      { role: 'user', content: jsonTurnB },
    ],
  });
  assert.equal(jsonDoc.response.status, 200, `json packaging failed: ${JSON.stringify(jsonDoc.body)}\n${childOutput.join('')}`);
  const jsonGeneration = upstreamState.generations.at(-1);
  const jsonFile = jsonGeneration.files.find((file) => file.filename === 'base64;context_document.json');
  assert.ok(jsonFile, 'json packaging uploads context_document.json');
  const jsonParsed = JSON.parse(jsonFile.decoded.toString('utf8'));
  assert.equal(jsonParsed.schema, 'sakana-context/1');
  assert.ok(jsonParsed.system.includes('连载小说续写助手'), 'json document keeps system prompt');
  assert.equal(jsonParsed.turns.length, 3, 'json document keeps turn boundaries');
  assert.equal(jsonParsed.turns[0].role, 'user');
  assert.ok(jsonParsed.turns[0].content.includes('JSON-CH1') && jsonParsed.turns[0].content.includes('MID-CH1'), 'json turn 1 intact');
  assert.ok(jsonParsed.turns[2].content.includes('END-CH2'), 'json turn 3 intact');
  const requestText = String(jsonGeneration.data.inputs);
  assert.ok(requestText.includes('文档使用协议'), 'document protocol injected above user system');
  assert.ok(requestText.includes('唯一事实来源'), 'document protocol present');
  assert.ok(requestText.includes('sakana-context/1'), 'json wrapper mentions the schema');
  assert.ok(requestText.length < 6000, 'visible prompt stays bounded while document is attached');

  console.log(`long-context upstream tests: all passed (generations=${upstreamState.generations.length}, gets=${upstreamState.gets}, compacts=${upstreamState.compacts})`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(3000)]);
  upstreamServer.close();
}
