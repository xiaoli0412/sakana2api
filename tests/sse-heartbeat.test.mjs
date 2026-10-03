// SSE heartbeat + long-context attachment purity regression (v0.18.5):
// 1) streams emit `: ping` comment frames during slow phases
// 2) client tool schemas never enter the synthetic context attachment
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 24000 + Math.floor(Math.random() * 10000);
const upPort = 24000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;

// Fake upstream: slow bootstrap (300ms) + NDJSON stream, captures multipart
let capturedMultipart = '';
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && /multipart/.test(req.headers['content-type'] || '')) {
      capturedMultipart = body.toString('utf8');
    }
    if (req.method === 'POST' && req.url === '/api/conversation') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ conversationId: 'conv-hb', systemMessageId: 'sys-1' }));
      }, 800);
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/conversation/')) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ type: 'stream', token: 'hello ' }) + '\n');
      setTimeout(() => {
        res.write(JSON.stringify({ type: 'stream', token: 'world' }) + '\n');
        res.write(JSON.stringify({ type: 'finalAnswer', text: 'hello world' }) + '\n');
        res.end();
      }, 1500);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: 'sys-1', children: [] }] }));
  });
});
await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sakana-hb-'));
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    AUTO_SESSION: 'false',
    HOST: '127.0.0.1',
    PORT: String(port),
    SAKANA_BASE: `http://127.0.0.1:${upPort}`,
    SAKANA_COOKIE: 'sakana-chat=fake',
    SAKANA_SESSION_FILE: path.join(tempDir, 'session.json'),
    SAKANA_ACCOUNT_POOL_FILE: path.join(tempDir, 'pool.json'),
    SAKANA_KEYS_FILE: path.join(tempDir, 'keys.json'),
    CACHE_ENABLED: 'false',
    SSE_HEARTBEAT_MS: '1000',
    SHUTDOWN_DRAIN_MS: '500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.resume();
child.stderr.resume();

try {
  await delay(1200);

  // 1) heartbeat frames present in a slow stream
  const resp = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'sakana', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  const raw = await resp.text();
  assert.ok(raw.includes(': ping'), 'SSE stream carries heartbeat comments');
  assert.ok(raw.includes('data: [DONE]'), 'stream still terminates with [DONE]');
  const dataLines = raw.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
  assert.ok(dataLines.length >= 2, 'content chunks still delivered');

  // 2) giant client tool schemas stay out of the synthetic attachment
  const bigSchema = Array.from({ length: 20 }, (_, i) => ({
    type: 'function',
    function: {
      name: `hb_tool_${i}`,
      description: 'H ' + 'x'.repeat(900),
      parameters: { type: 'object', properties: { p: { type: 'string', description: 'y'.repeat(600) } } },
    },
  }));
  const longUser = '正文设定'.padEnd(16000, '内容。');
  const resp2 = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'sakana-writer', messages: [{ role: 'user', content: longUser }], tools: bigSchema, stream: false }),
  });
  assert.equal(resp2.status, 200);
  await resp2.text();
  assert.ok(capturedMultipart.includes('context_document'), 'long prompt packaged as attachment');
  // Purity applies to the ATTACHMENT part only: the visible prompt legitimately
  // carries the compact tool hint (names + protocol); the sandbox document must not.
  const attMatch = /filename="base64;context_document\.txt"\r\nContent-Type: text\/plain\r\n\r\n([\s\S]*?)\r\n--/.exec(capturedMultipart);
  assert.ok(attMatch, 'attachment part present in multipart');
  const attText = Buffer.from(attMatch[1], 'base64').toString('utf8');
  assert.ok(!attText.includes('hb_tool_0'), 'tool schema must not enter the sandbox attachment');
  assert.ok(attText.includes('正文设定'), 'user content stays in the attachment');
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => {});
  upstream.close();
  await fs.promises.rm(tempDir, { recursive: true, force: true });
}

console.log('sse heartbeat + attachment purity tests: all passed');
