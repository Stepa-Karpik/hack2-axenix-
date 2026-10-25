#!/usr/bin/env python3
"""Restricted SSH receiver for one application's rootless Docker engine."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path('/opt/java-blueprints')
SOCKET = Path(f'/run/user/{os.getuid()}/docker.sock')
ENV_FILE = ROOT / 'shared/.env'
MAX_BYTES = 1024 * 1024 * 1024
ORIGIN = 'https://java-blueprints.karpovprod.ru'


def run(args, *, env=None, timeout=240, stdout=subprocess.PIPE):
    result = subprocess.run(args, env=env, stdout=stdout,
                            stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # Compose and image metadata can contain configuration. Keep logs private.
        raise RuntimeError('Deployment command failed: ' + args[0])
    return result.stdout or b''


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def environment(sha):
    return dict(os.environ, DOCKER_HOST='unix://' + str(SOCKET),
                JB_DOCKER_SOCKET=str(SOCKET), JB_RELEASE_SHA=sha)


def compose(release, *arguments, timeout=240, stdout=subprocess.PIPE):
    return run(['docker', '--host', 'unix://' + str(SOCKET), 'compose',
                '--project-name', 'java-blueprints-prod', '--env-file', str(ENV_FILE),
                '-f', str(release / 'compose.yaml'), *arguments],
               env=environment(release.name), timeout=timeout, stdout=stdout)


def public_health():
    def read(path, limit):
        with urllib.request.urlopen(ORIGIN + path, timeout=5) as response:
            if response.geturl() != ORIGIN + path:
                raise RuntimeError('Unexpected public redirect')
            body = response.read(limit + 1)
            if not body or len(body) > limit:
                raise RuntimeError('Invalid public response size')
            return body, response.headers.get('Content-Type', '')
    landing, content_type = read('/', 1024 * 1024)
    if 'text/html' not in content_type or b'id="hero-title"' not in landing:
        return False
    index, content_type = read('/login', 1024 * 1024)
    if 'text/html' not in content_type or b'id="root"' not in index:
        return False
    assets = set(re.findall(rb'(?:src|href)="(/assets/[A-Za-z0-9._-]+\.(?:js|css))"', index))
    landing_assets = set(re.findall(rb'(?:src|href)="(/landing/[A-Za-z0-9._/-]+\.(?:js|css))"', landing))
    for group in (assets, landing_assets):
        if not any(path.endswith(b'.js') for path in group) or not any(path.endswith(b'.css') for path in group):
            return False
    assets |= landing_assets
    for path in assets:
        _, kind = read(path.decode('ascii'), 8 * 1024 * 1024)
        if ('javascript' if path.endswith(b'.js') else 'text/css') not in kind:
            return False
    for path in ('health', 'capabilities', 'session'):
        raw, _ = read('/api/v1/' + path, 65536)
        data = json.loads(raw).get('data', {})
        if path == 'health' and data.get('status') != 'up':
            return False
        if path == 'capabilities' and data.get('runner', {}).get('available') is not True:
            return False
        if path == 'session' and data.get('capabilities', {}).get('legacyGuestWorkspace') is not False:
            return False
    return True


def health(timeout=100):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            def get(path):
                req = urllib.request.Request('http://127.0.0.1:18684/api/v1/' + path,
                                             headers={'Host': 'java-blueprints.karpovprod.ru'})
                with urllib.request.urlopen(req, timeout=3) as response:
                    return json.load(response).get('data', {})
            if (get('health').get('status') == 'up'
                    and get('capabilities').get('runner', {}).get('available') is True
                    and get('session').get('capabilities', {}).get('legacyGuestWorkspace') is False
                    and public_health()):
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


def receive(destination):
    h = hashlib.sha256()
    size = 0
    until = time.monotonic() + 900
    with destination.open('xb') as stream:
        while True:
            remaining = until - time.monotonic()
            if remaining <= 0 or not select.select([sys.stdin.buffer], [], [], min(30, remaining))[0]:
                raise RuntimeError('Release transfer timed out')
            block = os.read(sys.stdin.fileno(), 1024 * 1024)
            if not block:
                break
            size += len(block)
            if size > MAX_BYTES:
                raise RuntimeError('Release transfer exceeds limit')
            h.update(block)
            stream.write(block)
    return h.hexdigest()


def extract(archive, target):
    limits = {'release.json': 65536, 'compose.yaml': 65536, 'images.tar.gz': MAX_BYTES}
    with tarfile.open(archive, 'r:') as package:
        members = package.getmembers()
        if len(members) != 3 or {m.name for m in members} != set(limits):
            raise RuntimeError('Unexpected release contents')
        for member in members:
            if not member.isfile() or member.size <= 0 or member.size > limits[member.name]:
                raise RuntimeError('Invalid release member')
            with package.extractfile(member) as source, (target / member.name).open('xb') as out:
                shutil.copyfileobj(source, out)


def validate_image(description, name, sha, env):
    if description.get('ref') != name + ':' + sha or not re.fullmatch(r'sha256:[a-f0-9]{64}', description.get('id', '')):
        raise RuntimeError('Release image binding differs')
    actual = json.loads(run(['docker', '--host', 'unix://' + str(SOCKET),
                             'image', 'inspect', description['ref']], env=env))[0]
    if actual['Id'] != description['id'] or actual['Config'].get('Labels', {}).get('org.opencontainers.image.revision') != sha:
        raise RuntimeError('Loaded image identity differs')


def validate_running(release, metadata):
    for service in ('server', 'runner'):
        container = compose(release, 'ps', '-q', service).decode().strip()
        if not re.fullmatch(r'[a-f0-9]{64}', container):
            raise RuntimeError('Expected running application container')
        actual = run(['docker', '--host', 'unix://' + str(SOCKET), 'inspect',
                      '--format', '{{.State.Running}} {{.Image}}', container],
                     env=environment(release.name)).decode().strip().split()
        if actual != ['true', metadata[service]['id']]:
            raise RuntimeError('Running application image differs from tested release')


def retain_owned_history(current, previous):
    releases = ROOT / 'releases'
    candidates = sorted((p for p in releases.iterdir()
                         if p.is_dir() and not p.is_symlink()
                         and re.fullmatch(r'[a-f0-9]{40}', p.name)),
                        key=lambda p: p.stat().st_mtime, reverse=True)
    keep = set(candidates[:3]) | {current, previous}
    for directory in candidates:
        if directory in keep or {p.name for p in directory.iterdir()} != {'release.json', 'compose.yaml'}:
            continue
        metadata = json.loads((directory / 'release.json').read_text())
        if metadata.get('commit') != directory.name or metadata.get('repository') != 'Stepa-Karpik/hack2-axenix-':
            continue
        refs = [f'java-blueprints-{kind}:{directory.name}' for kind in ('server', 'runner')]
        run(['docker', '--host', 'unix://' + str(SOCKET), 'image', 'rm', *refs],
            env=environment(current.name))
        for name in ('release.json', 'compose.yaml'):
            (directory / name).unlink()
        directory.rmdir()
    backups = ROOT / 'backups'
    if backups.is_dir():
        snapshots = sorted((p for p in backups.iterdir() if p.is_file() and not p.is_symlink()
                            and re.fullmatch(r'[a-f0-9]{40}\.dump', p.name)),
                           key=lambda p: p.stat().st_mtime, reverse=True)
        for snapshot in snapshots[10:]:
            snapshot.unlink()


def deploy(sha, expected):
    releases = ROOT / 'releases'
    releases.mkdir(exist_ok=True)
    target = releases / sha
    current = ROOT / 'current'
    previous = current.resolve() if current.is_symlink() else None
    if previous and previous.parent != releases:
        raise RuntimeError('Current release escaped application directory')
    if shutil.disk_usage(ROOT).free < 3 * 1024**3:
        raise RuntimeError('Insufficient free space; no other application files were removed')
    with tempfile.TemporaryDirectory(prefix='incoming-', dir=ROOT) as temporary:
        incoming = Path(temporary)
        archive = incoming / 'release.tar'
        if receive(archive) != expected:
            raise RuntimeError('Release checksum differs')
        unpacked = incoming / 'unpacked'
        unpacked.mkdir()
        extract(archive, unpacked)
        metadata = json.loads((unpacked / 'release.json').read_text())
        if metadata.get('commit') != sha or metadata.get('repository') != 'Stepa-Karpik/hack2-axenix-':
            raise RuntimeError('Release source binding differs')
        if metadata.get('composeSha256') != digest(unpacked / 'compose.yaml') or metadata.get('imageArchiveSha256') != digest(unpacked / 'images.tar.gz'):
            raise RuntimeError('Release member checksum differs')
        if target.exists() and json.loads((target / 'release.json').read_text()) != metadata:
            # Loading first could retag an already published release before refusal.
            raise RuntimeError('Immutable release already exists with different contents')
        env = environment(sha)
        info = json.loads(run(['docker', '--host', 'unix://' + str(SOCKET), 'info', '--format', '{{json .}}'], env=env))
        if info.get('CgroupVersion') != '2' or info.get('CgroupDriver') != 'systemd' or not any('rootless' in s for s in info.get('SecurityOptions', [])):
            raise RuntimeError('Dedicated rootless engine with cgroup limits is required')
        run(['docker', '--host', 'unix://' + str(SOCKET), 'image', 'load', '-i', str(unpacked / 'images.tar.gz')], env=env)
        validate_image(metadata['server'], 'java-blueprints-server', sha, env)
        validate_image(metadata['runner'], 'java-blueprints-runner', sha, env)
        if not target.exists():
            target.mkdir()
            for name in ('release.json', 'compose.yaml'):
                shutil.copyfile(unpacked / name, target / name)
        compose(target, 'config', '--quiet')
        # This image is fixed by the Java runner protocol, never supplied by a user project.
        run(['docker', '--host', 'unix://' + str(SOCKET), 'pull', 'eclipse-temurin@sha256:742daacb9316be4b6fc60258f6e4ac2a11882f6c597373c92290a57bfad0d2e0'], env=env)
        if previous:
            backups = ROOT / 'backups'
            backups.mkdir(mode=0o700, exist_ok=True)
            with (backups / (sha + '.dump')).open('wb') as backup:
                compose(previous, 'exec', '-T', 'db', 'sh', '-c',
                        'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc',
                        timeout=90, stdout=backup)
        try:
            compose(target, 'up', '-d', '--no-build', '--remove-orphans')
            validate_running(target, metadata)
            if not health():
                raise RuntimeError('New release health check failed')
        except Exception:
            if previous:
                compose(previous, 'up', '-d', '--no-build', '--remove-orphans')
                restored = health()
                print(json.dumps({'deploy': 'failed', 'previousReleaseRestored': restored}), flush=True)
            else:
                # Keep the new database for diagnosis/retry, but no failed public API/worker.
                compose(target, 'stop', 'server', 'runner')
            raise
        temporary_link = ROOT / 'current.next'
        if temporary_link.is_symlink():
            temporary_link.unlink()
        temporary_link.symlink_to(target)
        temporary_link.replace(current)
        print(json.dumps({'deploy': 'healthy', 'commit': sha, 'engine': 'dedicated-rootless'}), flush=True)
        try:
            retain_owned_history(target, previous)
        except Exception:
            print('Release is healthy; owned history cleanup requires attention.', file=sys.stderr)


def main():
    os.umask(0o077)
    if os.getuid() == 0 or not SOCKET.is_socket() or not ENV_FILE.is_file():
        raise RuntimeError('Deployment must run as the dedicated non-root application user')
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    if command == 'status':
        current = ROOT / 'current'
        print(json.dumps({'commit': current.resolve().name if current.is_symlink() else None,
                          'healthy': health(3)}))
        return
    matched = re.fullmatch(r'deploy ([a-f0-9]{40}) ([a-f0-9]{64})', command)
    if not matched:
        raise RuntimeError('Only deploy <commit> <checksum> or status is allowed')
    with (ROOT / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deploy(*matched.groups())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Deployment failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
