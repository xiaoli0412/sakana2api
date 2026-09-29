import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proxyPort = 25000 + Math.floor(Math.random() * 8000);
const upstreamPort = proxyPort + 1;
const base = `http://127.0.0.1:${proxyPort}`;
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;
const apiKey = 'shutdown-business-key';
const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sakana-shutdown-'));
const sessionFile = path.join(tempDir, 'session.json');
const poolFile = path.join(tempDir, 'account-pool.json');

let upstreamGenerateRequests = 0;
let upstreamConnections = 0;
let upstreamClosed = 0;
let upstreamStreamResponse = null;

const upstream = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/conversation') {
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ conversationId: 'shutdown-conversation', systemMessageId: 'system-message' }));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/conversation/shutdown-conversation') {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ messages: [{ id: 'system-message', role: 'system', children: [] }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/conversation/shutdown-conversation') {
    upstreamGenerateRequests++;
    upstreamConnections++;
    upstreamStreamResponse = res;
    res.writeHead(200, { 'content-type': 'application/x-ndjson', connection: 'keep-alive' });
    res.write(JSON.stringify({ type: 'message_start', id: 'assistant-message' }) + '\n');
    res.write(JSON.stringify({ type: 'stream', token: 'hello' }) + '\n');
    req.once('close', () => {
      upstreamClosed++;
    });
    res.once('close', () => {
      upstreamClosed++;
    });
    return;
  }
  res.writeHead(404, { connection: 'close' });
  res.end();
});

const childOutput = [];
let child = null;

function request(pathname, options = {}) {
  return fetch(base + pathname, {
    ...options,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(options.headers || {}),
    },
  });
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error('condition timed out');
}

async function waitForProxy() {
  await waitFor(async () => {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      return response.ok;
    } catch {
      return false;
    }
  });
}

async function stopChild() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  const started = Date.now();
  child.kill('SIGTERM');
  const result = await Promise.race([
    exited.then(() => ({ exited: true, elapsed: Date.now() - started })),
    delay(5_000).then(() => ({ exited: false, elapsed: Date.now() - started })),
  ]);
  if (!result.exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), delay(2_000)]);
  }
  assert.equal(result.exited, true, `proxy exits during shutdown drain (${childOutput.join('')})`);
  assert.ok(result.elapsed <= 4_000, `proxy exits within bounded shutdown time (${result.elapsed}ms)`);
}

try {
  await fs.promises.writeFile(sessionFile, JSON.stringify({
    savedAt: Date.now(),
    cookieHeader: 'sakana-chat=fake-session',
    cookies: [{ name: 'sakana-chat', value: 'fake-session', domain: '127.0.0.1', path: '/' }],
    uid: 'shutdown-user',
    email: 'shutdown@example.test',
  }));
  await fs.promises.writeFile(poolFile, '[]');

  await new Promise((resolve, reject) => {
    upstream.listen(upstreamPort, '127.0.0.1', (error) => error ? reject(error) : resolve());
  });

  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      AUTO_SESSION: 'false',
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      API_KEY: apiKey,
      ADMIN_API_KEY: apiKey,
      SAKANA_BASE: upstreamBase,
      SAKANA_SESSION_FILE: sessionFile,
      SAKANA_ACCOUNT_POOL_FILE: poolFile,
      CACHE_ENABLED: 'false',
      REQUEST_TIMEOUT_MS: '60000',
      SHUTDOWN_DRAIN_MS: '750',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => childOutput.push(chunk.toString()));
  child.stderr.on('data', (chunk) => childOutput.push(chunk.toString()));

  await waitForProxy();
  const requestPromise = request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'sakana-namazu',
      stream: true,
      messages: [{ role: 'user', content: 'hold this request open' }],
    }),
  });
  const response = await requestPromise;
  assert.equal(response.status, 200, 'stream starts before shutdown');
  await waitFor(() => upstreamGenerateRequests === 1);
  const reader = response.body.getReader();
  reader.closed.catch(() => {});
  const first = await reader.read();
  assert.equal(first.done, false, 'upstream stream produced initial data');
  const firstText = new TextDecoder().decode(first.value);
  assert.equal(firstText.includes('[DONE]'), false, 'initial stream has no synthetic DONE');

  const shutdownStarted = Date.now();
  const exitPromise = once(child, 'exit');
  child.kill('SIGTERM');
  const exited = await Promise.race([
    exitPromise.then(() => true),
    delay(4_000).then(() => false),
  ]);
  assert.equal(exited, true, `server exits after SIGTERM (${childOutput.join('')})`);
  assert.ok(Date.now() - shutdownStarted <= 3_500, 'SIGTERM shutdown stays within drain deadline');

  await waitFor(() => upstreamClosed > 0, 2_000);
  assert.ok(upstreamClosed > 0, 'shutdown closes the hanging upstream stream');
  let clientClosed = false;
  try {
    const afterShutdown = await reader.read();
    clientClosed = afterShutdown.done === true;
  } catch {
    clientClosed = true;
  }
  assert.equal(clientClosed, true, 'client stream is closed after shutdown');

  await assert.rejects(
    () => request('/health', { signal: AbortSignal.timeout(500) }),
    /fetch failed|ECONNREFUSED|aborted|closed/i,
    'server no longer accepts requests after shutdown',
  );

  console.log(`shutdown cleanup tests: all passed (upstreamClosed=${upstreamClosed}, elapsed=${Date.now() - shutdownStarted}ms)`);
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), delay(2_000)]);
  }
  if (upstreamStreamResponse && !upstreamStreamResponse.writableEnded) upstreamStreamResponse.destroy();
  await new Promise((resolve) => upstream.close(() => resolve()));
  await fs.promises.rm(tempDir, { recursive: true, force: true });
}
