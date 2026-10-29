"""Owned playback facts reach the real planner input; no cloud or history writes."""
import asyncio
import base64
from copy import deepcopy
import json

import pytest

from test_character_center_backend import fixture, user_job, m


def voice(t, frames=24000):
    t['segments'] = [{'responseId': 'voice_1', 'connectionId': 'provider_1',
                      'startFrame': 0, 'frames': frames}]
    t['result'] = {'status': 'completed', 'audioDone': True, 'frames': frames}


def receipt(t, **fields):
    return {'type': 'character_playback_state', 'turnId': t['id'], 'segmentIndex': 0,
            'responseId': 'voice_1', 'providerConnectionId': 'provider_1',
            'playedFrame': 12000, 'status': 'playing', 'sourceActive': True,
            'sequence': 1, **fields}


def test_provider_done_does_not_mean_browser_finished_and_state_is_not_history_ack(tmp_path):
    async def run():
        s, _, _, _, t = await fixture(tmp_path)
        voice(t)
        assert (await s.playback_state(receipt(t)))['accepted']
        v = s._voice_playback_view(t)
        assert v['provider_generation_complete'] and v['state'] == 'playing'
        assert v['can_anchor_voice'] and v['buffered_remaining_ms'] == 500
        r = await s.playback_state(receipt(t, playedFrame=24000, status='ended', sourceActive=False, sequence=2))
        assert r == {'accepted': True, 'historyAcknowledged': False}
        assert not t['acknowledged'] and t['deliveryId'] is None
        assert s._voice_playback_view(t)['state'] == 'ended'
        assert not s._voice_playback_view(t)['can_anchor_voice']
        await s.planner_warm_task
    asyncio.run(run())


def test_streaming_owner_is_known_before_provider_completion(tmp_path):
    async def run():
        s, _, _, _, t = await fixture(tmp_path)
        t['inFlight'] = True
        await s.emit('response_created', turnId=t['id'], segmentIndex=0, startFrame=0,
                     responseId='voice_1', providerConnectionId='provider_1')
        await s.emit('audio', turnId=t['id'], segmentIndex=0, responseId='voice_1',
                     providerConnectionId='provider_1', pcm=base64.b64encode(bytes(24000)).decode())
        assert not t['segments']
        assert (await s.playback_state(receipt(t, playedFrame=1000)))['accepted']
        assert s._voice_playback_view(t)['received_frames'] == 12000
        assert not s._voice_playback_view(t)['provider_generation_complete']
        assert not (await s.playback_state(receipt(t, playedFrame=12000, status='ended',
                                                    sourceActive=False, sequence=2)))['accepted']
        await s.planner_warm_task
    asyncio.run(run())


@pytest.mark.parametrize('change', [
    {'turnId': 'other_turn'}, {'responseId': 'wrong'}, {'providerConnectionId': 'wrong'},
    {'segmentIndex': 2}, {'sequence': 1}, {'sequence': True}, {'playedFrame': 11999},
    {'playedFrame': 24001}, {'status': 'ended'}, {'status': 'paused'}, {'status': 'made_up'},
])
def test_stale_cross_owner_or_invalid_state_cannot_replace_evidence_or_break_voice(tmp_path, change):
    async def run():
        s, budget, _, seen, t = await fixture(tmp_path)
        voice(t); await s.playback_state(receipt(t))
        before = deepcopy(s._playback_states)
        r = await s.playback_state(receipt(t, **{'sequence': 2, **change}))
        assert not r['accepted'] and not r['historyAcknowledged']
        assert s._playback_states == before and not budget.data['blocked']
        assert seen[-1]['type'] == 'character_playback_state_rejected'
        assert not t['cancel'].is_set() and not t['acknowledged']
        await s.planner_warm_task
    asyncio.run(run())


def test_stale_playing_becomes_unknown_but_terminal_end_does_not_resurrect(tmp_path):
    async def run():
        s, _, _, _, t = await fixture(tmp_path)
        voice(t); await s.playback_state(receipt(t))
        s._playback_states[t['id']]['receivedAt'] -= 2
        v = s._voice_playback_view(t)
        assert v['state'] == 'unknown' and not v['fresh'] and not v['can_anchor_voice']
        await s.playback_state(receipt(t, playedFrame=24000, status='ended', sourceActive=False, sequence=2))
        s._playback_states[t['id']]['receivedAt'] -= 20
        assert s._voice_playback_view(t)['state'] == 'ended'
        r = await s.playback_state(receipt(t, playedFrame=24000, sequence=3))
        assert r['reason'] == 'playback_state_terminal_resurrection'
        await s.planner_warm_task
    asyncio.run(run())


def test_old_segment_cannot_overwrite_new_segment_even_with_new_sequence(tmp_path):
    async def run():
        s, _, _, _, t = await fixture(tmp_path)
        voice(t)
        t['segments'].append({'responseId':'voice_2','connectionId':'provider_2','startFrame':24000,'frames':24000})
        t['result']['frames'] = 48000
        await s.playback_state(receipt(t))
        new = receipt(t, segmentIndex=1, responseId='voice_2', providerConnectionId='provider_2', playedFrame=30000, sequence=2)
        assert (await s.playback_state(new))['accepted']
        assert not (await s.playback_state(receipt(t, playedFrame=24000, status='ended', sourceActive=False, sequence=3)))['accepted']
        assert s._voice_playback_view(t)['state'] == 'playing'
        assert s._voice_playback_view(t)['segment_index'] == 1
        await s.planner_warm_task
    asyncio.run(run())


