"""Protocol and accounting regressions with fake providers only."""
import asyncio
import base64
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

from aiohttp.test_utils import TestClient, TestServer

spec = importlib.util.spec_from_file_location('action_timing_probe', Path(__file__).parents[1] / 'action-timing/probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
USAGE = {'input_tokens': 3, 'output_tokens': 2, 'total_tokens': 5}
PCM = base64.b64encode(struct.pack('<hhhh', 0, 900, -900, 0)).decode()


class Provider:
    def __init__(self, mode='mixed', identity='real-voice', create_hook=None):
        self.mode, self.identity, self.create_hook = mode, identity, create_hook
        self.events, self.sent, self.closed = asyncio.Queue(), [], False
        self.events.put_nowait({'type': 'session.created'})
        self.created = asyncio.Event()
        self.settings = None

    def push(self, kind, **data):
        self.events.put_nowait({'type': kind, 'response_id': self.identity, **data})

    def done(self, status='completed'):
        self.events.put_nowait({'type': 'response.done', 'response': {
            'id': self.identity, 'status': status, 'usage': None if self.mode == 'unknown' else USAGE}})

    async def send(self, event):
        self.sent.append(event)
        kind = event['type']
        if kind == 'session.update':
            self.settings = event['session']
            actual = dict(self.settings, model=probe.legacy.MODEL)
            if self.mode == 'no-text' and actual['modalities'] == ['text']:
                actual['modalities'] = ['text', 'audio']
            self.events.put_nowait({'type': 'session.updated', 'session': actual})
        elif kind == 'response.create':
            self.created.set()
            if self.create_hook:
                await self.create_hook(self)
            self.events.put_nowait({'type': 'response.created', 'response': {'id': self.identity}})
            if self.mode == 'wait-cancel':
                return
            if self.mode == 'wrong-source':
                self.push('response.audio.delta', response_id='other-owner', delta=PCM)
            elif self.mode == 'provider-error':
                self.events.put_nowait({'type': 'error', 'error': {'message': 'SECRET wss://credential.invalid'}})
            else:
                if self.settings['tools']:
                    function = self.settings['tools'][0]['function']
                    name = function['name']
                    raw = '{"cue":"greet"}' if name == 'perform_cue' else '{"expression":"smile","gesture":"wave"}'
                    if self.mode != 'done-only':
                        self.push('response.output_item.added', item={
                            'type': 'function_call', 'id': 'item1', 'call_id': 'call1', 'name': name})
                        if self.mode == 'invalid-incremental':
                            self.push('response.function_call_arguments.delta', item_id='item1', delta='{"cue":"INVALID"}')
                        else:
                            self.push('response.function_call_arguments.delta', item_id='item1', delta=raw[:5])
                            self.push('response.function_call_arguments.delta', item_id='item1', delta=raw[5:])
                    self.push('response.function_call_arguments.done', item_id='item1', name=name, call_id='call1', arguments=raw)
                if self.settings['modalities'] != ['text'] and self.mode != 'tool-only':
                    self.push('response.audio.delta', delta=PCM)
                    self.push('response.audio_transcript.delta', delta='回来啦，今天过得怎么样？我在这儿呢。')
            self.done()
        elif kind == 'response.cancel' and self.mode == 'wait-cancel':
            self.done('cancelled')

    async def receive(self):
        return await self.events.get()

    async def close(self):
        self.closed = True


class ProbeTests(unittest.IsolatedAsyncioTestCase):
    def make(self, providers, **kwargs):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        iterator = iter(providers)
        async def factory(_):
            return next(iterator)
        return probe.Lab(probe.legacy.Config(), temp.name, factory, cloud=True, **kwargs)

    async def run_case(self, key='greet-D', mode='mixed'):
        provider = Provider(mode)
        lab = self.make([provider])
        events = []
        async def notify(event):
            events.append(event)
        result = await lab.run(key, notify)
        return lab, provider, result, events

    async def test_mixed_same_response_no_receipt_wait_or_continuation(self):
        lab, provider, result, events = await self.run_case()
        self.assertTrue(result['completed'])
        self.assertTrue(result['metrics']['sameResponseBothBeforeReceipt'])
        self.assertEqual(result['metrics']['responseCreates'], 1)
        self.assertEqual(sum(e['type'] == 'response.create' for e in provider.sent), 1)
        self.assertEqual(events[0]['type'], 'request_sent')
        self.assertEqual(events[1]['type'], 'response_created')
        self.assertTrue(result['scriptMatch'])
        self.assertTrue(provider.closed)
        self.assertEqual(lab.ledger['responses'][0]['usageStatus'], 'reported')
        owner = result['logicalResponseId']
        for event in events:
            if event['type'] in {'tool', 'audio', 'subtitle', 'non_silent_pcm', 'voice_done'}:
                self.assertEqual(event['responseId'], owner)
                self.assertEqual(event['sourceResponseId'], 'real-voice')
        receipt = next(i for i, e in enumerate(events) if e['type'] == 'receipt_send')
        self.assertGreater(receipt, next(i for i, e in enumerate(events) if e['type'] == 'response_done'))
        self.assertTrue((lab.output / 'greet-D.wav').is_file())
        self.assertEqual(json.loads((lab.output / 'greet-D.json').read_text(encoding='utf-8'))['events'], result['events'])

    async def test_tool_only_does_not_retry_or_claim_voice(self):
        _, provider, result, events = await self.run_case(mode='tool-only')
        self.assertFalse(result['completed'])
        self.assertTrue(result['metrics']['toolOnly'])
        self.assertFalse(next(e for e in events if e['type'] == 'voice_done')['completed'])
        self.assertEqual(sum(e['type'] == 'response.create' for e in provider.sent), 1)

    async def test_unknown_blocks_new_case_and_restart(self):
        lab, _, _, _ = await self.run_case(mode='unknown')
        self.assertTrue(lab.ledger['blocked'])
        with self.assertRaises(ValueError):
            await lab.run('greet-N', lambda _: None)
        again = probe.Lab(lab.config, lab.output, cloud=True)
        self.assertTrue(again.catalog()['blocked'])
        self.assertEqual(again.catalog()['used'], 1)

    async def test_pending_restart_blocks_without_reset(self):
        lab = self.make([])
        lab.ledger['responses'].append({'case': 'greet-D', 'usageStatus': 'pending'})
        probe.early.write_json(lab.ledger_path, lab.ledger)
        again = probe.Lab(lab.config, lab.output, cloud=True)
        self.assertTrue(again.ledger['blocked'])
        self.assertEqual(len(again.ledger['responses']), 1)

    async def test_no_repeat_even_if_handshake_failed(self):
        provider = Provider('no-text')
        lab = self.make([Provider(), provider])
        async def notify(_):
            pass
        result = await lab.run('greet-P', notify)
        self.assertEqual(result['error'], 'connection_or_configuration_failed')
        self.assertEqual(result['roles']['planner']['error'], 'session_configuration_mismatch')
        self.assertEqual(result['roles']['planner']['sessionEcho']['modalities'], ['text', 'audio'])
        self.assertEqual(lab.catalog()['used'], 0)
        self.assertFalse(any(e['type'] == 'response.create' for e in provider.sent))
        with self.assertRaises(ValueError):
            await lab.run('greet-P', notify)

    async def test_limit_is_checked_atomically_for_parallel(self):
        lab = self.make([])
        lab.ledger['responses'] = [{'usageStatus': 'reported'} for _ in range(9)]
        with self.assertRaises(ValueError):
            await lab.run('greet-P', lambda _: None)
        self.assertEqual(len(lab.ledger['responses']), 9)
        self.assertEqual(lab.ledger['attempted'], [])

    async def test_parallel_creates_independent_and_reserves_two_before_either(self):
        both = asyncio.Event()
        created = []
        lab = None
        async def hook(provider):
            disk = json.loads(lab.ledger_path.read_text(encoding='utf-8'))
            self.assertEqual(len(disk['responses']), 2)
            self.assertEqual({r['usageStatus'] for r in disk['responses']}, {'pending'})
            created.append(provider.identity)
            if len(created) == 2:
                both.set()
            await asyncio.wait_for(both.wait(), .5)
        voice, planner = Provider(identity='voice-real', create_hook=hook), Provider(identity='planner-real', create_hook=hook)
        lab = self.make([voice, planner])
        events = []
        async def notify(event):
            events.append(event)
        result = await lab.run('greet-P', notify)
        self.assertTrue(result['completed'])
        self.assertEqual(result['metrics']['responseCreates'], 2)
        self.assertIsNone(result['metrics']['sameResponseBothBeforeReceipt'])
        self.assertEqual(len(lab.ledger['responses']), 2)
        self.assertTrue(all(p.closed for p in [voice, planner]))
        contexts = [next(e for e in p.sent if e['type'] == 'conversation.item.create')['item'] for p in [voice, planner]]
        self.assertEqual(contexts[0], contexts[1])
        self.assertEqual(voice.settings['tools'], [])
        self.assertEqual(planner.settings['modalities'], ['text'])
        self.assertEqual(result['roles']['voice']['sourceResponseId'], 'voice-real')
        self.assertEqual(result['roles']['planner']['sourceResponseId'], 'planner-real')
        tool = next(e for e in events if e['type'] == 'tool')
        self.assertEqual(tool['sourceRole'], 'planner')
        self.assertEqual(tool['responseId'], result['logicalResponseId'])
        self.assertEqual(tool['plan'], {'expression': 'smile', 'gesture': 'wave'})
        self.assertGreater(next(i for i, e in enumerate(events) if e['type'] == 'receipt_send'),
                           max(i for i, e in enumerate(events) if e['type'] == 'response_done'))

    async def test_parallel_unknown_still_drains_other_provider(self):
        voice, planner = Provider(identity='v'), Provider('unknown', identity='p')
        lab = self.make([voice, planner])
        async def notify(_):
            pass
        result = await lab.run('greet-P', notify)
        self.assertTrue(result['completed'])
        self.assertTrue(lab.ledger['blocked'])
        self.assertEqual(result['roles']['voice']['usageStatus'], 'reported')
        self.assertEqual(result['roles']['planner']['usageStatus'], 'unknown')
        self.assertEqual(sum(e['type'] == 'response.create' for p in [voice, planner] for e in p.sent), 2)

    async def test_voice_done_is_independent_of_slow_planner(self):
        release = asyncio.Event()
        async def hold_planner(_):
            await asyncio.wait_for(release.wait(), .5)
        voice, planner = Provider(identity='v'), Provider(identity='p', create_hook=hold_planner)
        lab = self.make([voice, planner])
        events = []
        async def notify(event):
            events.append(event)
            if event['type'] == 'voice_done':
                release.set()
        result = await lab.run('greet-P', notify)
        self.assertTrue(result['completed'])
        self.assertLess(next(i for i, e in enumerate(events) if e['type'] == 'voice_done'),
                        next(i for i, e in enumerate(events) if e['type'] == 'tool'))

    async def test_incremental_correlation_records_parse_but_executes_only_done(self):
        _, _, result, events = await self.run_case('greet-K')
        kinds = [e['type'] for e in events]
        self.assertLess(kinds.index('first_parseable_arguments'), kinds.index('arguments_done'))
        self.assertLess(kinds.index('arguments_done'), kinds.index('tool'))
        self.assertEqual(kinds.count('tool'), 1)
        self.assertTrue(result['metrics']['incrementalAvailable'])
        first = next(e for e in events if e['type'] == 'first_argument_delta')
        self.assertEqual((first['sourceItemId'], first['sourceCallId'], first['name']), ('item1', 'call1', 'perform_cue'))

    async def test_invalid_incremental_never_executes_but_valid_done_remains_usable(self):
        _, _, result, events = await self.run_case('greet-K', 'invalid-incremental')
        self.assertIsNone(result['metrics']['firstParseableArgumentsMs'])
        self.assertEqual(sum(e['type'] == 'tool' for e in events), 1)
        self.assertTrue(result['completed'])

    async def test_no_item_or_delta_mapping_does_not_reject_valid_done(self):
        _, _, result, events = await self.run_case('greet-K', 'done-only')
        self.assertIsNone(result['metrics']['firstArgumentDeltaMs'])
        self.assertIsNone(result['metrics']['firstParseableArgumentsMs'])
        self.assertEqual(sum(e['type'] == 'tool' for e in events), 1)

    async def test_wrong_source_never_reaches_playback(self):
        lab, provider, result, events = await self.run_case(mode='wrong-source')
        self.assertFalse(result['completed'])
        self.assertFalse(any(e['type'] == 'audio' for e in events))
        self.assertTrue(any(e['type'] == 'response.cancel' for e in provider.sent))
        self.assertEqual(result['roles']['voice']['error'], 'response_identity_mismatch')
        self.assertFalse(lab.ledger['blocked'])  # matching final usage was still drained

    async def test_provider_error_is_redacted_and_final_usage_drained(self):
        lab, _, result, _ = await self.run_case(mode='provider-error')
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertNotIn('credential.invalid', json.dumps(result))
        self.assertEqual(result['roles']['voice']['usageStatus'], 'reported')
        self.assertFalse(lab.ledger['blocked'])

    async def test_cancel_drain_is_bounded_and_no_voice_after_cancel(self):
        provider = Provider('wait-cancel')
        lab = self.make([provider], case_seconds=.05, drain_seconds=.1)
        async def notify(_):
            pass
        result = await asyncio.wait_for(lab.run('greet-D', notify), 1)
        self.assertTrue(result['cancelled'])
        self.assertFalse(result['completed'])
        self.assertEqual(result['roles']['voice']['usageStatus'], 'reported')
        self.assertEqual(sum(e['type'] == 'response.cancel' for e in provider.sent), 1)

    async def test_immutable_live_report_and_replay_are_separate(self):
        lab, _, _, _ = await self.run_case()
        async with TestClient(TestServer(probe.create_app(lab))) as client:
            origin = {'Origin': str(client.make_url('/')).rstrip('/')}
            url = '/api/action-timing/report/greet-D'
            self.assertEqual((await client.post(url, json={'mode': 'live'}, headers=origin)).status, 200)
            self.assertEqual((await client.post(url, json={'mode': 'live', 'overwritten': True}, headers=origin)).status, 409)
            self.assertEqual((await client.post(url, json={'mode': 'replay', 'replayId': 'interrupt'}, headers=origin)).status, 200)
            self.assertEqual((await client.post(url, json={'mode': 'live'}, headers={'Origin': 'https://external.invalid'})).status, 403)
            data = await (await client.get('/action-timing-data/greet-D-client.json')).json()
            self.assertEqual(data, {'mode': 'live'})
            self.assertTrue((lab.output / 'greet-D-replay-interrupt-client.json').exists())
            self.assertEqual((await client.get('/action-timing-data/ledger.json')).status, 404)

    def test_matrix_schema_and_d_frozen_baseline(self):
        self.assertEqual(list(probe.cases()), ['greet-D', 'greet-N', 'greet-K', 'greet-P', 'compare-P', 'compare-K', 'compare-N', 'compare-D'])
        self.assertEqual(probe.settings('D'), probe.early.settings('B'))
        self.assertEqual(probe.settings('N')['tools'], probe.settings('D')['tools'])
        self.assertEqual(probe.settings('P', 'voice'), probe.early.settings('A'))
        for raw in ['{', '{"cue":"Stand2"}', '{"cue":"greet","epoch":2}', '{"cue":[]}',
                    '{"cue":"none","cue":"greet"}']:
            with self.assertRaises(ValueError):
                probe.validate_arguments('K', 'perform_cue', raw)


if __name__ == '__main__':
    unittest.main()
