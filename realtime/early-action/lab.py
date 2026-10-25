"""Experimental, fixed 14-response comparison. No WAI state or automatic retries.

Avatar receipts are withheld until response.done. One case is exactly one
response.create, including tool-only failure. New unknown usage closes the batch.
"""
from __future__ import annotations
import argparse
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import struct
import sys
import time
from uuid import uuid4
import wave
from urllib.parse import urlencode
from aiohttp import web, WSMsgType

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'realtime/qwen'))
import server as legacy

LIMIT = 14
EXPERIMENT_ID = 'early-action-20261024'
VERSION = 2
GROUPS = {'A': '无工具语音', 'B': '语音优先 D', 'C': '动作优先，不等回执'}
EXPRESSIONS = ['neutral', 'smile', 'happy', 'curious', 'focus', 'surprise', 'shy', 'playful']
GESTURES = ['none', 'nod', 'shake', 'tilt', 'glance', 'blink', 'explain', 'wave', 'shrug',
            'chest', 'bow_smile', 'laugh', 'curious', 'shy', 'explain_firm', 'surprise',
            'think', 'greet', 'listen', 'comfort', 'look_up', 'agree']
PERSONA = '''你是爱弥斯，温暖、清醒、有自己判断的中文虚拟伙伴。像熟悉的朋友自然交流，不谄媚、不夸张，不编造经历。
结合提供的历史和当前问题回答，不朗读历史或标签。普通等待不意味着困惑，不要每句话都思考或抬手。
这是受控语音实验：有【本轮台词】时逐字说出台词，不增删开场白；没有指定台词时自然回答。
禁止把JSON、工具名称、参数或执行说明说出来，不说“我来调用工具”。'''
POLICY = {
 'A': '直接开始说出本轮完整台词，不调用工具。',
 'B': '先开始说出本轮实质语音，再附带一次perform_avatar。在同一个响应中完成语音和工具调用，语音不要等待工具回执，不能只给工具不说话。',
 'C': '尽早先给出一次简短的perform_avatar完整参数，紧接着在同一个响应中说出完整台词。这个工具只是表现通知，不提供回答所需信息；语音不要等待工具回执，不要把语音留到下一响应。不能只给工具不说话。',
}

def settings(group):
    instruction = PERSONA + '\n' + POLICY[group]
    tool = {'type': 'function', 'function': {'name': 'perform_avatar',
        'description': '提交本轮一个可选身体动作和短暂表情意图。只作表现通知，不查询信息，不需要工具结果来回答；本地负责时序、幅度与撤销。',
        'parameters': {'type': 'object', 'additionalProperties': False,
            'properties': {'expression': {'type': 'string', 'enum': EXPRESSIONS},
                           'gesture': {'type': 'string', 'enum': GESTURES}},
            'required': ['expression', 'gesture']}}}
    if group != 'A':
        instruction += '\n表情和动作严格选择工具枚举；普通说明可nod或none，招呼可greet或wave。强度由本地决定，不控制关节、速度，不把表情建议当作长期情绪状态。'
    return {'modalities': ['text', 'audio'], 'voice': legacy.VOICE,
            'input_audio_format': 'pcm', 'output_audio_format': 'pcm',
            'turn_detection': None, 'instructions': instruction,
            'tools': [] if group == 'A' else [tool]}

def cases():
    scenes = {
        'greet': {'context': '用户：我回来啦。请轻快地挥手，跟我打个招呼。',
                  'text': '回来啦，今天过得怎么样？我在这儿呢。'},
        'compare': {'context': '用户：两个方案，一个回复快，一个理解更全面，应该怎么比较？请简单解释。',
                    'text': '我们先固定其他条件，分别比较回复速度和回答质量。简单的问题先快速回应，确实需要深入分析时再交给完整流程。'},
    }
    result = {}
    # Latin rotation, interleaved scenes. Fixed before any generation.
    for repeat in (1, 2):
        for index, (scene, data) in enumerate(scenes.items()):
            order = ['A', 'B', 'C']; offset = (repeat - 1 + index) % 3
            for group in order[offset:] + order[:offset]:
                key = f'{scene}-r{repeat}-{group}'
                result[key] = dict(data, id=key, scene=scene, repeat=repeat, group=group, probe=None)
    result['prep-cancel-C'] = dict(scenes['greet'], id='prep-cancel-C', group='C',
        scene='greet', repeat=0, probe='preparation-local-drain')
    result['speech-cancel-C'] = dict(scenes['compare'], id='speech-cancel-C', group='C',
        scene='compare', repeat=0, probe='speech-provider-cancel')
    return result

