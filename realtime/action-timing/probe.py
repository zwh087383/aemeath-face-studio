"""Isolated, fixed-line timing experiment; ten responses, no hidden continuation.

P deliberately gives its planner the final target line. Its result is an upper
bound on preparation timing, not proof of semantic agreement in free dialogue.
Only the trusted bridge translates the planner owner into the voice owner.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import struct
import time
from urllib.parse import urlencode
from uuid import uuid4
import wave

from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location('action_timing_early_helpers', ROOT / 'realtime/early-action/lab.py')
early = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(early)
legacy = early.legacy
LIMIT = 10
EXPERIMENT_ID = 'action-timing-20261024'
SCOPE = ('Fixed target line and controlled user context, with no retrieval, microphone/VAD, '
         'or physical speaker measurement. The parallel planner knows the final line: '
         'a timing upper-bound experiment, not free-dialogue semantic consistency evidence.')
GROUPS = {'D': '原语音优先', 'N': '不限定先后', 'K': '不限定先后，单编号', 'P': '独立并行动作规划'}
CUES = {'none': {'expression': 'neutral', 'gesture': 'none'},
        'greet': {'expression': 'smile', 'gesture': 'wave'},
        'explain': {'expression': 'neutral', 'gesture': 'explain'}}
NEUTRAL = ('在同一个响应内完整说出本轮台词。决定好适合的可选动作就发出一次表现通知，'
           '不要求语音或工具谁先输出；语音永远不等待工具回执，不将语音留到下一响应，不能只给工具。')


def cases():
    source = early.cases()
    order = ['greet-D', 'greet-N', 'greet-K', 'greet-P',
             'compare-P', 'compare-K', 'compare-N', 'compare-D']
    return {key: dict(id=key, scene=key.split('-')[0], group=key.split('-')[1],
                     text=source[key.split('-')[0] + '-r1-A']['text'],
                     context=source[key.split('-')[0] + '-r1-A']['context']) for key in order}


def settings(group, role='voice'):
    if group == 'D':
        return early.settings('B')
    if group == 'P' and role == 'voice':
        return early.settings('A')
    value = early.settings('B')
    value['instructions'] = early.PERSONA + '\n' + NEUTRAL
    if group in {'K', 'P'}:
        value['tools'] = [{'type': 'function', 'function': {
            'name': 'perform_cue',
            'description': '可选表现通知，不查询信息且不需要回执；none无动作，greet微笑挥手，explain中性解释。',
            'parameters': {'type': 'object', 'additionalProperties': False,
                           'properties': {'cue': {'type': 'string', 'enum': list(CUES)}},
                           'required': ['cue']}}}]
        value['instructions'] += '\n只选none、greet或explain，不控制关节、幅度或长期情绪。'
    else:
        value['instructions'] += '\n表情和动作严格选择工具枚举，不控制关节、幅度或长期情绪。'
    if group == 'P':
        value['modalities'] = ['text']
        value['instructions'] = (early.PERSONA + '\n你是独立表现规划器；同一输入中的本轮台词是语音分支将说的固定台词。'
            '根据上下文和这段台词尽早只发出一次perform_cue，不输出文字解释，不说话，不等待工具回执。'
            'none无动作，greet微笑挥手，explain中性解释；不是设定长期情绪，不控制关节和速度。')
    return value


def validate_arguments(group, name, raw):
    if not isinstance(raw, str) or len(raw) > 1024:
        raise ValueError('invalid_arguments')
    def unique_fields(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('duplicate_argument_field')
            value[key] = item
        return value
    value = json.loads(raw, object_pairs_hook=unique_fields)
    if group in {'K', 'P'}:
        if name != 'perform_cue' or not isinstance(value, dict) or set(value) != {'cue'}:
            raise ValueError('invalid_fields')
        if not isinstance(value['cue'], str) or value['cue'] not in CUES:
            raise ValueError('invalid_enum')
        return dict(CUES[value['cue']])
    if name != 'perform_avatar' or not isinstance(value, dict) or set(value) != {'expression', 'gesture'}:
        raise ValueError('invalid_fields')
    if value['expression'] not in early.EXPRESSIONS or value['gesture'] not in early.GESTURES:
        raise ValueError('invalid_enum')
    return value


def identifier(value):
    return isinstance(value, str) and legacy.IDENTIFIER.fullmatch(value) is not None


def source_hashes():
    return {str(path.relative_to(ROOT)).replace('\\', '/'): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (Path(__file__), ROOT / 'realtime/early-action/lab.py', ROOT / 'realtime/qwen/server.py')}


def metrics(result):
    events = result['events']
    def first(kind):
        return next((e for e in events if e['type'] == kind and e.get('identityComplete', True)), None)
    pcm, tool, receipt = (first(kind) for kind in ('non_silent_pcm', 'tool', 'receipt_send'))
    def at(kind):
        event = first(kind)
        return event['atMs'] if event else None
    same = bool(pcm and tool and pcm['sourceResponseId'] == tool['sourceResponseId']
                and (receipt is None or max(pcm['atMs'], tool['atMs']) < receipt['atMs']))
    return {
        'firstNonSilentPcmMs': at('non_silent_pcm'), 'firstToolItemMs': at('output_item_added'),
        'firstArgumentDeltaMs': at('first_argument_delta'),
        'firstParseableArgumentsMs': at('first_parseable_arguments'), 'completeToolMs': at('tool'),
        'receiptMs': at('receipt_send'),
        'toolLeadOverPcmMs': pcm['atMs'] - tool['atMs'] if pcm and tool else None,
        'sameResponseBothBeforeReceipt': None if result['case']['group'] == 'P' else same,
        'bothBeforeReceipt': bool(pcm and tool and (receipt is None or max(pcm['atMs'], tool['atMs']) < receipt['atMs'])),
        'responseCreates': sum(e['type'] == 'provider_create_sent' for e in events),
        'toolOnly': bool(tool and not pcm), 'audioOnly': bool(pcm and not tool),
        'toolFirst': bool(pcm and tool and tool['atMs'] < pcm['atMs']),
        'incrementalAvailable': first('first_argument_delta') is not None,
    }


class Lab:
    def __init__(self, config, output, factory=legacy.connect_provider, cloud=False, proxy=False,
                 case_seconds=60, drain_seconds=10):
        self.config, self.output, self.factory = config, Path(output), factory
        self.cloud, self.proxy = cloud, proxy
        self.case_seconds, self.drain_seconds = min(case_seconds, 60), min(drain_seconds, 10)
        self.lock, self.busy, self.cases = asyncio.Lock(), False, cases()
        self.output.mkdir(parents=True, exist_ok=True)
        self.ledger_path = self.output / 'ledger.json'
        self.ledger = json.loads(self.ledger_path.read_text(encoding='utf-8')) if self.ledger_path.exists() else {
            'experimentId': EXPERIMENT_ID, 'limit': LIMIT, 'responses': [], 'attempted': [], 'blocked': False}
        if self.ledger.get('limit') != LIMIT or self.ledger.get('experimentId') != EXPERIMENT_ID:
            raise ValueError('immutable_batch_limit')
        if any(record.get('usageStatus') != 'reported' for record in self.ledger['responses']):
            self.ledger['blocked'] = True
        manifest = {'experimentId': EXPERIMENT_ID, 'experimental': True, 'limit': LIMIT,
                    'model': legacy.MODEL, 'voice': legacy.VOICE, 'scope': SCOPE, 'groups': GROUPS,
                    'cases': list(self.cases.values()), 'order': list(self.cases),
                    'settings': {group: {role: settings(group, role) for role in
                                 (['voice', 'planner'] if group == 'P' else ['voice'])} for group in GROUPS}}
        path = self.output / 'experiment.json'
        if path.exists() and json.loads(path.read_text(encoding='utf-8')) != manifest:
            raise ValueError('immutable_experiment')
        early.write_json(path, manifest)
        early.write_json(self.ledger_path, self.ledger)

    async def persist(self):
        # Caller owns lock; to_thread keeps fsync off the stream event loop.
        await asyncio.to_thread(early.write_json, self.ledger_path, copy.deepcopy(self.ledger))

    def catalog(self):
        result = {'cases': list(self.cases.values()), 'used': len(self.ledger['responses']), 'limit': LIMIT,
                  'blocked': self.ledger['blocked'], 'attempted': list(self.ledger['attempted']),
                  'cloudEnabled': self.cloud, 'busy': self.busy, 'experimental': True,
                  'scope': SCOPE, 'model': legacy.MODEL, 'results': {}, 'clientReports': {}}
        for key in self.cases:
            path = self.output / f'{key}.json'
            if path.exists():
                data = json.loads(path.read_text(encoding='utf-8'))
                result['results'][key] = {field: data.get(field) for field in
                    ('completed', 'cancelled', 'metrics', 'roles', 'error', 'scriptMatch')}
            path = self.output / f'{key}-client.json'
            if path.exists():
                result['clientReports'][key] = json.loads(path.read_text(encoding='utf-8'))
        return result

    async def run(self, key, notify, control=None):
        control = control or {'cancel': asyncio.Event()}
        async with self.lock:
            if (not self.cloud or key not in self.cases or self.busy or self.ledger['blocked']
                    or key in self.ledger['attempted']):
                raise ValueError('run_not_allowed')
            cost = 2 if self.cases[key]['group'] == 'P' else 1
            if len(self.ledger['responses']) + cost > LIMIT:
                raise ValueError('response_limit')
            self.busy = True
            self.ledger['attempted'].append(key)
            await self.persist()
        began = time.perf_counter()
        request_at = None
        logical = 'timing-' + key + '-' + uuid4().hex[:12]
        case, providers, records, pcm = self.cases[key], {}, {}, bytearray()
        result = {'case': case, 'logicalResponseId': logical, 'events': [], 'roles': {}, 'transcript': '',
                  'completed': False, 'cancelled': False, 'experimental': True, 'scope': SCOPE,
                  'fixedTargetKnownToPlanner': case['group'] == 'P', 'sourceHashes': source_hashes(),
                  'machineBefore': early.machine_state(), 'model': legacy.MODEL,
                  'network': 'local7890' if self.proxy else 'direct'}

        async def emit(kind, **data):
            item = {'type': kind, 'atMs': (time.perf_counter() - (request_at or began)) * 1000, **data}
            result['events'].append(item)
            try:
                await notify(item)
            except Exception:
                control['cancel'].set()
            return item

        async def connect(role):
            provider = await self.factory(self.config)
            providers[role] = provider
            if (await provider.receive()).get('type') != 'session.created':
                raise ValueError('session_created_missing')
            config = settings(case['group'], role)
            result['roles'][role] = {'sourceRole': role, 'sourceResponseId': None,
                'settingsHash': hashlib.sha256(json.dumps(config, ensure_ascii=False, sort_keys=True).encode()).hexdigest()}
            await provider.send({'type': 'session.update', 'session': config})
            event = await provider.receive()
            actual = event.get('session', {})
            result['roles'][role]['sessionAckType'] = event.get('type') if event.get('type') in {
                'session.updated', 'error'} else 'unexpected_event'
            result['roles'][role]['sessionEcho'] = legacy.safe_session_echo(actual, self.config.secrets)
            matches = legacy.session_matches(actual, 'manual') if role == 'voice' else (
                isinstance(actual, dict) and actual.get('model') == legacy.MODEL
                and actual.get('modalities') == ['text'] and actual.get('turn_detection') is None)
            if event.get('type') != 'session.updated' or not matches:
                raise ValueError('session_configuration_mismatch')
            await provider.send({'type': 'conversation.item.create', 'item': {'type': 'message', 'role': 'user',
                'content': [{'type': 'input_text', 'text': '【历史上下文】\n' + case['context'] + '\n【本轮台词】\n' + case['text']}]}})
            result['roles'][role]['readyBeforeRequestMs'] = (time.perf_counter() - began) * 1000

        async def role_run(role):
            provider, record = providers[role], records[role]
            info = result['roles'][role]
            receive, cancel_at, fault, voiced = None, None, None, False
            items, calls, raw_args, first_deltas, first_parsed = {}, [], {}, set(), set()
            async def observed(kind, **data):
                return await emit(kind, sourceRole=role, sourceResponseId=info['sourceResponseId'], **data)
            async def cancel(reason):
                nonlocal cancel_at, fault
                if cancel_at is not None:
                    return
                cancel_at = time.perf_counter()
                if reason not in {'user_cancel', 'case_timeout'}:
                    fault = fault or reason
                await observed('cancel_sent', responseId=logical, reason=reason)
                try:
                    await asyncio.wait_for(provider.send({'type': 'response.cancel'}), 2)
                except Exception:
                    fault = fault or 'cancel_send_failed'
            try:
                info['createSentMs'] = (time.perf_counter() - request_at) * 1000
                await observed('provider_create_sent', responseId=logical)
                await asyncio.wait_for(provider.send({'type': 'response.create', 'response': {
                    'modalities': ['text'] if role == 'planner' else ['text', 'audio']}}), 10)
                while True:
                    now = time.perf_counter()
                    if control['cancel'].is_set():
                        result['cancelled'] = True
                        await cancel('user_cancel')
                    elif now - began >= self.case_seconds:
                        result['cancelled'] = True
                        await cancel('case_timeout')
                    if cancel_at is not None and now - cancel_at >= self.drain_seconds:
                        fault = fault or 'cancel_drain_timeout'
                        break
                    receive = receive or asyncio.create_task(provider.receive())
                    done, _ = await asyncio.wait([receive], timeout=.01)
                    if not done:
                        continue
                    event = receive.result()
                    receive = None
                    kind = event.get('type')
                    if kind == 'error':
                        await observed('provider_error', code='provider_error_redacted')
                        await cancel('provider_error')
                        continue
                    if not isinstance(kind, str) or not kind.startswith('response.'):
                        continue
                    source_id = ((event.get('response') or {}).get('id') if kind in
                                 {'response.created', 'response.done'} else event.get('response_id'))
                    if kind == 'response.created':
                        if info['sourceResponseId'] is not None or not identifier(source_id):
                            await cancel('ambiguous_response_identity')
                            continue
                        info['sourceResponseId'] = record['sourceResponseId'] = source_id
                        await observed('provider_response_created', responseId=logical)
                    if not source_id or source_id != info['sourceResponseId']:
                        await observed('identity_rejected', reason='response_identity_mismatch')
                        await cancel('response_identity_mismatch')
                        continue
                    if kind == 'response.done':
                        data = event['response']
                        usage = data.get('usage')
                        record.update(usage=usage if early.valid_usage(usage) else None,
                                      usageStatus='reported' if early.valid_usage(usage) else 'unknown',
                                      status=data.get('status') if data.get('status') in
                                      {'completed', 'cancelled', 'failed', 'incomplete'} else 'unknown')
                        info.update(record, doneMs=(time.perf_counter() - request_at) * 1000)
                        async with self.lock:
                            if record['usageStatus'] != 'reported':
                                self.ledger['blocked'] = True
                            await self.persist()
                        await observed('response_done', responseId=logical, status=record['status'],
                                       usage=record['usage'], usageStatus=record['usageStatus'])
                        if record['status'] == 'cancelled':
                            result['cancelled'] = True
                        break
                    if fault:
                        continue
                    if kind == 'response.output_item.added':
                        item = event.get('item', {})
                        if not isinstance(item, dict) or item.get('type') != 'function_call':
                            continue
                        item_id, call_id, name = item.get('id'), item.get('call_id'), item.get('name')
                        if identifier(item_id):
                            items[item_id] = {'item_id': item_id, 'call_id': call_id, 'name': name}
                        await observed('output_item_added', responseId=logical, sourceItemId=item_id if identifier(item_id) else None,
                            sourceCallId=call_id if identifier(call_id) else None, name=name if identifier(name) else None,
                            identityComplete=identifier(item_id) and identifier(call_id) and identifier(name))
                    elif kind in {'response.function_call_arguments.delta', 'response.function_call_arguments.done'}:
                        item_id = event.get('item_id')
                        mapped = items.get(item_id, {})
                        call_id, name = event.get('call_id', mapped.get('call_id')), event.get('name', mapped.get('name'))
                        identity = identifier(call_id) and identifier(name)
                        if any(field in event and field in mapped and event[field] != mapped[field] for field in ('call_id', 'name')):
                            identity = False
                        fields = {'responseId': logical, 'sourceItemId': item_id if identifier(item_id) else None,
                                  'sourceCallId': call_id if identifier(call_id) else None,
                                  'name': name if identifier(name) else None, 'identityComplete': identity}
                        if kind.endswith('.delta'):
                            delta = event.get('delta')
                            if not isinstance(delta, str) or len(delta) > 1024:
                                await observed('argument_delta_rejected', reason='invalid_or_oversize_delta', **fields)
                                continue
                            correlation = item_id if identifier(item_id) else call_id if identifier(call_id) else None
                            if correlation is not None:
                                raw_args[correlation] = (raw_args.get(correlation, '') + delta)[:2049]
                            if correlation not in first_deltas:
                                first_deltas.add(correlation)
                                await observed('first_argument_delta', delta=delta, **fields)
                            await observed('argument_delta', delta=delta, **fields)
                            if identity and correlation not in first_parsed:
                                try:
                                    parsed = validate_arguments(case['group'], name, raw_args.get(correlation, ''))
                                except (ValueError, TypeError):
                                    pass
                                else:
                                    first_parsed.add(correlation)
                                    await observed('first_parseable_arguments', arguments=raw_args[correlation], plan=parsed, **fields)
                            continue
                        raw = event.get('arguments')
                        await observed('arguments_done', arguments=raw[:1024] if isinstance(raw, str) else None, **fields)
                        try:
                            if not identity or (case['group'] == 'P' and role == 'voice') or calls:
                                raise ValueError('invalid_or_excess_tool')
                            plan = validate_arguments(case['group'], name, raw)
                        except (ValueError, TypeError):
                            await observed('tool_rejected', reason='invalid_or_excess_tool', **fields)
                            continue
                        calls.append({'callId': call_id, 'name': name})
                        if cancel_at is None and not control['cancel'].is_set():
                            await observed('tool', responseId=logical, name='perform_avatar', callId=role + ':' + call_id,
                                sourceItemId=fields['sourceItemId'], sourceCallId=call_id, sourceName=name,
                                arguments=json.dumps(plan, ensure_ascii=False, separators=(',', ':')), plan=plan,
                                ownerTranslation='trusted_parallel_bridge' if role == 'planner' else 'trusted_voice_bridge')
                    elif kind == 'response.audio.delta':
                        if role != 'voice':
                            await cancel('unexpected_planner_audio')
                            continue
                        try:
                            chunk = base64.b64decode(event.get('delta', ''), validate=True)
                        except (ValueError, TypeError):
                            await cancel('invalid_pcm')
                            continue
                        if not chunk or len(chunk) % 2:
                            await cancel('invalid_pcm')
                            continue
                        if len(pcm) + len(chunk) > 35 * 48000:
                            result['cancelled'] = True
                            await cancel('audio_limit')
                            continue
                        offset = len(pcm) // 2
                        pcm.extend(chunk)
                        first_voiced = next((i for i, (value,) in enumerate(struct.iter_unpack('<h', chunk)) if abs(value) >= 256), None)
                        if first_voiced is not None and not voiced:
                            voiced = True
                            await observed('non_silent_pcm', responseId=logical, frame=offset + first_voiced)
                        await observed('audio', responseId=logical, delta=event['delta'],
                                       afterCancel=cancel_at is not None or control['cancel'].is_set())
                    elif kind in {'response.audio_transcript.delta', 'response.text.delta'}:
                        delta = event.get('delta')
                        if not isinstance(delta, str) or len(delta) > 8192:
                            await cancel('invalid_subtitle')
                            continue
                        if role == 'voice' and kind == 'response.audio_transcript.delta':
                            if len(result['transcript']) + len(delta) > 8192:
                                await cancel('subtitle_limit')
                                continue
                            result['transcript'] += delta
                            await observed('subtitle', responseId=logical, delta=delta)
                        elif role == 'planner':
                            await observed('planner_text', delta=delta[:1024])
            except Exception:
                fault = fault or 'provider_transport_failure'
            finally:
                if receive:
                    receive.cancel()
                    await asyncio.gather(receive, return_exceptions=True)
                if record['usageStatus'] == 'pending':
                    record['usageStatus'] = 'unknown'
                    async with self.lock:
                        self.ledger['blocked'] = True
                        await self.persist()
                info.update(record)
                if fault:
                    info['error'] = fault
                    await observed('role_error', code=fault)
                info['calls'] = calls
                if role == 'voice':
                    result['completed'] = (info.get('status') == 'completed' and voiced and not fault
                                           and cancel_at is None and not control['cancel'].is_set())
                    await observed('voice_done', responseId=logical, completed=result['completed'])

        try:
            roles = ['voice', 'planner'] if case['group'] == 'P' else ['voice']
            connections = await asyncio.gather(*(asyncio.wait_for(connect(role), min(20, self.case_seconds))
                                                  for role in roles), return_exceptions=True)
            if any(isinstance(item, BaseException) for item in connections):
                result['error'] = 'connection_or_configuration_failed'
                for role, outcome in zip(roles, connections):
                    if isinstance(outcome, BaseException):
                        # Fixed local reason codes only, never provider messages,
                        # exception URLs, credentials, or configuration paths.
                        reason = str(outcome) if type(outcome) is ValueError and str(outcome) in {
                            'session_created_missing', 'session_configuration_mismatch'} else (
                            'connection_timeout' if isinstance(outcome, TimeoutError) else 'connection_transport_failure')
                        result['roles'].setdefault(role, {'sourceRole': role, 'sourceResponseId': None})['error'] = reason
            elif control['cancel'].is_set():
                result['cancelled'] = True
                result['error'] = 'cancelled_before_create'
            else:
                # P reserves both slots durably before either response.create.
                async with self.lock:
                    for role in roles:
                        record = {'case': key, 'sourceRole': role, 'logicalResponseId': logical,
                                  'sourceResponseId': None, 'usageStatus': 'pending'}
                        self.ledger['responses'].append(record)
                        records[role] = record
                    await self.persist()
                request_at = time.perf_counter()
                await emit('request_sent', responseId=logical)
                await emit('response_created', responseId=logical)
                await asyncio.gather(*(role_run(role) for role in roles))
                # Receipt is a notification only. Never issue a continuation.
                for role in roles:
                    info = result['roles'][role]
                    if info.get('status') != 'completed':
                        continue
                    for call in info.get('calls', []):
                        await emit('receipt_send', responseId=logical, sourceRole=role,
                                   sourceResponseId=info['sourceResponseId'], sourceCallId=call['callId'])
                        try:
                            await asyncio.wait_for(providers[role].send({'type': 'conversation.item.create', 'item': {
                                'type': 'function_call_output', 'call_id': call['callId'],
                                'output': '{"validated":true,"displayConfirmed":false}'}}), 2)
                        except Exception:
                            info['receiptError'] = 'receipt_transport_failure'
        except Exception:
            result['error'] = 'experiment_failure_redacted'
        finally:
            for role, record in records.items():
                if record['usageStatus'] == 'pending':
                    record['usageStatus'] = 'unknown'
                    self.ledger['blocked'] = True
            async def close(provider):
                try:
                    await asyncio.wait_for(provider.close(), 3)
                except Exception:
                    result['cleanupError'] = True
            await asyncio.gather(*(close(provider) for provider in providers.values()))
            result['metrics'], result['machineAfter'] = metrics(result), early.machine_state()
            result['audioSeconds'] = len(pcm) / 48000
            result['setupMs'] = (request_at - began) * 1000 if request_at else None
            normalize = lambda value: re.sub(r'[^\w]', '', value)
            result['scriptMatch'] = normalize(result['transcript']) == normalize(case['text'])
            if pcm:
                def save_wav():
                    with wave.open(str(self.output / f'{key}.wav'), 'wb') as stream:
                        stream.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
                        stream.writeframes(pcm)
                await asyncio.to_thread(save_wav)
            await asyncio.to_thread(early.write_json, self.output / f'{key}.json', result)
            async with self.lock:
                await self.persist()
                self.busy = False
        # Do not recursively insert the result into its own events.
        try:
            await notify({'type': 'complete', 'atMs': (time.perf_counter() - (request_at or began)) * 1000,
                          'result': result, 'blocked': self.ledger['blocked']})
        except Exception:
            pass
        return result


def create_app(lab):
    app = web.Application(client_max_size=12 * 1024 * 1024)
    app[legacy.APP_STATE] = legacy.State(lab.config, ROOT, None, legacy.Limits(), lab.factory)
    async def catalog(request):
        if not legacy.allowed_request(request):
            raise web.HTTPForbidden()
        return web.json_response(lab.catalog(), headers={'Cache-Control': 'no-store'})
    async def socket(request):
        if not legacy.allowed_request(request, require_origin=True):
            raise web.HTTPForbidden()
        ws = web.WebSocketResponse(max_msg_size=2048)
        await ws.prepare(request)
        control, watcher = {'cancel': asyncio.Event()}, None
        async def watch():
            try:
                async for message in ws:
                    if message.type == WSMsgType.TEXT and json.loads(message.data) == {'type': 'cancel'}:
                        control['cancel'].set()
                    else:
                        break
            finally:
                control['cancel'].set()
        try:
            message = await asyncio.wait_for(ws.receive(), 15)
            data = json.loads(message.data)
            if not isinstance(data, dict) or set(data) != {'case'}:
                raise ValueError('invalid_start')
            watcher = asyncio.create_task(watch())
            await lab.run(data['case'], ws.send_json, control)
        except (ValueError, TypeError, asyncio.TimeoutError):
            if not ws.closed:
                await ws.send_json({'type': 'error', 'code': 'run_rejected'})
        finally:
            if watcher:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)
            await ws.close()
        return ws
    async def artifact(request):
        if not legacy.allowed_request(request):
            raise web.HTTPForbidden()
        name = request.match_info['name']
        allowed = {key + suffix for key in lab.cases for suffix in ('.json', '.wav', '-client.json')}
        allowed.update({'experiment.json'})
        if name not in allowed or not (lab.output / name).is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(lab.output / name, headers={'Cache-Control': 'no-store'})
    async def report(request):
        if not legacy.allowed_request(request, require_origin=True):
            raise web.HTTPForbidden()
        key = request.match_info['key']
        if key not in lab.cases:
            raise web.HTTPNotFound()
        try:
            data = await request.json()
        except ValueError:
            raise web.HTTPBadRequest()
        if not isinstance(data, dict) or data.get('mode') not in {'live', 'replay'}:
            raise web.HTTPBadRequest()
        if not (lab.output / f'{key}.json').exists():
            raise web.HTTPConflict(text='server_evidence_required')
        if data['mode'] == 'live':
            path = lab.output / f'{key}-client.json'
        else:
            replay_id = data.get('replayId', uuid4().hex)
            if not isinstance(replay_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', replay_id):
                raise web.HTTPBadRequest()
            path = lab.output / f'{key}-replay-{replay_id}-client.json'
        async with lab.lock:
            if path.exists():
                raise web.HTTPConflict(text='immutable_measurement')
            await asyncio.to_thread(early.write_json, path, data)
        return web.json_response({'saved': True, 'name': path.name})
    app.router.add_get('/api/action-timing', catalog)
    app.router.add_get('/api/action-timing/run', socket)
    app.router.add_post('/api/action-timing/report/{key}', report)
    app.router.add_get('/action-timing-data/{name}', artifact)
    app.router.add_get('/{path:.*}', legacy.static_handler)
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--port', type=int, default=18802)
    parser.add_argument('--enable-cloud', action='store_true')
    parser.add_argument('--local-proxy', action='store_true')
    args = parser.parse_args()
    config = legacy.load_config(args.env_file)
    if args.enable_cloud and not config.key:
        raise SystemExit('Cloud configuration unavailable')
    async def factory(configuration):
        if not args.local_proxy:
            return await legacy.connect_provider(configuration)
        client = legacy.ClientSession(timeout=legacy.ClientTimeout(total=None, connect=15), trust_env=False)
        try:
            socket = await client.ws_connect(configuration.endpoint + '?' + urlencode({'model': legacy.MODEL}),
                headers={'Authorization': 'Bearer ' + configuration.key}, proxy='http://127.0.0.1:7890',
                max_msg_size=1024 * 1024)
            return legacy.Provider(client, socket)
        except BaseException:
            await client.close()
            raise
    web.run_app(create_app(Lab(config, args.output, factory, args.enable_cloud, args.local_proxy)),
                host='127.0.0.1', port=args.port, print=print)
