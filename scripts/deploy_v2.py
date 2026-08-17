#!/usr/bin/env python3
"""Deploy sakana-2api to the server WITHOUT clobbering live data files.

Preserves on the server: account_pool.json, session.json, keys.json, tempmail.json.
Kills the current 8787 listener via ss -tlnp pid extraction, then restarts with
DISPLAY=:99 (Xvfb) and detached setsid nohup.

Usage: python scripts/deploy_v2.py [--restart] [--sanitize-pool]
"""
import paramiko, os, sys, io, tarfile, json, time

SEC = json.load(open(os.path.join(os.path.dirname(__file__), '.ssh_secret.json')))
HOST = SEC['HOST']; PORT = int(SEC['PORT']); USER = SEC['USER']; PASS = SEC['PASS']
LOCAL = r'D:\workspaces\sakana-2api'
REMOTE = '/root/sakana-2api'

DO_RESTART = '--restart' in sys.argv
DO_SANITIZE = '--sanitize-pool' in sys.argv

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, PORT, USER, PASS, look_for_keys=False, allow_agent=False)
print(f'Connected to {HOST}')

def run(cmd, timeout=300):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    return code, out, err

# ---- 1. build tar (exclude credentials/live data) ----
buf = io.BytesIO()
tf = tarfile.open(fileobj=buf, mode='w:gz')
EXCLUDE_DIRS = {'.git', 'node_modules', '.playwright-mcp'}
EXCLUDE_PREFIXES = ('session.json', 'account_pool', 'keys.json', 'tempmail.json',
                    'tokens.json', 'server.log', 'mailmsg', 'mailtoken', 'raw_search', 'red',
                    'chunk-', 'capture_', 'probe_', 'replicate_', 'test_', 'dump_', 'ui_upload',
                    '*.png')
for root, dirs, files in os.walk(LOCAL):
    dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith('.')]
    for fn in files:
        if any(fn.startswith(p.rstrip('*')) for p in EXCLUDE_PREFIXES if not p.endswith('*')) or \
           any(fn.endswith(p.lstrip('*')) for p in EXCLUDE_PREFIXES if p.endswith('*')):
            continue
        if fn.endswith('.log'):
            continue
        full = os.path.join(root, fn)
        arc = os.path.relpath(full, LOCAL)
        tf.add(full, arcname=arc)
tf.close()
buf.seek(0)
print(f'tar built: {buf.getbuffer().nbytes / 1024:.0f} KB')

sftp = ssh.open_sftp()
with sftp.open(f'{REMOTE}/deploy.tar.gz', 'wb') as f:
    f.write(buf.read())
sftp.close()
print('uploaded deploy.tar.gz')

code, out, err = run(f'cd {REMOTE} && tar xzf deploy.tar.gz && rm deploy.tar.gz && echo EXTRACT_OK')
print(out, err[:300])

# ---- 2. optional pool sanitize: strip polluted uid/email labels (identity bleed) ----
if DO_SANITIZE:
    code, out, err = run(
        f"cd {REMOTE} && node -e \""
        f"const fs=require('fs');"
        f"const a=JSON.parse(fs.readFileSync('account_pool.json','utf8'));"
        f"a.forEach(x=>{{ const ses=((x.cookieHeader||'').match(/sakana-chat=([^;]+)/)||[])[1]||'';"
        f" x.uid=''; x.email=''; x.display=ses.slice(0,8)||('acct-'+(x.id||'').slice(0,6)); }});"
        f"fs.writeFileSync('account_pool.json',JSON.stringify(a,null,2));"
        f"console.log('sanitized', a.length);\""
    )
    print('sanitize:', out, err[:300])

# ---- 3. restart ----
if DO_RESTART:
    code, out, err = run("PID=$(ss -tlnp | grep ':8787' | grep -oP 'pid=\\K[0-9]+' | head -1); if [ -n \"$PID\" ]; then kill -9 $PID && echo killed=$PID; else echo no-listener; fi")
    print('kill:', out.strip(), err[:200])
    time.sleep(1.5)
    code, out, err = run(
        f"cd {REMOTE} && setsid nohup bash -c 'DISPLAY=:99 ACCOUNT_POOL_MIN=20 ACCOUNT_POOL_MAX=20 node server.js > server.log 2>&1' > /dev/null 2>&1 & sleep 4 && echo STARTED && tail -3 server.log")
    print('start:', out.strip(), err[:200])
    time.sleep(3)
    code, out, err = run("curl -s -m 8 http://127.0.0.1:8787/health; echo; curl -s -m 8 -H 'authorization: Bearer sk-sak-23e3bf82919da59eada7cacff83fc463332427093c159203' http://127.0.0.1:8787/api/accounts | head -c 200")
    print('health+accounts:', out.strip())

ssh.close()
print('Done.')