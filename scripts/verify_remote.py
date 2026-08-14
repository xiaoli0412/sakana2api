#!/usr/bin/env python3
"""Remote verification suite for the deployed sakana-2api server."""
import paramiko, json, time, sys, os

SECRET = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.ssh_secret.json')
try:
    with open(SECRET) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
HOST = os.environ.get('SAKANA_SSH_HOST', cfg.get('HOST', '38.76.190.150'))
PORT = int(os.environ.get('SAKANA_SSH_PORT', cfg.get('PORT', 22)))
USER = os.environ.get('SAKANA_SSH_USER', cfg.get('USER', 'root'))
PASS = os.environ.get('SAKANA_SSH_PASS', cfg.get('PASS', ''))

ssh = None
for attempt in range(3):
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(HOST, PORT, USER, PASS, look_for_keys=False, allow_agent=False, timeout=30, banner_timeout=30)
        break
    except Exception as e:
        print('conn retry', attempt, str(e)[:60]); time.sleep(8)
if not ssh:
    sys.exit('no ssh')

def run(cmd, timeout=300):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode() + stderr.read().decode()

def call_api(payload, timeout=180):
    body = json.dumps(payload).replace('"', '\\"')
    cmd = f'''curl -s -m {timeout} -X POST http://127.0.0.1:8787/v1/chat/completions -H 'content-type: application/json' -d "{body}" '''
    return run(cmd)

print('[1] health:', run('curl -s -m 10 http://127.0.0.1:8787/health', 30).strip())
print('[2] models:', run('curl -s -m 10 http://127.0.0.1:8787/v1/models', 30).strip()[:120])

r = call_api({"model": "sakana-namazu", "messages": [{"role": "user", "content": "Reply with exactly: PROXY-OK"}], "stream": False})
try:
    j = json.loads(r)
    print('[3] chat non-stream:', j.get('choices')[0]['message']['content'][:60])
except Exception:
    print('[3] chat non-stream RAW:', r[:200])

r = call_api({"model": "sakana-namazu:osaka", "messages": [{"role": "user", "content": "オオサカな一言で挨拶して"}], "stream": False})
try:
    j = json.loads(r)
    print('[4] osaka style:', j.get('choices')[0]['message']['content'][:60])
except Exception:
    print('[4] osaka RAW:', r[:200])

r = call_api({"model": "sakana-namazu", "messages": [{"role": "user", "content": "Tell me the color of the sky, one word."}], "stream": False, "reasoning_effort": "high"})
try:
    j = json.loads(r)
    print('[5] thinking len:', len(j.get('choices')[0]['message'].get('reasoning_content', '')))
except Exception:
    print('[5] thinking RAW:', r[:200])

r = call_api({"model": "sakana-namazu:web", "messages": [{"role": "user", "content": "search web: what is the capital of Japan? one word"}], "stream": False})
try:
    j = json.loads(r)
    print('[6] web search:', j.get('choices')[0]['message']['content'][:80])
except Exception:
    print('[6] web RAW:', r[:200])

ssh.close()
print('DONE')