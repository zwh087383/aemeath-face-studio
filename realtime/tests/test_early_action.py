import asyncio
import base64
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('early_lab', Path(__file__).parents[1] / 'early-action/lab.py')
lab = importlib.util.module_from_spec(spec); spec.loader.exec_module(lab)

class Provider:
    def __init__(self, mode='mixed'):
        self.events = asyncio.Queue(); self.events.put_nowait({'type': 'session.created'})
        self.sent = []; self.mode = mode; self.closed = False
    async def send(self, event):
        self.sent.append(event)
        if event['type'] == 'session.update':
            session = dict(event['session'], model=lab.legacy.MODEL)
            self.events.put_nowait({'type': 'session.updated', 'session': session})
        elif event['type'] == 'response.create':
            self.events.put_nowait({'type': 'response.created', 'response': {'id': 'r'}})
            self.events.put_nowait({'type': 'response.function_call_arguments.done', 'response_id': 'r', 'name': 'perform_avatar', 'call_id': 'one', 'arguments': '{"expression":"smile","gesture":"greet"}'})
            if self.mode != 'tool-only':
                self.events.put_nowait({'type': 'response.audio.delta', 'response_id': 'r', 'delta': base64.b64encode(struct.pack('<hhhh', 0, 900, -900, 0)).decode()})
            self.events.put_nowait({'type': 'response.done', 'response': {'id': 'r', 'status': 'completed', 'usage': None if self.mode == 'unknown' else {'input_tokens': 3, 'output_tokens': 2, 'total_tokens': 5}}})
    async def receive(self): return await self.events.get()
    async def close(self): self.closed = True

class LabTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, mode='mixed'):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        provider = Provider(mode)
        async def factory(_): return provider
        instance = lab.Lab(lab.legacy.Config(), temp.name, factory, cloud=True)
        received = []
        async def notify(e): received.append(e)
        result = await instance.run('greet-r1-C', notify, {'cancel': asyncio.Event()})
        return instance, provider, result, received
    async def test_same_response_no_ack_and_exactly_one_request(self):
        instance, provider, result, events = await self.exercise()
        self.assertTrue(result['metrics']['sameResponseBothBeforeReceipt'])
        self.assertTrue(result['metrics']['toolFirst'])
        self.assertEqual(result['metrics']['responseCreates'], 1)
        self.assertLess(next(e['atMs'] for e in events if e['type'] == 'non_silent_pcm'), next(e['atMs'] for e in events if e['type'] == 'receipt_send'))
        self.assertTrue(provider.closed)
        self.assertEqual(instance.ledger['responses'][0]['usageStatus'], 'reported')
    async def test_tool_only_never_hidden_retry(self):
        _, provider, result, _ = await self.exercise('tool-only')
        self.assertFalse(result['completed']); self.assertTrue(result['metrics']['toolOnly'])
        self.assertEqual(sum(e['type'] == 'response.create' for e in provider.sent), 1)
    async def test_unknown_blocks_new_case_and_restart(self):
        instance, _, _, _ = await self.exercise('unknown')
        self.assertTrue(instance.ledger['blocked'])
        with self.assertRaises(ValueError): await instance.run('greet-r2-C', lambda _: None, {'cancel': asyncio.Event()})
        reopened = lab.Lab(instance.config, instance.output, cloud=True)
        self.assertTrue(reopened.ledger['blocked'])
    async def test_completed_case_cannot_repeat(self):
        instance, _, _, _ = await self.exercise()
        with self.assertRaises(ValueError): await instance.run('greet-r1-C', lambda _: None, {'cancel': asyncio.Event()})
    async def test_connection_failure_manual_retry_preserves_evidence_without_resetting_budget(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        async def unavailable(_): raise OSError('offline fixture')
        instance = lab.Lab(lab.legacy.Config(), temp.name, unavailable, cloud=True)
        async def notify(_): pass
        first = await instance.run('greet-r1-C', notify, {'cancel': asyncio.Event()})
        self.assertEqual(first['metrics']['responseCreates'], 0)
        self.assertEqual(instance.catalog()['connectionFailed'], ['greet-r1-C'])
        async def available(_): return Provider()
        instance.factory = available
        second = await instance.run('greet-r1-C', notify, {'cancel': asyncio.Event()})
        self.assertTrue(second['completed'])
        self.assertEqual(len(instance.ledger['responses']), 1)
        self.assertEqual(len(list((instance.output / 'connection-failures').glob('*/*.json'))), 1)
    async def test_cancel_before_create_spends_no_response(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        provider = Provider()
        async def factory(_): return provider
        async def notify(_): pass
        control = {'cancel': asyncio.Event()}; control['cancel'].set()
        instance = lab.Lab(lab.legacy.Config(), temp.name, factory, cloud=True)
        result = await instance.run('greet-r1-C', notify, control)
        self.assertTrue(result['cancelled'])
        self.assertEqual(len(instance.ledger['responses']), 0)
        self.assertFalse(any(e['type'] == 'response.create' for e in provider.sent))
    def test_matrix_bounds_and_same_tool_schema(self):
        self.assertEqual(len(lab.cases()), 14)
        self.assertEqual(lab.settings('B')['tools'], lab.settings('C')['tools'])
        self.assertEqual(lab.settings('A')['tools'], [])
        for bad in ['{', '{"expression":"smile","gesture":"Stand2"}', '{"expression":"smile","gesture":"greet","epoch":4}']:
            with self.assertRaises(ValueError): lab.validate_call({'name': 'perform_avatar', 'call_id': 'a', 'arguments': bad})

if __name__ == '__main__': unittest.main()
