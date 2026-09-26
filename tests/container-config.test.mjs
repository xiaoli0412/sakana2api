import assert from 'node:assert/strict';
import fs from 'node:fs';

const entrypoint = fs.readFileSync(new URL('../docker-entrypoint.sh', import.meta.url), 'utf8');
const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

assert.match(entrypoint, /NODE_OPTIONS="\$\{NODE_OPTIONS:---max-old-space-size=1536\}"/);
assert.match(compose, /restart:\s+unless-stopped/);
assert.match(compose, /mem_limit:\s+\$\{MEMORY_LIMIT:-2g\}/);
assert.match(compose, /memswap_limit:\s+\$\{MEMORY_SWAP_LIMIT:-2g\}/);

console.log('container config tests: all passed');
