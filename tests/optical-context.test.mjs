// Integration test: writer profile optical second-stage compression renders
// the older portion of a huge context document into PNG pages while the
// recent tail stays as the txt attachment. Uses the real headless Chromium.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamState = { nextConversation: 1, conversations: new Map(), generations: [] };

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
    const parts = parseMultipart(raw, req.headers['content-type']);
    const dataPart = parts.find((part) => part.name === 'data');
    const data = JSON.parse(dataPart.content.toString('utf8'));
    const files = parts.filter((part) => part.name === 'files').map((part) => ({
      filename: part.filename,
      bytes: part.content.length,
      sha256: sha256(part.content),
      decoded: part.filename.startsWith('base64;') ? Buffer.from(part.content.toString('utf8'), 'base64') : part.content,
    }));
    upstreamState.generations.push({ id, data, files });
    const leaf = `leaf-${upstreamState.generations.length}`;
    conversation.leaf = leaf;
    conversation.messages.push({ id: leaf });
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
    res.end(JSON.stringify({ type: 'stream', token: 'ok' }) + '\n');
    return;
  }
  jsonResponse(res, 404, { error: 'not found' });
});
await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstreamServer.address().port;
const serverPort = 22000 + Math.floor(Math.random() * 1000);
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
    OPTICAL_CONTEXT_THRESHOLD: '6000',
    OPTICAL_MAX_PAGES: '4',
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

try {
  await waitForServer();
  const novel = `OPTICAL-START\n${'长篇小说正文,用于光学压缩验证。'.repeat(6000)}\nOPTICAL-MID\n${'后续章节内容继续填充上下文。'.repeat(2000)}\nOPTICAL-END`;
  const response = await fetch(`http://127.0.0.1:${serverPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'sakana-writer', stream: false, messages: [{ role: 'user', content: novel }] }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, `request failed: ${responseText}\n${childOutput.join('')}`);

  const generation = upstreamState.generations.at(-1);
  const pageFiles = generation.files
    .filter((file) => /^base64;context_page-\d+\.png$/.test(file.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename));
  assert.ok(pageFiles.length >= 2, `older portion rendered into page images: ${pageFiles.length}`);
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const file of pageFiles) {
    assert.ok(file.decoded.subarray(0, 8).equals(pngMagic), `${file.filename} is a real PNG`);
    assert.ok(file.decoded.length > 20_000, `${file.filename} has meaningful content (${file.decoded.length} bytes)`);
  }

  const recentFile = generation.files.find((file) => file.filename === 'base64;context_document.txt');
  assert.ok(recentFile, 'recent tail remains as context_document.txt');
  const recentText = recentFile.decoded.toString('utf8');
  assert.ok(recentText.includes('OPTICAL-MID') && recentText.includes('OPTICAL-END'), 'recent tail keeps the near content');
  assert.ok(!recentText.includes('OPTICAL-START'), 'older portion moved out of the txt tail');

  const prompt = String(generation.data.inputs);
  assert.ok(prompt.includes('context_page-01'), 'prompt references the page images');
  assert.ok(prompt.includes('先读取全部图片页'), 'prompt instructs reading pages first');

  console.log(`optical context tests: all passed (pages=${pageFiles.length})`);
} finally {
  child.kill('SIGKILL');
  await new Promise((resolve) => upstreamServer.close(resolve));
}
