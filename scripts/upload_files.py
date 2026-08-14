#!/usr/bin/env python3
"""Upload changed files to the sakana-2api server via paramiko.

Credentials come from scripts/.ssh_secret.json (gitignored) or env vars.
"""
import paramiko, os, sys, json

SECRET = os.path.join(os.path.dirname(__file__), '.ssh_secret.json')
try:
    with open(SECRET) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
HOST = os.environ.get('SAKANA_SSH_HOST', cfg.get('HOST', '38.76.190.150'))
PORT = int(os.environ.get('SAKANA_SSH_PORT', cfg.get('PORT', 22)))
USER = os.environ.get('SAKANA_SSH_USER', cfg.get('USER', 'root'))
PASS = os.environ.get('SAKANA_SSH_PASS', cfg.get('PASS', ''))
REMOTE = '/root/sakana-2api'
LOCAL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

files = sys.argv[1:] or ['lib/auto-session.js', 'lib/translate.js', 'server.js',
                         '.gitignore', 'package.json', 'package-lock.json']

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, PORT, USER, PASS, look_for_keys=False, allow_agent=False, timeout=20)
print('Connected')

sftp = ssh.open_sftp()
for f in files:
    src = os.path.join(LOCAL, f.replace('/', os.sep))
    dst = os.path.join(REMOTE, f).replace(os.sep, '/')
    sftp.put(src, dst)
    print('uploaded', f)

def run(cmd):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=300)
    out = stdout.read().decode()
    err = stderr.read().decode()
    return out + ('\nSTDERR: ' + err if err.strip() else '')

print(run(f'cd {REMOTE} && node --check lib/auto-session.js && node --check lib/translate.js && node --check server.js && echo SYNTAX_OK'))
sftp.close()
ssh.close()
print('DONE')