// Local micro-benchmark: Rust native vs JS reference on the two wired hot
// paths (attachment SHA-256, UTF-8 byte clamp). No upstream, no credentials.
// Usage: node scripts/bench_native.mjs [bufferMB]
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const native = require(path.join(root, 'lib', 'native.js'));

const mb = Math.max(0.1, Number.parseFloat(process.argv[2] || '8') || 8);
const buf = Buffer.alloc(Math.round(mb * 1024 * 1024));
for (let i = 0; i < buf.length; i += 4096) crypto_randomFill(buf, i);
function crypto_randomFill(b, off) {
  for (let j = 0; j < 4096 && off + j < b.length; j++) b[off + j] = (off + j) & 0xff;
}

function bench(label, fn, iters) {
  fn(); // warmup
  const t0 = performance.now();
  let sink = '';
  for (let i = 0; i < iters; i++) sink = fn();
  const dt = performance.now() - t0;
  if (!sink) throw new Error('empty sink');
  return dt / iters;
}

console.log(`buffer: ${mb}MB x sha256, clamp text: ${mb}MB string`);
const text = Buffer.from(buf).toString('latin1');

const jsMs = bench('js sha256', () => createHash('sha256').update(buf).digest('hex'), 20);
const nativeMs = native.available ? bench('native sha256', () => native.sha256Hex(buf), 20) : jsMs;
console.log(`sha256Hex   js=${jsMs.toFixed(2)}ms  native=${nativeMs.toFixed(2)}ms  speedup=${(jsMs / nativeMs).toFixed(2)}x`);

const clampLimit = Math.round(buf.length / 2);
const jsClampMs = bench('js clamp', () => native.jsUtf8ClampBytes(text, clampLimit), 20);
const nativeClampMs = native.available ? bench('native clamp', () => native.utf8ClampBytes(text, clampLimit), 20) : jsClampMs;
console.log(`utf8Clamp   js=${jsClampMs.toFixed(2)}ms  native=${nativeClampMs.toFixed(2)}ms  speedup=${(jsClampMs / nativeClampMs).toFixed(2)}x`);
console.log(`native module: ${native.available ? 'loaded v' + native.version : 'NOT BUILT (JS fallback in use)'}`);
