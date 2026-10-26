"""Budget, real activity policy and isolated HTTP boundaries; no cloud calls."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys

import pytest

FACE = Path(__file__).resolve().parents[2]
WAI = Path('F:/AI-Shared/WAI')
sys.path.insert(0, str(WAI))
sys.path.insert(0, str(FACE / 'realtime/character-center'))
from budget import CenterBudget
from activity import ExperimentalPlanner
from tools.voice_avatar.duplex_transport import ProtocolError


def test_terminal_unknown_retains_bound_but_missing_terminal_freezes_only_channel(tmp_path):
    budget = CenterBudget(tmp_path / 'ledger.json')
    row = budget.reserve('action_planner', 'planner', 'turn')
    budget.created(row, 'response1')
    budget.settle(row, {'id': 'response1', 'status': 'cancelled', 'usage': None})
    assert budget.snapshot()['unknownReservedTokens'] == 245760 + 16384
    assert budget.available('action_planner') and budget.available('voice')
    lost = budget.reserve('action_planner', 'planner2', 'turn')
    budget.block('no_terminal', lost)
    assert not budget.available('action_planner')
    assert budget.available('voice') and budget.available('background')
    assert not budget.snapshot()['blocked']


def test_restart_never_refunds_reserved_request_or_pcm_credit(tmp_path):
    path = tmp_path / 'ledger.json'
    budget = CenterBudget(path)
    budget.reserve('listener', 'listen', 'next_input')
    budget.account_pcm(3200)
    reloaded = CenterBudget(path)
    assert not reloaded.available('listener')
    assert reloaded.snapshot()['pcmSeconds'] == 1
    assert reloaded.snapshot()['channels']['listener']['used'] == 1


def test_each_channel_and_turn_have_independent_caps(tmp_path):
    limits = {'listener': 1, 'voice': 1, 'action': 1, 'background': 1}
    budget = CenterBudget(tmp_path / 'ledger.json', limits=limits, max_turns=1, pcm_seconds=1)
    for role in ('listener', 'reply', 'action_planner', 'background'):
        budget.reserve(role, role, 't')
        with pytest.raises(ProtocolError):
            budget.reserve(role, role+'2', 't')
    budget.admit_turn('turn1')
    with pytest.raises(ProtocolError):
        budget.admit_turn('turn2')
    budget.account_pcm(32000)
    with pytest.raises(ProtocolError):
        budget.account_pcm(2)


def test_minimum_real_duration_and_pause_resume_cannot_complete_without_artifact(tmp_path):
    planner = ExperimentalPlanner(tmp_path/'activities.json', clock=lambda: 1000)
    planner.seed('reading-inflight', 'thread1', 1000)
    [started] = planner.due(1000)
    assert started.ends_at == 1120 and started.planned_minutes == 30
    planner.on_user_present(1005)
    assert planner.blocks()[0].status == 'paused'
    assert planner.due(1024) == []
    [resumed] = planner.due(1025)
    assert resumed.ends_at == 1140 and resumed.action == 'resume'
    [failed] = planner.due(1140)
    assert failed.status == 'failed' and failed.reason == 'no_persisted_artifact'


def test_real_artifact_can_exist_while_activity_paused_and_cannot_skip_wait(tmp_path):
    planner = ExperimentalPlanner(tmp_path/'activities.json')
    planner.seed('reading-artifact', 'thread1', 1000)
    planner.due(1000)
    planner.on_user_present(1002)
    assert planner.set_artifact('center:reading-artifact', 'artifact1')
    assert planner.blocks()[0].status == 'paused'
    assert planner.due(1021) == []
    planner.due(1022)
    assert planner.due(1139) == []
    [done] = planner.due(1140)
    assert done.status == 'done' and done.artifact_id == 'artifact1'


def test_repeated_case_is_not_silently_restarted(tmp_path):
    planner = ExperimentalPlanner(tmp_path/'activities.json')
    planner.seed('reading-failure', 'thread1', 1000)
    planner.fail('center:reading-failure', 'explicit_fault')
    with pytest.raises(ValueError, match='already_attempted'):
        planner.seed('reading-failure', 'thread1', 1002)


def test_provider_accounting_observes_real_result_and_bounds_max_tokens(tmp_path, monkeypatch):
    from provider_accounting import install_accounting, accounting_scope
    from wai.models import llm_client
    from types import SimpleNamespace
    calls = []
    def result(self, *args, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(usage=SimpleNamespace(model_dump=lambda: {
            'prompt_tokens': 20, 'completion_tokens': 8, 'total_tokens': 28}))
    monkeypatch.setattr(llm_client._PromptLoggingCompletions, 'create', result)
    budget = CenterBudget(tmp_path/'ledger.json')
    undo = install_accounting(budget)
    try:
        with accounting_scope('life_step:reading-inflight'):
            llm_client._PromptLoggingCompletions.create(object(), messages=[{'role':'user','content':'test'}], max_tokens=9999)
        assert calls[0]['max_tokens'] == 4096
        assert budget.snapshot()['reportedTokens'] == 28
        assert budget.snapshot()['channels']['background']['used'] == 1
        assert budget.data['responses'][0]['owner'] == 'life_step:reading-inflight'
    finally:
        undo()


def test_source_does_not_define_actions_or_future_assistant_script():
    fixtures = json.loads((FACE/'realtime/character-center/inputs.json').read_text(encoding='utf-8'))
    assert len(fixtures['clips']) == 12
    assert all(set(row) == {'id','group','text'} for row in fixtures['clips'])
    source = (FACE/'realtime/character-center/activity.py').read_text(encoding='utf-8')
    assert 'perform_actions' not in source and 'ACTIVITY_SEQUENCES' not in source


def test_revoking_previous_reply_does_not_resume_activity_under_new_user_speech():
    from activity import ReadingActivities
    from types import SimpleNamespace
    async def scenario():
        controller = ReadingActivities.__new__(ReadingActivities)
        controller.event_lock = asyncio.Lock()
        controller.user_speaking = controller.waiting_turn = False
        controller.active_turn = 'previous'
        controller.foreground = True
        controller.planner = SimpleNamespace(on_user_present=lambda: None)
        async def notify():
            pass
        controller._notify = notify
        await controller.on_event({'type':'speech_started','itemId':'new-input'})
        await controller.on_event({'type':'revoked','turnId':'previous'})
        assert controller.foreground and controller.user_speaking
        await controller.on_event({'type':'speech_stopped','valid':True})
        assert controller.foreground and controller.waiting_turn
        await controller.on_event({'type':'turn_started','turnId':'new-turn'})
        await controller.on_event({'type':'settled','turnId':'previous'})
        assert controller.foreground
        await controller.on_event({'type':'turn_error','turnId':'new-turn'})
        assert not controller.foreground
    asyncio.run(scenario())


@pytest.fixture
def real_local_reading_runtime(tmp_path, monkeypatch):
    """Real WAI stores/adapters, with only network and model boundaries faked."""
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from activity import ReadingActivities, SOURCE_URL
    from wai.memory.correction_ledger import CorrectionLedger
    from wai.proactive import activity_sources
    from wai.proactive.user_world import UserWorld
    from wai.proactive.v2_life_runtime import V2Life
    from wai.proactive.v2_runtime import V2Runtime

    now = datetime(2026, 10, 25, 12, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr('activity.time.time', lambda: now)
    monkeypatch.setattr(activity_sources, 'CorrectionLedger',
                        lambda: CorrectionLedger(tmp_path / 'corrections.json'))
    directory = tmp_path / 'wai'
    directory.mkdir()
    output = tmp_path / 'evidence'
    output.mkdir()
    calls, events = [], []
    def no_external_search(*args, **kwargs):
        raise AssertionError('unexpected external search')
    owner = SimpleNamespace(v2_public_search=no_external_search)
    kernel = SimpleNamespace(owner=owner, directory=directory, timezone_name='UTC', clock=lambda: now)
    kernel.rhythm = lambda at: {'usual_wake': '07:45', 'usual_sleep': '00:30'}
    kernel.world = UserWorld(directory / 'world.json', clock=kernel.clock)
    kernel.search_public = lambda query, read_pages=False: V2Runtime.search_public(
        kernel, query, read_pages=read_pages)
    body = ('The Moon is Earth\'s natural satellite. ' * 20).strip()
    def read_page(url):
        assert url == SOURCE_URL
        return {'url': url, 'title': 'Moon facts', 'text': body, 'extraction_status': 'ok',
                'fetched_at': now, 'transport': 'offline_fake_page_boundary'}
    kernel.read_shared_link = read_page
    def model_json(prompt, *, task):
        calls.append({'prompt': prompt, 'task': task})
        return {'activity_type': 'reading', 'title': 'Local contract test', 'content': 'A reading note.',
                'evidence_refs': [SOURCE_URL], 'worth_sharing': False}
    kernel.model_json = model_json
    kernel.life = V2Life(kernel)
    async def publish(event):
        events.append(event)
    controller = ReadingActivities(SimpleNamespace(heartbeat_engine=SimpleNamespace(v2=kernel)), output, publish)
    return SimpleNamespace(controller=controller, kernel=kernel, calls=calls, events=events, body=body, now=now)


def test_selected_page_matches_real_wai_read_pages_and_persists_real_artifact(real_local_reading_runtime):
    from activity import SOURCE_URL
    from wai.proactive.v2_life_runtime import _readable_sources
    env = real_local_reading_runtime
    async def scenario():
        await env.controller.start('reading-complete')
        packet = env.kernel.search_public('月球事实 最新消息', read_pages=True)
        [source] = _readable_sources(packet)
        assert source['url'] == SOURCE_URL and source['content'] == env.body
        assert source['evidence_type'] == 'page_extract'
        [block] = env.controller.planner.due(env.now)
        await env.controller._execute(block)
        saved = env.controller.planner.blocks()[0]
        artifact = env.kernel.life.life.artifact(saved.artifact_id)
        assert artifact and artifact['activity_type'] == 'reading'
        assert artifact['evidence_refs'] == [SOURCE_URL]
        assert len(env.calls) == 1 and env.calls[0]['task'] == 'proactive_life_step'
        assert env.body in env.calls[0]['prompt']
        assert saved.status == 'running'  # A real artifact does not skip activity time.
        fetch = env.kernel.life.state.read()['block_fetches'][block.block_id]
        assert fetch['status'] == 'done' and fetch['sources'][0]['content'] == env.body
        # Durable attempt reuse cannot re-issue the model request.
        await env.controller._execute(block)
        assert len(env.calls) == 1
    asyncio.run(scenario())


def test_reading_cases_have_independent_real_world_sources_and_keep_failed_evidence(real_local_reading_runtime):
    from copy import deepcopy
    env = real_local_reading_runtime
    async def scenario():
        first = await env.controller.start('reading-complete')
        env.controller.planner.fail(first['block']['block_id'], 'retained_original_failure', now=env.now)
        await env.controller._notify(force=True)
        old_record = deepcopy(env.controller.records['reading-complete'])
        old_source = env.kernel.world.get(old_record['sourceId'])
        second = await env.controller.start('reading-inflight')
        current = env.controller.records['reading-inflight']
        assert current['sourceId'] != old_record['sourceId']
        assert env.kernel.world.get(old_record['sourceId']) == old_source
        assert env.controller.records['reading-complete'] == old_record
        assert env.kernel.world.get(current['sourceId'])['topic_key'] != old_source['topic_key']
        threads = {t['id']: t for t in env.kernel.life.life.list_threads(active_only=False)}
        assert threads[first['block']['thread_id']]['status'] == 'vetoed'
        assert threads[second['block']['thread_id']]['evidence'][0]['world_id'] == current['sourceId']
        await env.controller.revoke()
        assert env.kernel.world.get(current['sourceId'])['closed_reason'] == 'cancel'
        assert env.kernel.world.get(old_record['sourceId']) == old_source
        third = await env.controller.start('reading-artifact')
        assert third['status'] == 'planned'
        assert env.kernel.world.get(current['sourceId'])['closed_reason'] == 'cancel'
        with pytest.raises(ValueError, match='case_already_attempted'):
            await env.controller.start('reading-complete')
    asyncio.run(scenario())


def test_empty_real_page_stops_before_model_and_keeps_failed_fetch_receipt(real_local_reading_runtime):
    from activity import SOURCE_URL
    env = real_local_reading_runtime
    env.kernel.read_shared_link = lambda url: {'url': SOURCE_URL, 'text': '',
                                              'extraction_status': 'ok', 'fetched_at': env.now}
    async def scenario():
        await env.controller.start('reading-complete')
        [block] = env.controller.planner.due(env.now)
        await env.controller._execute(block)
        saved = env.controller.planner.blocks()[0]
        assert saved.status == 'failed' and saved.reason == 'reading_source_unavailable'
        assert env.calls == [] and not saved.artifact_id
        assert env.kernel.life.state.read()['block_fetches'][block.block_id]['status'] == 'failed'
    asyncio.run(scenario())


def test_fast_voice_gets_real_artifact_and_pause_does_not_revoke_source(real_local_reading_runtime):
    env = real_local_reading_runtime
    async def scenario():
        await env.controller.start('reading-complete')
        [block] = env.controller.planner.due(env.now)
        await env.controller._execute(block)
        packet = await env.controller.voice_context()
        assert packet['context']['persistedArtifact']['content'] == 'A reading note.'
        assert packet['context']['activityCompleted'] is False
        assert packet['context']['status'] == 'running'
        assert await env.controller.voice_context_valid(packet['sourceToken'])
        env.controller.planner.on_user_present(env.now + 3)
        assert env.controller.snapshot()['status'] == 'paused'
        assert await env.controller.voice_context_valid(packet['sourceToken'])
        assert packet['context']['status'] == 'running'  # Frozen facts stay labelled as a snapshot.
        await env.controller.revoke()
        assert not await env.controller.voice_context_valid(packet['sourceToken'])
        assert await env.controller.voice_context() is None
    asyncio.run(scenario())


def test_fast_voice_guard_rereads_artifact_instead_of_reusing_previous_permission(real_local_reading_runtime):
    from wai.proactive.intent_store import atomic_json_update
    env = real_local_reading_runtime
    async def scenario():
        await env.controller.start('reading-complete')
        [block] = env.controller.planner.due(env.now)
        await env.controller._execute(block)
        packet = await env.controller.voice_context()
        assert await env.controller.voice_context_valid(packet['sourceToken'])
        identity = packet['sourceToken']['artifactId']
        def change(state):
            state['artifacts'][identity]['content'] = 'The original note was corrected.'
        atomic_json_update(env.kernel.life.life.path, lambda: {}, change)
        assert not await env.controller.voice_context_valid(packet['sourceToken'])
    asyncio.run(scenario())


def test_start_next_case_retains_terminal_before_the_display_poll(real_local_reading_runtime):
    env = real_local_reading_runtime
    async def scenario():
        await env.controller.start('reading-complete')
        [block] = env.controller.planner.due(env.now)
        await env.controller._execute(block)
        env.controller.planner.due(env.now + 121)
        assert env.controller.snapshot()['status'] == 'done'
        assert env.controller.records['reading-complete']['events'][-1]['status'] == 'running'
        await env.controller.start('reading-inflight')
        terminal = env.controller.records['reading-complete']['events'][-1]
        assert terminal['status'] == 'done' and terminal['artifactId']
        assert terminal['transitionReceipt'] is True
    asyncio.run(scenario())
