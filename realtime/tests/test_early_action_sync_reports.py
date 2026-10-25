"""Loopback HTTP evidence-storage regression; no credentials or cloud calls."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

from aiohttp.test_utils import TestClient, TestServer


MODULE_DIR = Path(__file__).resolve().parents[1] / 'early-action'
sys.path.insert(0, str(MODULE_DIR))
spec = importlib.util.spec_from_file_location('early_sync_report_lab', MODULE_DIR / 'lab.py')
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


class SyncReportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.provider_calls = 0

        async def fake_provider(_):
            self.provider_calls += 1
            raise AssertionError('Report requests must not connect to a provider')

        self.instance = lab.Lab(lab.legacy.Config(), self.temp.name, fake_provider, cloud=False)
        self.client = TestClient(TestServer(lab.create_app(self.instance)))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        self.origin = str(self.client.make_url('/')).rstrip('/')
        self.headers = {'Origin': self.origin}
        self.key = 'greet-r1-B'
        self.url = '/api/early-action/report/' + self.key
        self.ledger_before = (self.instance.output / 'ledger.json').read_bytes()

    async def asyncTearDown(self):
        self.assertEqual(self.provider_calls, 0)
        self.assertEqual((self.instance.output / 'ledger.json').read_bytes(), self.ledger_before)

    async def post(self, payload, headers=None):
        response = await self.client.post(self.url, json=payload,
                                          headers=self.headers if headers is None else headers)
        await response.read()
        return response

    async def test_v2_modes_and_interrupt_reports_have_separate_files_and_preserve_live(self):
        live = {'mode': 'live', 'evidence': 'immutable-original'}
        self.assertEqual((await self.post(live)).status, 200)
        live_path = self.instance.output / f'{self.key}-client.json'
        live_bytes = live_path.read_bytes()
        names = set()
        for timing in ('legacy', 'immediate'):
            for interrupt in (False, True):
                with self.subTest(timing=timing, interrupt=interrupt):
                    payload = {'mode': 'replay', 'measurementVersion': 2,
                               'synchronization': timing, 'evidence': f'{timing}-{interrupt}'}
                    if interrupt:
                        payload['interruptAfterBodyMs'] = 350
                    self.assertEqual((await self.post(payload)).status, 200)
                    suffix = '-interrupt' if interrupt else ''
                    name = f'{self.key}-sync-{timing}{suffix}-replay-client.json'
                    names.add(name)
                    self.assertEqual(json.loads((self.instance.output / name).read_text(encoding='utf-8')), payload)
                    self.assertEqual(live_path.read_bytes(), live_bytes)
        self.assertEqual(len(names), 4)
        self.assertFalse((self.instance.output / f'{self.key}-replay-client.json').exists())

    async def test_invalid_v2_synchronization_is_rejected_without_creating_evidence(self):
        before = {path.name for path in self.instance.output.iterdir()}
        for timing in (None, '', 'fast', '../live', 0, [], {}):
            with self.subTest(timing=timing):
                payload = {'mode': 'replay', 'measurementVersion': 2, 'synchronization': timing}
                self.assertEqual((await self.post(payload)).status, 400)
        self.assertEqual({path.name for path in self.instance.output.iterdir()}, before)

    async def test_live_report_cannot_be_overwritten(self):
        first = {'mode': 'live', 'voiceAt': 1200}
        self.assertEqual((await self.post(first)).status, 200)
        path = self.instance.output / f'{self.key}-client.json'
        original = path.read_bytes()
        duplicate = await self.post({'mode': 'live', 'voiceAt': 1})
        self.assertEqual(duplicate.status, 409)
        self.assertEqual(await duplicate.text(), 'immutable_live_measurement')
        self.assertEqual(path.read_bytes(), original)

    async def test_report_origin_and_host_guards_remain_enabled(self):
        before = {path.name for path in self.instance.output.iterdir()}
        payload = {'mode': 'replay', 'measurementVersion': 2, 'synchronization': 'immediate'}
        for headers in ({}, {'Origin': 'https://untrusted.example'},
                        {'Origin': 'null'}, {'Origin': self.origin, 'Host': 'untrusted.example'}):
            with self.subTest(headers=headers):
                self.assertEqual((await self.post(payload, headers=headers)).status, 403)
        self.assertEqual({path.name for path in self.instance.output.iterdir()}, before)
        self.assertEqual((await self.post(payload)).status, 200)

    async def test_legacy_replay_storage_remains_separate_from_v2(self):
        legacy = {'mode': 'replay', 'evidence': 'original-format'}
        self.assertEqual((await self.post(legacy)).status, 200)
        old_path = self.instance.output / f'{self.key}-replay-client.json'
        original = old_path.read_bytes()
        self.assertEqual((await self.post({'mode': 'replay', 'measurementVersion': 2,
                                          'synchronization': 'legacy'})).status, 200)
        self.assertEqual(old_path.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
