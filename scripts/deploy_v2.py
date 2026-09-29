#!/usr/bin/env python3
"""Deploy sakana-2api through a verified temporary release directory."""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import shlex
import tarfile
import time

import paramiko


PROJECT_ROOT = Path(__file__).resolve().parents[1]
REMOTE = os.environ.get('SAKANA_REMOTE_DIR', '/root/sakana-2api')
RUNTIME_ROOT = os.environ.get('SAKANA_REMOTE_RUNTIME', f'{REMOTE}.runtime')
RUNTIME_STATE_BASENAMES = (
    'session.json',
    'account_pool.json',
    'account_pool.remote.json',
    'keys.json',
    'tempmail.json',
    'tokens.json',
)
EXCLUDE_DIR_BASENAMES = {
    '.git', '.zcode', 'node_modules', '.playwright-mcp', '.browser-profile',
    '.chrome-sakana-profile', 'character_cards', 'runtime', '__pycache__',
}
EXCLUDE_RELATIVE_PATHS = {
    'runtime', 'scripts/.ssh_secret.json', 'scripts/.env', 'scripts/.env.local',
}
EXCLUDE_BASENAMES = set(RUNTIME_STATE_BASENAMES) | {
    '.ssh_secret.json', 'server.log', 'mailmsg.json', 'mailtoken.json',
    'success_sample.json', 'Dockerfile.local',
}
EXCLUDE_SUFFIXES = (
    '.log', '.exe', '.zip', '.tar', '.tar.gz', '.tgz', '.gz', '.7z', '.rar',
    '.bak', '.db', '.sqlite', '.sqlite3', '.dump', '.pem', '.key', '.p12', '.pfx',
)
EXCLUDE_PREFIXES = (
    'raw_search', 'red', 'chunk-', 'mailmsg', 'mailtoken', 'success_sample',
    'capture_', 'scan_', 'probe_', 'replicate_', 'test_', 'dump_', 'check_',
    'ui_upload', 'brute_stream', 'tamper_test', 'net_trace', 'debug_stream',
    'harvest_session', 'find_bundle', 'firebase_login', 'node_replay_sample',
    'open_magic_link', 'click_login', 'compare_auth', 'complete_login',
    'do_login',
)


def relative_path(path: Path) -> str:
    return path.relative_to(PROJECT_ROOT).as_posix()


def is_env_file(name: str) -> bool:
    return name == '.env' or name.startswith('.env.')


def should_exclude(path: Path) -> bool:
    rel = relative_path(path)
    basename = PurePosixPath(rel).name
    if rel == 'runtime' or rel.startswith('runtime/'):
        return True
    if rel in EXCLUDE_RELATIVE_PATHS or basename in EXCLUDE_BASENAMES:
        return True
    if basename.startswith('.') and basename not in {'.gitignore', '.dockerignore'}:
        return True
    if is_env_file(basename) or basename.endswith(EXCLUDE_SUFFIXES):
        return True
    return any(basename.startswith(prefix) for prefix in EXCLUDE_PREFIXES)


def should_exclude_dir(root: Path, dirname: str) -> bool:
    rel = relative_path(root / dirname)
    return dirname in EXCLUDE_DIR_BASENAMES or rel in EXCLUDE_RELATIVE_PATHS or rel == 'runtime'


def build_archive() -> io.BytesIO:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for root, dirs, files in os.walk(PROJECT_ROOT):
            root_path = Path(root)
            dirs[:] = [d for d in dirs if not should_exclude_dir(root_path, d)]
            for filename in files:
                local_path = root_path / filename
                if should_exclude(local_path):
                    continue
                archive.add(local_path, arcname=relative_path(local_path))
    buffer.seek(0)
    return buffer


def load_credentials() -> dict:
    secret_path = Path(__file__).resolve().with_name('.ssh_secret.json')
    secret = {}
    if secret_path.exists():
        with secret_path.open(encoding='utf-8') as handle:
            secret = json.load(handle)

    def value(env_name: str, key: str, default=None):
        return os.environ.get(env_name, secret.get(key, default))

    credentials = {
        'host': value('SAKANA_SSH_HOST', 'HOST'),
        'port': int(value('SAKANA_SSH_PORT', 'PORT', 22)),
        'user': value('SAKANA_SSH_USER', 'USER'),
        'password': value('SAKANA_SSH_PASS', 'PASS'),
        'key_filename': value('SAKANA_SSH_KEY', 'KEY'),
        'known_hosts': value(
            'SAKANA_SSH_KNOWN_HOSTS',
            'KNOWN_HOSTS',
            str(Path.home() / '.ssh' / 'known_hosts'),
        ),
    }
    missing = [name for name in ('host', 'user') if not credentials[name]]
    if not credentials['password'] and not credentials['key_filename']:
        missing.append('SAKANA_SSH_PASS or SAKANA_SSH_KEY')
    if missing:
        raise RuntimeError(
            'SSH configuration is incomplete; set environment variables or scripts/.ssh_secret.json: '
            + ', '.join(missing)
        )
    known_hosts = Path(os.path.expanduser(credentials['known_hosts']))
    if not known_hosts.is_file():
        raise RuntimeError(f'SSH known_hosts file is required: {known_hosts}')
    credentials['known_hosts'] = str(known_hosts)
    if credentials['key_filename']:
        credentials['key_filename'] = str(Path(os.path.expanduser(credentials['key_filename'])))
        if not Path(credentials['key_filename']).is_file():
            raise RuntimeError(f'SSH key file does not exist: {credentials["key_filename"]}')
    return credentials


