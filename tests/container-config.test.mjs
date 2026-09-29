import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const entrypoint = read('../docker-entrypoint.sh');
const compose = read('../docker-compose.yml');
const dockerignore = read('../.dockerignore');
const deploy = read('../scripts/deploy.py');
const deployV2 = read('../scripts/deploy_v2.py');

assert.match(entrypoint, /NODE_OPTIONS="\$\{NODE_OPTIONS:---max-old-space-size=1536\}"/);
assert.match(compose, /restart:\s+unless-stopped/);
assert.match(compose, /mem_limit:\s+\$\{MEMORY_LIMIT:-2g\}/);
assert.match(compose, /memswap_limit:\s+\$\{MEMORY_SWAP_LIMIT:-2g\}/);
assert.match(compose, /source:\s+\.\/runtime[ \t]*\n[ \t]+target:\s+\/app\/runtime/);
assert.match(compose, /SAKANA_SESSION_FILE:\s+\/app\/runtime\/session\.json/);
assert.match(compose, /SAKANA_ACCOUNT_POOL_FILE:\s+\/app\/runtime\/account_pool\.json/);
assert.match(compose, /for name in session\.json account_pool\.json account_pool\.remote\.json keys\.json tempmail\.json tokens\.json/);
assert.match(compose, /ln -s "\$\$runtime\/\$\$name" "\/app\/\$\$name"/);
assert.doesNotMatch(compose, /\.\/(?:session|account_pool|keys|tempmail)\.json\s*:\s*\/app\//);
assert.doesNotMatch(compose, /\.\/\.browser-profile\s*:\s*\/app\/\.browser-profile/);

const deploySources = [['deploy_v2.py', deployV2]];
assert.match(deploy, /from deploy_v2 import main/);
assert.doesNotMatch(deploy, /AutoAddPolicy|38\.76\.190\.150|paramiko\.SSHClient/);

for (const [name, source] of deploySources) {
  assert.match(source, /RUNTIME_STATE_BASENAMES\s*=\s*\(/, `${name} must define runtime basenames`);
  for (const basename of ['session.json', 'account_pool.json', 'account_pool.remote.json', 'keys.json', 'tempmail.json', 'tokens.json']) {
    assert.match(source, new RegExp(`['"]${basename.replace('.', '\\.') }['"]`), `${name} must exclude ${basename}`);
  }
  assert.match(source, /EXCLUDE_BASENAMES\s*=\s*set\(RUNTIME_STATE_BASENAMES\)\s*\|\s*\{/ , `${name} must derive exclusions from runtime basenames`);
  assert.match(source, /\.ssh_secret\.json/);
  assert.match(source, /server\.log/);
  assert.match(source, /EXCLUDE_SUFFIXES\s*=\s*\(/);
  assert.match(source, /\.pem/);
  assert.match(source, /\.pfx/);
  assert.ok(source.includes("'runtime', 'scripts/.ssh_secret.json'"), `${name} must exclude SSH secret path`);
  assert.match(source, /PROJECT_ROOT\s*=\s*Path\(__file__\)\.resolve\(\)\.parents\[1\]/);
  assert.match(source, /is_env_file\(.*basename/);
  assert.match(source, /RejectPolicy\(\)/);
  assert.match(source, /known_hosts/);
  assert.match(source, /npm ci --omit=dev/);
  assert.match(source, /start_sakana\.sh/);
  assert.doesNotMatch(source, /AutoAddPolicy/);
  assert.doesNotMatch(source, /38\.76\.190\.150/);
  assert.doesNotMatch(source, /LOCAL = r'D:\\\\workspaces\\\\sakana-2api'/);
}


assert.match(dockerignore, /^runtime\/$/m);
assert.match(dockerignore, /^\.ssh_secret\.json$/m);
assert.match(dockerignore, /^scripts\/\.ssh_secret\.json$/m);
for (const pattern of ['session*.json', 'account_pool*.json', 'keys*.json', 'tempmail*.json']) {
  assert.ok(dockerignore.split(/\r?\n/).includes(pattern), `dockerignore must exclude ${pattern}`);
}
assert.match(dockerignore, /^\.browser-profile\/$/m);

const archiveProbe = spawnSync(process.execPath, ['-e', `
const fs = require('node:fs');
const source = fs.readFileSync('scripts/deploy_v2.py', 'utf8');
for (const name of ['session.json', 'account_pool.json', 'tokens.json', 'keys.json', '.env', 'scripts/.ssh_secret.json']) {
  if (!source.includes(name)) process.exit(2);
}
`,], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
assert.equal(archiveProbe.status, 0, 'deployment archive exclusions are present');

console.log('container config tests: all passed');
