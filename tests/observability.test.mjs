import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 19000 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, AUTO_SESSION: 'false', PORT: String(port), API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  let ready = false;
  const deadline = Date.now() + 10000;
  while (!ready && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      ready = response.ok;
    } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'server starts for health test');
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.uptimeSec, 'number');
  for (const field of ['rssMB', 'heapUsedMB', 'heapTotalMB', 'externalMB', 'arrayBuffersMB']) {
    assert.equal(typeof health.memory[field], 'number', `health memory includes ${field}`);
  }
  const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
  assert.equal(typeof stats.ops.browser.hasContext, 'boolean');
  assert.equal(typeof stats.ops.browser.launches, 'number');
  assert.equal(Object.hasOwn(stats.ops.browser, 'cookieHeader'), false);
  console.log('observability tests: all passed');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}
