#!/usr/bin/env python3
"""Deploy sakana-2api to server via paramiko (SFTP)."""
import paramiko, os, sys, tarfile, io

import json as _json
try:
    with open(os.path.join(os.path.dirname(__file__), '.ssh_secret.json')) as _f:
        _sec = _json.load(_f)
except FileNotFoundError:
    _sec = {}
HOST = os.environ.get('SAKANA_SSH_HOST', _sec.get('HOST', '38.76.190.150'))
PORT = int(os.environ.get('SAKANA_SSH_PORT', _sec.get('PORT', 22)))
USER = os.environ.get('SAKANA_SSH_USER', _sec.get('USER', 'root'))
PASS = os.environ.get('SAKANA_SSH_PASS', _sec.get('PASS', ''))
LOCAL = r'D:\workspaces\sakana-2api'
REMOTE = '/root/sakana-2api'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, PORT, USER, PASS, look_for_keys=False, allow_agent=False)
print(f'Connected to {HOST}')

# Create remote dir
ssh.exec_command(f'mkdir -p {REMOTE}')

# Upload via tar-pipe through SFTP
sftp = ssh.open_sftp()

# Build tar in memory, excluding temp files
buf = io.BytesIO()
tar = tarfile.open(fileobj=buf, mode='w:gz')
exclude = {'.git', 'node_modules', 'session.json', 'tokens.json', 'server.log', 'raw_search.txt', 'raw_search_full.txt', 'red.png', 'red64.png', 'chunk-1ceo.js', 'chunk-messages.js', 'mailmsg.json', 'mailtoken.json', 'tempmail.json', 'success_sample.json', 'capture_', 'scan_', 'probe_', 'replicate_', 'test_', 'dump_', 'check_', 'ui_upload', 'brute_stream', 'tamper_test', 'net_trace', 'debug_stream', 'harvest_session', 'find_bundle', 'firebase_login', 'node_replay_sample', 'open_magic_link', 'click_login', 'compare_auth', 'complete_login', 'do_login', 'capture_', 'chunk-'}
for root, dirs, files in os.walk(LOCAL):
    for dn in list(dirs):
        if dn in exclude or dn.startswith('.'):
            dirs.remove(dn)
    for fn in files:
        if any(fn.startswith(p) for p in exclude):
            continue
        if fn.endswith(('.exe', '.png', '.txt')) and not fn in ('README.md', 'requirements.txt'):
            continue
        local = os.path.join(root, fn)
        remote = os.path.relpath(local, LOCAL)
        try:
            tar.add(local, arcname=remote)
        except Exception as e:
            print(f'  skip {remote}: {e}')
tar.close()
buf.seek(0)

# Write tar to remote via SFTP
with sftp.open(f'{REMOTE}/project.tar.gz', 'wb') as f:
    f.write(buf.read())
print('Uploaded project.tar.gz')

# Extract remotely
stdin, stdout, stderr = ssh.exec_command(f'cd {REMOTE} && tar xzf project.tar.gz && rm project.tar.gz && ls -la')
print(stdout.read().decode())
err = stderr.read().decode()
if err:
    print('stderr:', err[:500])

# Test
stdin, stdout, stderr = ssh.exec_command(f'cd {REMOTE} && node server.js &')
import time
time.sleep(2)
stdin, stdout, stderr = ssh.exec_command(f'curl -s -m 10 http://127.0.0.1:8787/health')
print('Health:', stdout.read().decode())

stdin, stdout, stderr = ssh.exec_command(f'cat {REMOTE}/server.log')
print('Log:', stdout.read().decode()[-500:])

print('Done!')
ssh.close()