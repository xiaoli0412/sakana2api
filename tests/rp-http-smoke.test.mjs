import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let upstreamRequests = 0;
const upstream = createServer((req, res) => {
  upstreamRequests++;
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'RP smoke must not reach upstream' }));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;
const port = 21000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    AUTO_SESSION: 'false',
    API_KEY: '',
    HOST: '127.0.0.1',
    PORT: String(port),
    SAKANA_BASE: `http://127.0.0.1:${upstreamPort}`,
    SAKANA_SESSION_FILE: path.join(root, '.rp-smoke-missing-session.json'),
    SAKANA_ACCOUNT_POOL_FILE: path.join(root, '.rp-smoke-missing-pool.json'),
    CACHE_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output = [];
child.stdout.on('data', (chunk) => output.push(chunk.toString()));
child.stderr.on('data', (chunk) => output.push(chunk.toString()));

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`server did not become ready\n${output.join('')}`);
}

async function request(pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { response, json };
}

try {
  await waitForServer();
  const cases = [
    ['chat', '/v1/chat/completions', { model: 'sakana-namazu-rp', messages: [{ role: 'user', content: 'nope' }], stream: false }],
    ['legacy', '/v1/completions', { model: 'sakana-fugu-rp', prompt: 'nope', stream: false }],
    ['responses', '/v1/responses', { model: 'sakana-namazu:rp', input: 'nope', stream: false }],
    ['anthropic', '/v1/messages', { model: 'sakana-namazu-rp', max_tokens: 20, messages: [{ role: 'user', content: 'nope' }] }],
    ['gemini route', '/v1beta/models/sakana-namazu-rp:generateContent', { contents: [{ role: 'user', parts: [{ text: 'nope' }] }] }],
    ['gemini body', '/v1beta/models/gemini-2.5-flash:generateContent', { model: 'sakana-fugu-rp', contents: [{ role: 'user', parts: [{ text: 'nope' }] }] }],
  ];

  for (const [name, pathname, body] of cases) {
    const { response, json } = await request(pathname, body);
    assert.equal(response.status, 400, `${name}: ${JSON.stringify(json)}`);
    if (name.startsWith('gemini')) {
      assert.match(String(json.error?.message || ''), /RP-MODEL-DISABLED/);
    } else {
      assert.equal(json.error?.code, 'RP-MODEL-DISABLED', `${name}: ${JSON.stringify(json)}`);
      assert.equal(json.error?.type, 'invalid_request_error');
    }
  }
  assert.equal(upstreamRequests, 0, 'disabled RP requests must not reach upstream');
  console.log('RP HTTP smoke: all routes returned 400 before upstream');
} finally {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(3000)]);
  upstream.close();
}