def connect(credentials: dict) -> paramiko.SSHClient:
    ssh = paramiko.SSHClient()
    ssh.load_system_host_keys()
    ssh.load_host_keys(credentials['known_hosts'])
    ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
    ssh.connect(
        credentials['host'],
        credentials['port'],
        credentials['user'],
        password=credentials['password'],
        key_filename=credentials['key_filename'],
        look_for_keys=False,
        allow_agent=False,
    )
    return ssh


def q(value: str) -> str:
    return shlex.quote(value)


def runtime_prepare_command() -> str:
    names = ' '.join(q(name) for name in RUNTIME_STATE_BASENAMES)
    remote = q(REMOTE)
    runtime = q(RUNTIME_ROOT)
    return f'''set -eu
mkdir -p {runtime}
if [ -d {remote}/runtime ] && [ ! -L {remote}/runtime ]; then
  cp -a {remote}/runtime/. {runtime}/ 2>/dev/null || true
  rm -rf {remote}/runtime
fi
for name in {names}; do
  if [ -e {remote}/$name ] || [ -L {remote}/$name ]; then
    if [ ! -e {runtime}/$name ] && [ ! -L {runtime}/$name ]; then
      mv {remote}/$name {runtime}/$name
    else
      rm -rf {remote}/$name
    fi
  fi
done
'''


def remote_command(ssh: paramiko.SSHClient, command: str, timeout: int = 300):
    stdin, stdout, stderr = ssh.exec_command(command, timeout=timeout)
    output = stdout.read().decode('utf-8', 'replace')
    error = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    return code, output, error


def upload_archive(ssh: paramiko.SSHClient, archive: io.BytesIO, path: str) -> None:
    sftp = ssh.open_sftp()
    try:
        with sftp.open(path, 'wb') as remote_archive:
            remote_archive.write(archive.read())
    finally:
        sftp.close()


def deploy(args) -> None:
    credentials = load_credentials()
    ssh = connect(credentials)
    release_id = f'{int(time.time())}-{os.getpid()}'
    stage = f'{REMOTE}.release-{release_id}'
    backup = f'{REMOTE}.previous-{release_id}'
    archive_path = f'/tmp/sakana-2api-{release_id}.tar.gz'
    archive = build_archive()
    print(f'Connected to {credentials["host"]}; archive={archive.getbuffer().nbytes / 1024:.0f} KB')
    try:
        code, _, error = remote_command(ssh, f'mkdir -p {q(REMOTE)}')
        if code:
            raise RuntimeError(f'cannot create remote directory: {error.strip()}')
        code, _, error = remote_command(ssh, runtime_prepare_command())
        if code:
            raise RuntimeError(f'runtime preparation failed: {error.strip()}')

        upload_archive(ssh, archive, archive_path)
        stage_q = q(stage)
        runtime_q = q(RUNTIME_ROOT)
        names = ' '.join(q(name) for name in RUNTIME_STATE_BASENAMES)
        prepare = f'''set -eu
rm -rf {stage_q}
mkdir -p {stage_q}
tar xzf {q(archive_path)} -C {stage_q}
rm -f {q(archive_path)}
ln -s {runtime_q} {stage_q}/runtime
for name in {names}; do ln -s {runtime_q}/$name {stage_q}/$name 2>/dev/null || true; done
ln -s {runtime_q}/.browser-profile {stage_q}/.browser-profile 2>/dev/null || true
cd {stage_q}
npm ci --omit=dev
node --check server.js
'''
        code, output, error = remote_command(ssh, prepare, timeout=900)
        if code:
            raise RuntimeError(f'release validation failed: {error[-1000:]}')
        print(output[-1000:])

        switch = f'''set -eu
if [ -e {q(REMOTE)} ] || [ -L {q(REMOTE)} ]; then mv {q(REMOTE)} {q(backup)}; fi
mv {stage_q} {q(REMOTE)}
'''
        code, _, error = remote_command(ssh, switch)
        if code:
            raise RuntimeError(f'release switch failed: {error.strip()}')

        if args.sanitize_pool:
            sanitize = (
                f'''set -eu
cd {q(REMOTE)}
node -e "const fs=require('fs');const p='account_pool.json';'''
                '''if(!fs.existsSync(p)){process.exit(0)};'''
                '''const a=JSON.parse(fs.readFileSync(p,'utf8'));'''
                '''a.forEach(x=>{x.uid='';x.email='';x.display='acct-'+String(x.id||'').slice(0,8)});'''
                '''fs.writeFileSync(p,JSON.stringify(a,null,2));console.log('sanitized='+a.length)"'''
            )
            code, output, error = remote_command(ssh, sanitize)
            if code:
                raise RuntimeError(f'pool sanitization failed: {error.strip()}')
            print(output.strip())

        if not args.upload_only:
            restart = f'''set -eu
if command -v ss >/dev/null 2>&1; then
  pid=$(ss -tlnp 2>/dev/null | grep ':8787' | grep -oP 'pid=\\K[0-9]+' | head -1 || true)
  if [ -n "$pid" ]; then kill "$pid" || true; fi
fi
cd {q(REMOTE)}
setsid nohup bash scripts/start_sakana.sh >/dev/null 2>&1 &
sleep 5
curl -fsS -m 15 http://127.0.0.1:8787/health
'''
            code, output, error = remote_command(ssh, restart, timeout=120)
            if code:
                raise RuntimeError(f'restart/health check failed: {error[-1000:]}')
            print('Health:', output.strip())
        else:
            print('Upload complete; restart skipped (--upload-only).')
    finally:
        ssh.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--upload-only', action='store_true', help='upload and validate without restarting')
    parser.add_argument('--restart', action='store_true', help='compatibility flag; restart is the default')
    parser.add_argument('--sanitize-pool', action='store_true')
    args = parser.parse_args()
    deploy(args)


if __name__ == '__main__':
    main()
