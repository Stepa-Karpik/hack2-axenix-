import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'scripts/deploy-release.py'
if not SOURCE.exists():
    SOURCE = Path(__file__).with_name('deploy-release.py')
spec = importlib.util.spec_from_file_location('release_receiver', SOURCE)
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


class ReleaseArchiveTests(unittest.TestCase):
    def package(self, root, names=None, special=None):
        path = root / 'release.tar'
        with tarfile.open(path, 'w') as tar:
            for name, body in (names or [('release.json', b'{}'), ('compose.yaml', b'name: owned'), ('images.tar.gz', b'image')]):
                info = tarfile.TarInfo(name)
                info.size = len(body)
                if special and special[0] == name:
                    info.type = special[1]
                    info.linkname = '../outside'
                tar.addfile(info, io.BytesIO(body) if info.isfile() else None)
        return path

    def test_extracts_only_three_regular_exact_members(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'out'
            target.mkdir()
            archive = self.package(root)
            receiver.extract(archive, target)
            self.assertEqual({p.name for p in target.iterdir()}, {'release.json', 'compose.yaml', 'images.tar.gz'})
            self.assertEqual((target / 'compose.yaml').read_bytes(), b'name: owned')
            self.assertEqual(receiver.digest(archive), hashlib.sha256(archive.read_bytes()).hexdigest())

    def test_rejects_paths_extra_and_duplicate_members_before_writing(self):
        for invalid in [
                [('release.json', b'{}'), ('compose.yaml', b'x'), ('../images.tar.gz', b'x')],
                [('release.json', b'{}'), ('compose.yaml', b'x'), ('images.tar.gz', b'x'), ('extra', b'x')],
                [('release.json', b'{}'), ('compose.yaml', b'x'), ('compose.yaml', b'x')]]:
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                target = root / 'out'
                target.mkdir()
                with self.assertRaisesRegex(RuntimeError, 'Unexpected release contents'):
                    receiver.extract(self.package(root, invalid), target)
                self.assertEqual(list(target.iterdir()), [])

    def test_rejects_symlinks_hardlinks_and_oversize_metadata(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                target = root / 'out'
                target.mkdir()
                with self.assertRaisesRegex(RuntimeError, 'Invalid release member'):
                    receiver.extract(self.package(root, special=('release.json', kind)), target)
                self.assertFalse((root / 'outside').exists())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'out'
            target.mkdir()
            archive = self.package(root, [('release.json', b'x' * 65537), ('compose.yaml', b'x'), ('images.tar.gz', b'x')])
            with self.assertRaisesRegex(RuntimeError, 'Invalid release member'):
                receiver.extract(archive, target)


class ReleaseBindingTests(unittest.TestCase):
    def exercise_deploy_failure(self, existing=False):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            root = Path(temporary)
            sha = 'a' * 40
            target = root / 'releases' / sha
            metadata = {'commit': sha, 'repository': 'Stepa-Karpik/hack2-axenix-',
                        'composeSha256': 'd' * 64, 'imageArchiveSha256': 'd' * 64,
                        'server': {}, 'runner': {}}
            if existing:
                target.mkdir(parents=True)
                (target / 'release.json').write_text(json.dumps(dict(metadata, imageArchiveSha256='e' * 64)))
            def extract(_archive, destination):
                (destination / 'release.json').write_text(json.dumps(metadata))
                (destination / 'compose.yaml').write_text('owned')
                (destination / 'images.tar.gz').write_bytes(b'image')
            stack.enter_context(patch.object(receiver, 'ROOT', root))
            stack.enter_context(patch.object(receiver.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
            stack.enter_context(patch.object(receiver, 'receive', return_value='f' * 64))
            stack.enter_context(patch.object(receiver, 'extract', side_effect=extract))
            stack.enter_context(patch.object(receiver, 'digest', return_value='d' * 64))
            run = stack.enter_context(patch.object(receiver, 'run', return_value=json.dumps({'CgroupVersion': '2', 'CgroupDriver': 'systemd', 'SecurityOptions': ['name=rootless']}).encode()))
            stack.enter_context(patch.object(receiver, 'validate_image'))
            stack.enter_context(patch.object(receiver, 'validate_running'))
            compose = stack.enter_context(patch.object(receiver, 'compose'))
            stack.enter_context(patch.object(receiver, 'health', return_value=False))
            with self.assertRaisesRegex(RuntimeError, 'Immutable release' if existing else 'health check failed'):
                receiver.deploy(sha, 'f' * 64)
            if existing:
                run.assert_not_called()
                compose.assert_not_called()
            else:
                self.assertEqual(compose.call_args.args, (target, 'stop', 'server', 'runner'))
                self.assertFalse((root / 'current').exists())

    def test_rejected_same_commit_never_loads_or_retags_live_images(self):
        self.exercise_deploy_failure(existing=True)

    def test_first_failed_health_stops_only_own_api_and_worker(self):
        self.exercise_deploy_failure()

    def test_runtime_identity_rejects_different_running_image(self):
        release = Path('/opt/java-blueprints/releases') / ('a' * 40)
        metadata = {kind: {'id': 'sha256:' + 'b' * 64} for kind in ('server', 'runner')}
        with patch.object(receiver, 'compose', return_value=('c' * 64).encode()), patch.object(receiver, 'run', return_value=('true sha256:' + 'b' * 64).encode()):
            receiver.validate_running(release, metadata)
        with patch.object(receiver, 'compose', return_value=('c' * 64).encode()), patch.object(receiver, 'run', return_value=('true sha256:' + 'd' * 64).encode()):
            with self.assertRaisesRegex(RuntimeError, 'image differs'):
                receiver.validate_running(release, metadata)

    def test_public_health_requires_index_assets_and_hosted_api(self):
        class Response:
            def __init__(self, url, body, kind): self.url=url; self.body=body; self.headers={'Content-Type':kind}
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, size): return self.body[:size]
            def geturl(self): return self.url
        index=b'<div id="root"></div><script src="/assets/app.js"></script><link href="/assets/app.css">'
        landing=b'<h1 id="hero-title">JavaBlueprints</h1><script src="/landing/app.js"></script><link href="/landing/styles.css">'
        def opened(url, **_):
            path=url[len(receiver.ORIGIN):]
            if path=='/': return Response(url,landing,'text/html')
            if path=='/login': return Response(url,index,'text/html')
            if path.endswith('.js'):return Response(url,b'export{}','application/javascript')
            if path.endswith('.css'):return Response(url,b'body{}','text/css')
            data={'health':{'status':'up'},'capabilities':{'runner':{'available':True}},'session':{'capabilities':{'legacyGuestWorkspace':False}}}[path.rsplit('/',1)[1]]
            return Response(url,json.dumps({'data':data}).encode(),'application/json')
        with patch.object(receiver.urllib.request, 'urlopen', side_effect=opened):
            self.assertTrue(receiver.public_health())
        for broken in ('/', '/login', '/landing/app.js', '/landing/styles.css', '/assets/app.js', '/assets/app.css'):
            def broken_page(url, **kwargs):
                if url == receiver.ORIGIN + broken:
                    return Response(url, b'<html>Missing application</html>', 'text/html')
                return opened(url, **kwargs)
            with self.subTest(broken=broken), patch.object(receiver.urllib.request, 'urlopen', side_effect=broken_page):
                self.assertFalse(receiver.public_health())
        with patch.object(receiver.urllib.request, 'urlopen', return_value=Response(receiver.ORIGIN+'/',b'<div id="root"></div>','text/html')):
            self.assertFalse(receiver.public_health())

    def test_retention_preserves_current_previous_and_foreign_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            releases = root / 'releases'
            releases.mkdir()
            for i in range(1, 6):
                directory = releases / (str(i) * 40)
                directory.mkdir()
                (directory / 'release.json').write_text(json.dumps({'commit': directory.name, 'repository': 'Stepa-Karpik/hack2-axenix-'}))
                (directory / 'compose.yaml').write_text('owned')
                os.utime(directory, (i, i))
            foreign = releases / 'unrelated'
            foreign.mkdir()
            (foreign / 'keep').write_text('do not touch')
            current, previous = releases / ('5' * 40), releases / ('1' * 40)
            with patch.object(receiver, 'ROOT', root), patch.object(receiver, 'run', return_value=b'') as run:
                receiver.retain_owned_history(current, previous)
            self.assertTrue(current.exists())
            self.assertTrue(previous.exists())
            self.assertFalse((releases / ('2' * 40)).exists())
            self.assertEqual((foreign / 'keep').read_text(), 'do not touch')
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][-2:], ['java-blueprints-server:' + '2' * 40, 'java-blueprints-runner:' + '2' * 40])

    def test_loaded_image_must_have_exact_tag_content_id_and_commit_label(self):
        sha = 'a' * 40
        description = {'ref': 'java-blueprints-server:' + sha, 'id': 'sha256:' + 'b' * 64}
        actual = {'Id': description['id'], 'Config': {'Labels': {'org.opencontainers.image.revision': sha}}}
        with patch.object(receiver, 'run', return_value=json.dumps([actual]).encode()) as run:
            receiver.validate_image(description, 'java-blueprints-server', sha, {})
            self.assertIn('unix:///run/user/', run.call_args.args[0][2])
            for bad in [dict(description, ref='other:' + sha), dict(description, id='not-an-image-id')]:
                with self.assertRaisesRegex(RuntimeError, 'binding differs'):
                    receiver.validate_image(bad, 'java-blueprints-server', sha, {})
        for bad in [dict(actual, Id='sha256:' + 'c' * 64), dict(actual, Config={'Labels': {'org.opencontainers.image.revision': 'd' * 40}})]:
            with patch.object(receiver, 'run', return_value=json.dumps([bad]).encode()), self.assertRaisesRegex(RuntimeError, 'identity differs'):
                receiver.validate_image(description, 'java-blueprints-server', sha, {})

    def test_compose_is_forced_to_owned_socket_project_env_and_immutable_sha(self):
        release = Path('/opt/java-blueprints/releases') / ('a' * 40)
        with patch.object(receiver, 'run', return_value=b'') as run:
            receiver.compose(release, 'config', '--quiet')
            command = run.call_args.args[0]
            self.assertEqual(command[command.index('--project-name') + 1], 'java-blueprints-prod')
            self.assertEqual(command[command.index('--env-file') + 1], '/opt/java-blueprints/shared/.env')
            self.assertEqual(run.call_args.kwargs['env']['JB_RELEASE_SHA'], release.name)
            self.assertEqual(run.call_args.kwargs['env']['JB_DOCKER_SOCKET'], str(receiver.SOCKET))


if __name__ == '__main__':
    unittest.main()