def validate_call(event):
    if event.get('name') != 'perform_avatar' or not legacy.IDENTIFIER.fullmatch(str(event.get('call_id', ''))):
        raise ValueError('invalid_tool_identity')
    raw = event.get('arguments')
    if not isinstance(raw, str) or len(raw) > 1024:
        raise ValueError('invalid_arguments')
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {'expression', 'gesture'}:
        raise ValueError('invalid_fields')
    if value['expression'] not in EXPRESSIONS or value['gesture'] not in GESTURES:
        raise ValueError('invalid_enum')
    return value

def valid_usage(usage):
    return (isinstance(usage, dict) and all(type(usage.get(k)) is int and 0 <= usage[k] <= 10_000_000
        for k in ['input_tokens', 'output_tokens', 'total_tokens']) and
        usage['input_tokens'] + usage['output_tokens'] == usage['total_tokens'])

def write_json(path, data):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)

def machine_state():
    result = {'platform': platform.platform(), 'logicalCpus': os.cpu_count()}
    try:
        import psutil
        result.update(cpuPercent=psutil.cpu_percent(), memoryAvailable=psutil.virtual_memory().available,
                      processRss=psutil.Process().memory_info().rss)
    except ImportError:
        result['loadUnavailable'] = True
    return result

def metrics(result):
    events = result['events']
    def event(kind): return next((e for e in events if e['type'] == kind), None)
    request, pcm, tool, ack = [event(k) for k in ('request_sent', 'non_silent_pcm', 'tool', 'receipt_send')]
    def delta(e): return e['atMs'] - request['atMs'] if e and request else None
    before = bool(pcm and tool and (ack is None or max(pcm['atMs'], tool['atMs']) < ack['atMs']))
    return {'firstNonSilentPcmMs': delta(pcm), 'completeToolMs': delta(tool),
        'receiptMs': delta(ack), 'sameResponseBothBeforeReceipt': before,
        'toolLeadOverPcmMs': pcm['atMs'] - tool['atMs'] if pcm and tool else None,
        'toolFirst': bool(pcm and tool and tool['atMs'] < pcm['atMs']),
        'toolOnly': bool(tool and not pcm), 'audioOnly': bool(pcm and not tool),
        'responseCreates': sum(e['type'] == 'request_sent' for e in events)}

