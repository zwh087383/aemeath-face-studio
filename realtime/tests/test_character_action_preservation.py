"""Action feedback and preserved execution, with fake providers and isolated state."""
import asyncio
import pytest
from test_character_center_backend import fixture, user_job, actions


async def issued(tmp_path, command=None):
    s, budget, _, seen, turn = await fixture(tmp_path, [('perform_actions', command or actions(2))])
    job = await user_job(s, turn)
    event = next(e for e in seen if e['type'] == 'character_actions')
    submissions = []
    s._submit = lambda *a, **k: submissions.append((a, k)) or object()
    def receipt(index, status, **extra):
        return {'commandId': event['commandId'], 'index': index,
                'action': event['command']['actions'][index]['action'], 'status': status, **extra}
    return s, seen, turn, job, event, submissions, receipt


def test_short03_failure_waits_for_healthy_step_then_reports_both_to_model(tmp_path):
    async def run():
        s, seen, turn, _, _, submissions, receipt = await issued(tmp_path)
        answer = await s.action_receipt(receipt(1, 'expired', reason='voice_anchor_missed'))
        assert answer['reason'] == 'waiting_for_remaining_steps' and not submissions
        assert not s.issued_actions[receipt(0, 'completed')['commandId']]['reviewed']
        await s.action_receipt(receipt(0, 'admitted'))
        await s.action_receipt(receipt(0, 'started'))
        payload = await s._payload(turn)
        assert [r['status'] for r in payload['execution_state'][0]['steps']] == ['started', 'expired']
        assert not submissions and not turn.get('acknowledged')
        answer = await s.action_receipt(receipt(0, 'completed'))
        assert answer['replanned'] and len(submissions) == 1
        payload = submissions[0][0][3]
        assert [r['status'] for r in payload['settled_plan']['results']] == ['completed', 'expired']
        assert payload['settled_plan']['all_steps_terminal']
        assert payload['execution_state'] == [] and 'next_action' not in payload
        assert not (await s.action_receipt(receipt(0, 'completed')))['accepted']
        assert len(submissions) == 1
        assert len([e for e in seen if e['type'] == 'character_execution_progress']) == 2
    asyncio.run(run())


@pytest.mark.parametrize('order', [(0, 1, 2), (2, 1, 0), (1, 0, 2)])
def test_failure_and_dependent_cancellations_settle_once_in_any_receipt_order(tmp_path, order):
    async def run():
        s, _, _, _, _, submissions, receipt = await issued(tmp_path, actions(3))
        statuses = ['failed', 'cancelled', 'cancelled']
        for position, index in enumerate(order):
            answer = await s.action_receipt(receipt(index, statuses[index], reason='dependency_failed' if index else 'executor_failure'))
            assert answer['replanned'] == (position == 2)
        assert len(submissions) == 1
        assert [r['status'] for r in submissions[0][0][3]['settled_plan']['results']] == statuses
    asyncio.run(run())


def test_superseded_started_step_keeps_real_completion_without_old_plan_followup(tmp_path):
    async def run():
        s, _, turn, job, event, submissions, receipt = await issued(tmp_path)
        await s.action_receipt(receipt(0, 'started'))
        s._remember_actions('new-command', job, {**actions(1), 'operation': 'replace'})
        assert s.issued_actions[event['commandId']]['superseded']
        assert not s.issued_actions[event['commandId']].get('retired')
        assert (await s.action_receipt(receipt(1, 'cancelled', reason='model_replace_pending')))['accepted']
        state = (await s._payload(turn))['execution_state']
        assert state[0]['superseded_future'] and state[0]['steps'][0]['status'] == 'started'
        answer = await s.action_receipt(receipt(0, 'completed'))
        assert answer['accepted'] and not answer['replanned'] and not submissions
        assert s.action_history[-1]['status'] == 'completed'
    asyncio.run(run())


@pytest.mark.parametrize('status', ['admitted', 'started', 'completed'])
def test_cancelled_turn_never_replans_from_delayed_progress_or_completion(tmp_path, status):
    async def run():
        s, _, turn, _, _, submissions, receipt = await issued(tmp_path)
        await s.action_receipt(receipt(1, 'expired', reason='voice_anchor_missed'))
        turn['cancel'].set()
        assert (await s.action_receipt(receipt(0, status)))['reason'] == 'retired_turn'
        assert not submissions
    asyncio.run(run())


def test_progress_is_monotonic_deduplicated_and_does_not_consume_terminal_ack(tmp_path):
    async def run():
        s, _, _, _, _, submissions, receipt = await issued(tmp_path, {**actions(1), 'review': 'wait'})
        assert (await s.action_receipt(receipt(0, 'started')))['accepted']
        assert not (await s.action_receipt(receipt(0, 'admitted')))['accepted']
        assert not (await s.action_receipt(receipt(0, 'started')))['accepted']
        assert (await s.action_receipt(receipt(0, 'completed')))['accepted']
        assert not (await s.action_receipt(receipt(0, 'started')))['accepted']
        assert len(s.feedback_seen) == 1 and not submissions
    asyncio.run(run())


def test_explicit_clear_retires_kept_execution_and_refuses_late_receipts(tmp_path):
    async def run():
        s, _, _, job, _, submissions, receipt = await issued(tmp_path)
        await s.action_receipt(receipt(0, 'started'))
        s._remember_actions('stop', job, {'operation': 'clear', 'actions': []})
        assert (await s.action_receipt(receipt(0, 'completed')))['reason'] == 'retired_body_plan'
        assert not submissions
    asyncio.run(run())


def test_replacement_during_feedback_preparation_prevents_stale_followup(tmp_path):
    async def run():
        s, _, _, job, _, submissions, receipt = await issued(tmp_path, actions(1))
        payload = s._payload
        async def replace_during_snapshot(*args, **kwargs):
            s._remember_actions('newer', job, {**actions(1), 'operation': 'replace'})
            return await payload(*args, **kwargs)
        s._payload = replace_during_snapshot
        answer = await s.action_receipt(receipt(0, 'completed'))
        assert answer['reason'] == 'source_changed_during_feedback' and not submissions
    asyncio.run(run())
