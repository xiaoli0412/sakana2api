// Build the optional Rust native module (napi-rs) into native/index.node.
// Purely opt-in: node scripts/build-native.mjs — requires cargo. The JS
// fallbacks in lib/native.js keep every caller working when the module is
// absent (fresh clone, CI without Rust, SAKANA_NATIVE=0).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nativeDir = path.join(root, 'native');

execSync('cargo build --release', { cwd: nativeDir, stdio: 'inherit' });

const libName = process.platform === 'win32' ? 'sakana_native.dll'
  : process.platform === 'darwin' ? 'libsakana_native.dylib'
  : 'libsakana_native.so';
const built = path.join(nativeDir, 'target', 'release', libName);
const out = path.join(nativeDir, 'index.node');
fs.copyFileSync(built, out);
console.log(`[build-native] ${path.relative(root, built)} -> ${path.relative(root, out)}`);