def test_pending_voice_is_explicit_and_paused_or_failed_voice_not_allowed(tmp_path):
    async def run():
        s, _, _, _, t = await fixture(tmp_path)
        assert not s._voice_playback_view(t)['can_anchor_voice']
        s._turn_contexts[t['id']] = []
        assert s._voice_playback_view(t)['state'] == 'awaiting_voice'
        assert s._voice_playback_view(t)['expected_voice_pending']
        s._error_notified.add(t['id'])
        assert not s._voice_playback_view(t)['can_anchor_voice']
        voice(t); await s.playback_state(receipt(t, status='paused', sourceActive=False))
        assert not s._voice_playback_view(t)['can_anchor_voice']
        t['cancel'].set()
        assert s._voice_playback_view(t)['state'] == 'cancelled'
        assert not (await s.playback_state(receipt(t, sequence=2)))['accepted']
        await s.planner_warm_task
    asyncio.run(run())


def test_queued_job_refreshes_real_playback_before_transmission_and_logs_same_fact(tmp_path):
    async def run():
        s, _, _, seen, t = await fixture(tmp_path)
        voice(t); await s.playback_state(receipt(t))
        payload = await s._payload(t, [])
        assert payload['voice_playback']['state'] == 'playing'
        payload.update(turn_id=t['id'], evidence_refs=['user:'+t['id']], media_anchor={'kind':'immediate'})
        gate, entered = asyncio.Event(), asyncio.Event()
        original_valid = s._valid
        async def valid(*args, **kwargs):
            entered.set(); await gate.wait()
            return await original_valid(*args, **kwargs)
        s._valid = valid
        connection = s.planner_warm_connection
        captured = []
        original_context = connection.add_context
        async def context(messages, **kwargs):
            captured.append(json.loads(messages[0]['content']))
            return await original_context(messages, **kwargs)
        connection.add_context = context
        job = s._submit('user:'+t['id'], 'user', 1, payload, turn=t, priority=2)
        await entered.wait()
        await s.playback_state(receipt(t, playedFrame=24000, status='ended', sourceActive=False, sequence=2))
        gate.set(); await job.task
        assert payload['voice_playback']['state'] == 'playing'  # original queue snapshot preserved
        assert captured[0]['voice_playback']['state'] == 'ended'
        assert not captured[0]['voice_playback']['can_anchor_voice']
        event = next(e for e in seen if e['type']=='character_semantic_request')
        assert event['voicePlayback'] == captured[0]['voice_playback']
        assert not t['acknowledged']
    asyncio.run(run())


def test_prompt_explains_playback_without_choosing_fixed_actions():
    rules = m.protocol.RULES
    assert 'voice_playback' in rules and 'can_anchor_voice=true' in rules
    assert 'provider_generation_complete' in rules and '不是虚构' in rules
    assert '每轮动作数量、顺序、重复、不做由你决定' in rules


@pytest.mark.parametrize('field,status', [
    (field,status) for field in ['result','lastTerminal']
    for status in ['completed','failed','cancelled','incomplete']
])
def test_cached_context_never_means_pending_voice_after_any_generation_terminal(tmp_path,field,status):
    async def run():
        s, _, _, _, t = await fixture(tmp_path)
        s._turn_contexts[t['id']] = []
        t['inFlight'] = True  # terminal may precede the finally block clearing this
        t[field] = {'status': status, 'audioDone': status == 'completed'}
        view = s._voice_playback_view(t)
        assert not view['expected_voice_pending'] and not view['can_anchor_voice']
        await s.planner_warm_task
    asyncio.run(run())


def test_completed_handoff_segment_may_still_have_pending_second_voice(tmp_path):
    async def run():
        s, _, _, _, t = await fixture(tmp_path)
        s._turn_contexts[t['id']] = []
        t['lastTerminal'] = {'status':'completed','handoff':{'reason':'memory_retrieval'}}
        assert s._voice_playback_view(t)['expected_voice_pending']
        await s.planner_warm_task
    asyncio.run(run())


@pytest.mark.parametrize('failure_point', ['encoding', 'add_context'])
def test_context_failure_after_reserve_is_unused_without_generation_or_unknown(tmp_path, monkeypatch, failure_point):
    async def run():
        s, budget, socket, seen, t = await fixture(tmp_path)
        connection = await s.planner_warm_task
        payload = await s._payload(t, [])
        payload.update(turn_id=t['id'], evidence_refs=['user:'+t['id']], media_anchor={'kind':'immediate'})
        if failure_point == 'encoding':
            def broken_encoding(payload):
                raise ValueError('fake_encoding_failure')
            monkeypatch.setattr(m.input_view, 'encoded', broken_encoding)
        else:
            async def broken_context(*args, **kwargs):
                raise RuntimeError('fake_context_failure')
            connection.add_context = broken_context
        job = s._submit('user:'+t['id'], 'user', 1, payload, turn=t, priority=2)
        await job.task
        assert len(budget.data['responses']) == 1
        assert budget.data['responses'][0]['state'] == 'unused'
        assert not budget.data['blocked'] and not budget.data['frozenChannels']
        assert not any(e['type'] == 'response.create' for e in socket.sent)
        assert not any(e['type'] == 'character_semantic_request' for e in seen)
        assert any(e['type'] == 'character_semantic_error' for e in seen)
        assert not t['acknowledged']
    asyncio.run(run())
