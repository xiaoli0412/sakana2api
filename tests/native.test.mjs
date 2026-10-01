// Native (Rust napi) hot-path tests: the accelerated implementations must be
// byte-exact against the JS reference on every fixture, and the fallback
// path must keep working when the binary is absent (SAKANA_NATIVE=0).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtures = [
  Buffer.alloc(0),
  Buffer.from('sakana'),
  Buffer.from('中文上下文 🐟 emoji boundary'),
  crypto.randomBytes(64 * 1024),
  crypto.randomBytes(1024 * 1024),
];

const childSrc = `
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(path.join(root, 'lib', 'native.js'))});
const native = require(${JSON.stringify(path.join(root, 'lib', 'native.js'))});
const fixtures = ${JSON.stringify(fixtures.map((f) => f.toString('base64')))}
  .map((b64) => Buffer.from(b64, 'base64'));
fixtures.forEach((buf, i) => {
  const got = native.sha256Hex(buf);
  const want = crypto.createHash('sha256').update(buf).digest('hex');
  assert.equal(got, want, 'sha fixture ' + i);
});
const clampCases = [
  ['a\\u{1F44D}b\\u4E2D\\u6587', 5], ['a\\u{1F44D}b\\u4E2D\\u6587', 0], ['hello', 100],
  ['\\u65E5'.repeat(3000), 4096], ['x', 1],
];
for (const [s, max] of clampCases) {
  const buf = Buffer.from(s, 'utf8');
  let ref = s;
  if (buf.length > max) {
    let end = max;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
    ref = buf.subarray(0, end).toString('utf8');
  }
  const got = native.utf8ClampBytes(s, max);
  assert.equal(got, ref, 'clamp case max=' + max);
  assert.ok(Buffer.byteLength(got, 'utf8') <= max);
}
console.log('OK available=' + native.available);
`;

function run({ nativeEnabled }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakana-native-'));
  const file = path.join(dir, 'check.mjs');
  fs.writeFileSync(file, childSrc);
  try {
    return spawnSync(process.execPath, [file], {
      encoding: 'utf8',
      env: { ...process.env, SAKANA_NATIVE: nativeEnabled ? '1' : '0' },
      timeout: 30000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const withNative = run({ nativeEnabled: true });
assert.equal(withNative.status, 0, 'native path: ' + (withNative.stderr || withNative.stdout));
assert.match(withNative.stdout, /OK available=true/);

const fallback = run({ nativeEnabled: false });
assert.equal(fallback.status, 0, 'fallback path: ' + (fallback.stderr || fallback.stdout));
assert.match(fallback.stdout, /OK available=false/);

console.log('native hot-path tests: all passed (native + fallback byte-exact)');
