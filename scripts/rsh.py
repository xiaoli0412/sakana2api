#!/usr/bin/env python3
"""Reusable paramiko SSH helper: run a remote command (or upload) on the sakana server.
Usage:
  python scripts/rsh.py exec "<command>"
  python scripts/rsh.py upload <local_file> <remote_path>   # single file
  python scripts/rsh.py download <remote_path> <local_file>
"""
import paramiko, os, sys, json

SEC = json.load(open(os.path.join(os.path.dirname(__file__), '.ssh_secret.json')))
HOST = SEC['HOST']; PORT = int(SEC['PORT']); USER = SEC['USER']; PASS = SEC['PASS']

def connect():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, PORT, USER, PASS, look_for_keys=False, allow_agent=False, timeout=30,
                banner_timeout=30, auth_timeout=30)
    return ssh

def run(cmd, timeout=120):
    ssh = connect()
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    ssh.close()
    return code, out, err

def upload(local, remote):
    ssh = connect()
    sftp = ssh.open_sftp()
    sftp.put(local, remote)
    sftp.close(); ssh.close()

def download(remote, local):
    ssh = connect()
    sftp = ssh.open_sftp()
    sftp.get(remote, local)
    sftp.close(); ssh.close()

if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'exec':
        code, out, err = run(sys.argv[2])
        print(out, end='')
        if err: print('STDERR:', err[:1000], file=sys.stderr)
        sys.exit(code)
    elif mode == 'upload':
        upload(sys.argv[2], sys.argv[3])
        print('uploaded')
    elif mode == 'download':
        download(sys.argv[2], sys.argv[3])
        print('downloaded')
    else:
        print('unknown mode'); sys.exit(1)