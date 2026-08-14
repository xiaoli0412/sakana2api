// Deploy script: SSH into server, install Node/Chrome, clone repo, start service
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const fs = require('fs');
const path = require('path');
// Credentials from scripts/.ssh_secret.json (gitignored) or env vars.
const _secPath = path.join(__dirname, '.ssh_secret.json');
const _sec = fs.existsSync(_secPath) ? JSON.parse(fs.readFileSync(_secPath, 'utf8')) : {};
const HOST = process.env.SAKANA_SSH_HOST || _sec.HOST || '38.76.190.150';
const PORT = Number(process.env.SAKANA_SSH_PORT || _sec.PORT || 22);
const USER = process.env.SAKANA_SSH_USER || _sec.USER || 'root';
const PASS = process.env.SAKANA_SSH_PASS || _sec.PASS || '';
const REMOTE_DIR = '/root/sakana-2api';

function sshExec(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-p', String(PORT), `${USER}@${HOST}`, cmd];
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => {
      const s = d.toString();
      err += s;
      // Send password when prompted
      if (s.toLowerCase().includes('password:')) {
        proc.stdin.write(PASS + '\n');
      }
    });
    proc.on('close', code => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`exit ${code}: ${err.slice(0, 500)}`));
    });
    proc.on('error', reject);
  });
}

async function deploy() {
  console.log('=== 1. Check server environment ===');
  try {
    const r = await sshExec('uname -a && echo "---NODE---" && node --version 2>/dev/null || echo "NODE_NOT_FOUND" && echo "---CHROME---" && (google-chrome --version 2>/dev/null || chromium --version 2>/dev/null || echo "CHROME_NOT_FOUND") && echo "---MEM---" && free -h | grep Mem');
    console.log(r.out);
  } catch (e) {
    // First connection might fail on password prompt timing
    console.log('Initial connect attempt:', e.message.slice(0, 100));
  }

  console.log('\n=== 2. Install Node.js if missing ===');
  try {
    const r = await sshExec('which node && node --version');
    if (r.out.includes('NODE_NOT_FOUND') || !r.out.includes('v')) {
      console.log('Installing Node.js...');
      await sshExec('curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs');
    } else {
      console.log('Node.js already installed:', r.out.trim());
    }
  } catch (e) { console.log('Node check:', e.message.slice(0, 100)); }

  console.log('\n=== 3. Create project directory & upload files ===');
  // We'll use a tar-pipe approach: tar the local project, pipe over SSH, extract
  await sshExec(`mkdir -p ${REMOTE_DIR}`);

  // Tar-pipe the project (excluding .git, node_modules, temp files)
  const tarProc = spawn('tar', ['czf', '-',
    '--exclude=.git', '--exclude=node_modules', '--exclude=session.json',
    '--exclude=tokens.json', '--exclude=server.log',
    '--exclude=*.png',
    '-C', '/d/workspaces/sakana-2api', '.']);
  
  const sshProc = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-p', String(PORT),
    `${USER}@${HOST}`, `tar xzf - -C ${REMOTE_DIR}`],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  
  let sshErr = '';
  let passwordSent = false;
  sshProc.stderr.on('data', d => {
    const s = d.toString();
    sshErr += s;
    if (s.toLowerCase().includes('password:') && !passwordSent) {
      passwordSent = true;
      sshProc.stdin.write(PASS + '\n');
    }
  });
  tarProc.stdout.pipe(sshProc.stdin);
  tarProc.stdout.on('end', () => { sshProc.stdin.end(); });

  await new Promise((resolve, reject) => {
    sshProc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`upload exit ${code}: ${sshErr.slice(0, 300)}`));
    });
    sshProc.on('error', reject);
  });
  console.log('Files uploaded successfully');

  console.log('\n=== 4. Install dependencies & start ===');
  console.log('(If Node/npm not found, install first)');
  await sshExec(`cd ${REMOTE_DIR} && npm install --production 2>&1 || true`);
  const start = await sshExec(`cd ${REMOTE_DIR} && nohup node server.js > server.log 2>&1 & sleep 2 && cat server.log`);
  console.log('Start result:', start.out);

  console.log('\n=== 5. Verify ===');
  const verify = await sshExec(`curl -s -m 10 http://127.0.0.1:8787/health`);
  console.log('Health check:', verify.out);

  console.log('\n✅ Deployment complete!');
  console.log(`API endpoint: http://${HOST}:8787/v1/chat/completions`);
}

deploy().catch(e => console.error('Deploy failed:', e.message));