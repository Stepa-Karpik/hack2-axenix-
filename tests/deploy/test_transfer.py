"""Deterministic receiver tests: no SSH, Docker, services, or real waiting."""
import ast
import hashlib
import io
import json
from pathlib import Path
import tempfile
import types
import unittest


class TransferTest(unittest.TestCase):
    def receive(self, events, *, total=1080, idle=120, limit=1024):
        source = Path(__file__).resolve().parents[2] / 'scripts/deploy-release.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'receive')
        clock = types.SimpleNamespace(now=0.0)
        pending = []
        at = 0
        for delay, data in events:
            at += delay
            pending.append((at, data))
        output = io.StringIO()

        def select(readers, writers, exceptional, timeout):
            if pending and pending[0][0] <= clock.now + timeout:
                clock.now = pending[0][0]
                return (readers, [], [])
            clock.now += timeout
            return ([], [], [])

        def read(fd, maximum):
            self.assertEqual(7, fd)
            data = pending.pop(0)[1]
            self.assertLessEqual(len(data), maximum)
            return data

        namespace = {'hashlib': hashlib, 'json': json,
                     'time': types.SimpleNamespace(monotonic=lambda: clock.now),
                     'select': types.SimpleNamespace(select=select),
                     'os': types.SimpleNamespace(read=read),
                     'sys': types.SimpleNamespace(stdin=types.SimpleNamespace(buffer=object(), fileno=lambda: 7), stderr=output),
                     'MAX_BYTES': limit, 'TRANSFER_TOTAL_SECONDS': total,
                     'TRANSFER_IDLE_SECONDS': idle, 'TRANSFER_REPORT_SECONDS': 30}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'incoming.tar'
            try:
                digest = namespace['receive'](target)
                result = {'digest': digest, 'bytes': target.read_bytes(), 'error': None}
            except RuntimeError as error:
                result = {'error': str(error), 'bytes': target.read_bytes()}
        result['events'] = [json.loads(line) for line in output.getvalue().splitlines()]
        result['elapsed'] = clock.now
        return result

    def test_slow_stream_survives_more_than_old_thirty_second_gap(self):
        result = self.receive([(0, b'first'), (70, b'second'), (70, b'')])
        self.assertIsNone(result['error'])
        self.assertEqual(hashlib.sha256(b'firstsecond').hexdigest(), result['digest'])
        self.assertEqual(b'firstsecond', result['bytes'])
        self.assertEqual({'transfer': 'started', 'bytesReceived': 0, 'elapsedSeconds': 0}, result['events'][0])
        self.assertEqual('complete', result['events'][-1]['transfer'])
        self.assertEqual(11, result['events'][-1]['bytesReceived'])
        self.assertTrue(any(event['transfer'] == 'progress' for event in result['events']))

    def test_idle_timeout_reports_partial_size_and_does_not_wait_forever(self):
        result = self.receive([(0, b'abc'), (121, b'late')])
        self.assertIn('idle timeout', result['error'])
        self.assertEqual(120, result['elapsed'])
        self.assertEqual({'transfer': 'timeout', 'bytesReceived': 3, 'elapsedSeconds': 120, 'reason': 'idle'}, result['events'][-1])

    def test_total_timeout_bounds_a_continuously_progressing_slow_stream(self):
        result = self.receive([(50, b'a')] * 30, total=1080)
        self.assertIn('total timeout', result['error'])
        self.assertEqual(1080, result['elapsed'])
        self.assertEqual(21, result['events'][-1]['bytesReceived'])

    def test_progressing_transfer_can_finish_after_old_fifteen_minute_deadline(self):
        result = self.receive([(50, b'a')] * 21 + [(0, b'')])
        self.assertIsNone(result['error'])
        self.assertEqual(1050, result['elapsed'])
        self.assertEqual(hashlib.sha256(b'a' * 21).hexdigest(), result['digest'])
        self.assertEqual('complete', result['events'][-1]['transfer'])

    def test_size_limit_and_empty_eof_keep_original_hash_contract(self):
        oversized = self.receive([(0, b'abc'), (0, b'd')], limit=3)
        self.assertIn('exceeds limit', oversized['error'])
        self.assertEqual(b'abc', oversized['bytes'])
        self.assertEqual('size_limit', oversized['events'][-1]['reason'])
        empty = self.receive([(0, b'')])
        self.assertEqual(hashlib.sha256(b'').hexdigest(), empty['digest'])
        self.assertEqual(b'', empty['bytes'])

    def test_diagnostics_contain_only_safe_transfer_fields(self):
        result = self.receive([(40, b'content'), (0, b'')])
        for event in result['events']:
            self.assertTrue(set(event) <= {'transfer', 'bytesReceived', 'elapsedSeconds', 'reason'})


if __name__ == '__main__':
    unittest.main()