class Lab:
    def __init__(self, config, output, factory=legacy.connect_provider, cloud=False, proxy=False):
        self.config, self.output, self.factory, self.cloud = config, Path(output), factory, cloud
        self.proxy = proxy
        self.output.mkdir(parents=True, exist_ok=True)
        self.cases, self.busy = cases(), False
        self.ledger_path = self.output / 'ledger.json'
        self.ledger = json.loads(self.ledger_path.read_text(encoding='utf-8')) if self.ledger_path.exists() else {'limit': LIMIT, 'responses': [], 'blocked': False}
        if self.ledger['limit'] != LIMIT: raise ValueError('immutable_batch_limit')
        if any(r.get('usageStatus') != 'reported' for r in self.ledger['responses']): self.ledger['blocked'] = True
        manifest = {'experimental': True, 'maxResponses': LIMIT, 'model': legacy.MODEL,
            'groups': GROUPS, 'settings': {g: settings(g) for g in GROUPS}, 'cases': self.cases,
            'order': list(self.cases), 'boundary': 'Fixed text/context to real streaming voice. No retrieval, microphone/VAD or physical speaker measurement. No fallback response. Prep probe revokes locally and drains provider to retain usage; speech probe sends response.cancel.'}
        path = self.output / 'experiment.json'
        if path.exists() and json.loads(path.read_text(encoding='utf-8')) != manifest: raise ValueError('immutable_experiment')
        write_json(path, manifest); write_json(self.ledger_path, self.ledger)

    def catalog(self):
        attempted, connection_failed = [], []
        for key in self.cases:
            path = self.output / f'{key}.json'
            if not path.exists(): continue
            data = json.loads(path.read_text(encoding='utf-8'))
            if data['metrics']['responseCreates'] == 0: connection_failed.append(key)
            else: attempted.append(key)
        return {'groups': GROUPS, 'cases': list(self.cases.values()), 'attempted': attempted,
            'used': len(self.ledger['responses']), 'limit': LIMIT, 'blocked': self.ledger['blocked'],
            'cloudEnabled': self.cloud, 'settings': {g: settings(g) for g in GROUPS},
            'connectionFailed': connection_failed, 'busy': self.busy, 'experimentId': EXPERIMENT_ID,
            'version': VERSION, 'network': 'local7890' if self.proxy else 'direct'}

    async def run(self, key, notify, control):
        if not self.cloud or key not in self.cases or self.busy or self.ledger['blocked'] or len(self.ledger['responses']) >= LIMIT or key in self.catalog()['attempted']:
            raise ValueError('run_not_allowed')
        self.busy = True
        # No response.create means a failed connection, not an unknown bill.
        # Preserve that evidence before a manual retry; reserved cases never retry.
        if (self.output / f'{key}.json').exists():
            if any(r['case'] == key for r in self.ledger['responses']):
                self.busy = False; raise ValueError('reserved_case_cannot_retry')
            archive = self.output / 'connection-failures' / (key + '-' + uuid4().hex[:8])
            archive.mkdir(parents=True)
            for suffix in ('.json', '-client.json', '.webm'):
                path = self.output / (key + suffix)
                if path.exists(): path.rename(archive / path.name)
        start = time.perf_counter(); provider = receive = active = None
        pcm = bytearray(); seen = set(); calls = []; cancel_at = None; first_non_silent = False
        result = {'case': self.cases[key], 'events': [], 'transcript': '', 'completed': False,
                  'cancelled': False, 'machineBefore': machine_state(), 'experimental': True}
        async def emit(kind, **data):
            item = {'type': kind, 'atMs': (time.perf_counter() - start) * 1000, **data}
            result['events'].append(item)
            try: await notify(item)
            except (ConnectionError, RuntimeError): control['cancel'].set()
        try:
            async with asyncio.timeout(70):
                await emit('connect_start')
                provider = await asyncio.wait_for(self.factory(self.config), 20)
                if (await provider.receive()).get('type') != 'session.created': raise ValueError('session_created_missing')
                await provider.send({'type': 'session.update', 'session': settings(self.cases[key]['group'])})
                updated = await provider.receive()
                if updated.get('type') != 'session.updated' or not legacy.session_matches(updated.get('session', {}), 'manual'): raise ValueError('configuration_mismatch')
                await emit('connection_ready')
                case = self.cases[key]
                if control['cancel'].is_set():
                    result['cancelled'] = True
                    raise ValueError('cancelled_before_create')
                await provider.send({'type': 'conversation.item.create', 'item': {'type': 'message', 'role': 'user',
                    'content': [{'type': 'input_text', 'text': '【历史上下文】\n' + case['context'] + '\n【本轮台词】\n' + case['text']}]}})
                active = {'case': key, 'responseId': None, 'usageStatus': 'pending'}
                self.ledger['responses'].append(active)
                await asyncio.to_thread(write_json, self.ledger_path, self.ledger)
                await emit('request_sent')
                await provider.send({'type': 'response.create', 'response': {'modalities': ['text', 'audio']}})
                while True:
                    if control['cancel'].is_set() and active['responseId'] and cancel_at is None:
                        cancel_at = time.perf_counter(); result['cancelled'] = True
                        await emit('cancel_sent', responseId=active['responseId'])
                        await provider.send({'type': 'response.cancel'})
                    if cancel_at and time.perf_counter() - cancel_at > 10: raise ValueError('cancel_drain_timeout')
                    receive = receive or asyncio.create_task(provider.receive())
                    done, _ = await asyncio.wait([receive], timeout=.01)
                    if not done: continue
                    event = receive.result(); receive = None; kind = event.get('type')
                    if kind == 'error': raise ValueError('provider_error')
                    if not str(kind).startswith('response.'): continue
                    rid = (event.get('response') or {}).get('id') if kind in {'response.created', 'response.done'} else event.get('response_id')
                    if kind == 'response.created':
                        if active['responseId'] or not isinstance(rid, str): raise ValueError('ambiguous_response')
                        active['responseId'] = rid
                        await emit('response_created', responseId=rid)
                    if not rid or rid != active['responseId']: raise ValueError('response_identity_mismatch')
                    if kind == 'response.audio.delta':
                        chunk = base64.b64decode(event['delta'], validate=True)
                        if not chunk or len(chunk) % 2: raise ValueError('invalid_pcm')
                        if len(pcm) + len(chunk) > 35 * 48000:
                            control['cancel'].set(); continue
                        offset = len(pcm) // 2; pcm.extend(chunk)
                        samples = struct.unpack('<' + 'h' * (len(chunk) // 2), chunk)
                        non_silent = next((i for i, v in enumerate(samples) if abs(v) >= 256), None)
                        if non_silent is not None and not first_non_silent:
                            first_non_silent = True
                            await emit('non_silent_pcm', responseId=rid, frame=offset + non_silent)
                        await emit('audio', responseId=rid, delta=event['delta'], afterCancel=result['cancelled'])
                    elif kind == 'response.audio_transcript.delta':
                        delta = event.get('delta', '')
                        if not isinstance(delta, str) or len(result['transcript']) + len(delta) > 8192: raise ValueError('invalid_subtitle')
                        result['transcript'] += delta
                        await emit('subtitle', responseId=rid, delta=delta)
                    elif kind == 'response.function_call_arguments.done':
                        call_id = event.get('call_id')
                        try:
                            plan = validate_call(event)
                            if call_id in seen or len(seen) >= 1 or case['group'] == 'A': raise ValueError('duplicate_or_excess_tool')
                            seen.add(call_id)
                            call = {'name': 'perform_avatar', 'callId': call_id, 'responseId': rid, 'arguments': event['arguments'], 'plan': plan}
                            calls.append(call); await emit('tool', **call)
                        except (ValueError, TypeError): await emit('tool_rejected', responseId=rid, reason='invalid_or_excess_tool')
                    elif kind == 'response.done':
                        data = event['response']; usage = data.get('usage')
                        active.update(status=data.get('status'), usage=usage, usageStatus='reported' if valid_usage(usage) else 'unknown')
                        result['response'] = dict(active)
                        if active['usageStatus'] != 'reported': self.ledger['blocked'] = True
                        await asyncio.to_thread(write_json, self.ledger_path, self.ledger)
                        await emit('response_done', responseId=rid, status=data.get('status'), usage=usage)
                        result['completed'] = data.get('status') == 'completed' and first_non_silent
                        if data.get('status') == 'cancelled': result['cancelled'] = True
                        if not self.ledger['blocked'] and data.get('status') == 'completed':
                            for call in calls:
                                await emit('receipt_send', responseId=rid, callId=call['callId'])
                                await provider.send({'type': 'conversation.item.create', 'item': {'type': 'function_call_output',
                                    'call_id': call['callId'], 'output': json.dumps({'validated': True, 'displayConfirmed': False})}})
                        break
        except BaseException as error:
            result['error'] = str(error) if type(error) is ValueError else type(error).__name__
            if active is None:
                cause = getattr(error, 'os_error', None)
                result['connectionError'] = {'class': type(error).__name__, 'errno': getattr(cause, 'errno', None),
                    'winerror': getattr(cause, 'winerror', None), 'network': 'local7890' if self.proxy else 'direct'}
            if active and active['usageStatus'] != 'reported':
                active['usageStatus'] = 'unknown'; self.ledger['blocked'] = True
        finally:
            if receive:
                receive.cancel(); await asyncio.gather(receive, return_exceptions=True)
            if provider:
                try: await asyncio.wait_for(provider.close(), 3)
                except BaseException: result['cleanupError'] = True
            await asyncio.to_thread(write_json, self.ledger_path, self.ledger)
            result['metrics'] = metrics(result); result['audioSeconds'] = len(pcm) / 48000
            result['machineAfter'] = machine_state()
            normalize = lambda s: re.sub(r'[^\w]', '', s)
            result['scriptMatch'] = normalize(result['transcript']) == normalize(self.cases[key]['text'])
            if pcm:
                with wave.open(str(self.output / f'{key}.wav'), 'wb') as stream:
                    stream.setparams((1, 2, 24000, 0, 'NONE', 'not compressed')); stream.writeframes(pcm)
            await asyncio.to_thread(write_json, self.output / f'{key}.json', result)
            self.busy = False
        await notify({'type': 'complete', 'result': {k: v for k, v in result.items() if k != 'events'}, 'blocked': self.ledger['blocked']})
        return result

def create_app(lab):
    app = web.Application(client_max_size=12 * 1024 * 1024)
    app[legacy.APP_STATE] = legacy.State(lab.config, ROOT, None, legacy.Limits(), lab.factory)
    async def catalog(request):
        if not legacy.allowed_request(request): raise web.HTTPForbidden()
        return web.json_response(lab.catalog())
    async def summary(request):
        if not legacy.allowed_request(request): raise web.HTTPForbidden()
        from report import summarize
        return web.json_response(await asyncio.to_thread(summarize, lab.output))
    async def export(request):
        if not legacy.allowed_request(request): raise web.HTTPForbidden()
        if lab.busy: raise web.HTTPConflict(text='Wait for the active response to finish before exporting')
        from bundle import create_bundle
        path = await asyncio.to_thread(create_bundle, lab.output)
        # A newly built archive is a complete attachment, never a cached/ranged
        # static file. Explicit bytes also avoid Windows sendfile differences.
        body = await asyncio.to_thread(path.read_bytes)
        return web.Response(body=body, content_type='application/zip', headers={
            'Content-Disposition': 'attachment; filename="Aemeath-early-action-results.zip"', 'Cache-Control': 'no-store'})
    async def package(request):
        if not legacy.allowed_request(request): raise web.HTTPForbidden()
        if lab.busy: raise web.HTTPConflict(text='Wait for the active response to finish before exporting')
        from bundle import create_bundle
        path = await asyncio.to_thread(create_bundle, lab.output)
        return web.json_response({'path': str(path.resolve()), 'bytes': path.stat().st_size,
            'message': 'ZIP saved locally. No browser download is required.'})
    async def socket(request):
        if not legacy.allowed_request(request, require_origin=True): raise web.HTTPForbidden()
        ws = web.WebSocketResponse(max_msg_size=2048); await ws.prepare(request)
        control = {'cancel': asyncio.Event()}; watcher = None
        async def watch():
            async for message in ws:
                if message.type == WSMsgType.TEXT and json.loads(message.data) == {'type': 'cancel'}: control['cancel'].set()
                else: control['cancel'].set(); break
            control['cancel'].set()
        try:
            message = await asyncio.wait_for(ws.receive(), 15)
            data = json.loads(message.data)
            if set(data) != {'case'}: raise ValueError('invalid_start')
            watcher = asyncio.create_task(watch())
            await lab.run(data['case'], ws.send_json, control)
        except (ValueError, asyncio.TimeoutError):
            if not ws.closed: await ws.send_json({'type': 'error', 'code': 'run_rejected'})
        finally:
            if watcher: watcher.cancel(); await asyncio.gather(watcher, return_exceptions=True)
            await ws.close()
        return ws
    async def artifact(request):
        if not legacy.allowed_request(request): raise web.HTTPForbidden()
        name = request.match_info['name']
        allowed = {f'{k}{suffix}' for k in lab.cases for suffix in ('.json', '.wav', '.webm', '-client.json')}
        allowed |= {'summary.json', 'experiment.json'}
        if name not in allowed or not (lab.output / name).is_file(): raise web.HTTPNotFound()
        return web.FileResponse(lab.output / name, headers={'Cache-Control': 'no-store'})
    async def client_report(request):
        if not legacy.allowed_request(request, require_origin=True): raise web.HTTPForbidden()
        key = request.match_info['key']
        if key not in lab.cases: raise web.HTTPNotFound()
        data = await request.json()
        if data.get('mode') == 'live':
            path = lab.output / f'{key}-client.json'
            if path.exists(): raise web.HTTPConflict(text='immutable_live_measurement')
        elif data.get('mode') == 'offline':
            suffix = (data.get('owner') or {}).get('responseId') or data.get('responseId', 'fixture')
            if not re.fullmatch(r'offline-[A-Za-z0-9_-]{1,40}', suffix): raise web.HTTPBadRequest()
            path = lab.output / f'{key}-{suffix}-client.json'
        elif data.get('mode') == 'replay' and data.get('measurementVersion') == 2:
            timing = data.get('synchronization')
            if timing not in ('legacy', 'immediate'): raise web.HTTPBadRequest()
            suffix = '-interrupt' if data.get('interruptAfterBodyMs') is not None else ''
            path = lab.output / f'{key}-sync-{timing}{suffix}-replay-client.json'
        else:
            path = lab.output / f'{key}-replay-client.json'
        await asyncio.to_thread(write_json, path, data)
        return web.json_response({'saved': True})
    async def video(request):
        if not legacy.allowed_request(request, require_origin=True): raise web.HTTPForbidden()
        key = request.match_info['key']
        if key not in lab.cases or not (lab.output / f'{key}.json').exists(): raise web.HTTPNotFound()
        if request.content_type != 'video/webm': raise web.HTTPUnsupportedMediaType()
        path = lab.output / f'{key}.webm'
        if path.exists(): raise web.HTTPConflict()
        body = await request.read()
        if not body.startswith(b'\x1aE\xdf\xa3'): raise web.HTTPBadRequest()
        await asyncio.to_thread(path.write_bytes, body)
        return web.json_response({'saved': True})
    app.router.add_get('/api/early-action', catalog)
    app.router.add_get('/api/early-action/summary', summary)
    app.router.add_get('/api/early-action/export', export)
    app.router.add_get('/api/early-action/package', package)
    app.router.add_get('/api/early-action/run', socket)
    app.router.add_post('/api/early-action/report/{key}', client_report)
    app.router.add_post('/api/early-action/video/{key}', video)
    app.router.add_get('/early-action-data/{name}', artifact)
    app.router.add_get('/{path:.*}', legacy.static_handler)
    return app

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--env-file', type=Path); parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--port', type=int, default=18799); parser.add_argument('--enable-cloud', action='store_true')
    parser.add_argument('--local-proxy', action='store_true', help='Use existing HTTP proxy at 127.0.0.1:7890. No system proxy changes.')
    args = parser.parse_args()
    config = legacy.load_config(args.env_file)
    if args.enable_cloud and not config.key: raise SystemExit('Cloud configuration unavailable')
    async def factory(configuration):
        if not args.local_proxy: return await legacy.connect_provider(configuration)
        client = legacy.ClientSession(timeout=legacy.ClientTimeout(total=None, connect=15), trust_env=False)
        try:
            socket = await client.ws_connect(configuration.endpoint + '?' + urlencode({'model': legacy.MODEL}),
                headers={'Authorization': 'Bearer ' + configuration.key}, proxy='http://127.0.0.1:7890', max_msg_size=1024*1024)
            return legacy.Provider(client, socket)
        except BaseException:
            await client.close(); raise
    web.run_app(create_app(Lab(config, args.output, factory=factory, cloud=args.enable_cloud, proxy=args.local_proxy)), host='127.0.0.1', port=args.port, print=print)
