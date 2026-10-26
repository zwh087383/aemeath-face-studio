"""Stopped same-batch recovery tests with temporary state and fake bootstrap."""
import importlib.util
import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / 'character-center/resume.py'
SPEC = importlib.util.spec_from_file_location('character_center_resume_tested', MODULE_PATH)
resume = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(resume)


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')


@pytest.fixture
def stopped(tmp_path):
    source, output, target = (tmp_path / name for name in ('old-state', 'output', 'new-state'))
    source.mkdir(); output.mkdir(); target.mkdir()
    marker = {'experiment': resume.ISOLATION, 'batch_id': resume.EXPERIMENT, 'synthetic_only': True, 'state': 'running'}
    write(source / resume.MARKER, marker); write(target / resume.MARKER, {**marker, 'state': 'prepared'})
    (source / '.lock').write_text('old lock must stay old')
    (source / 'memory.json').write_text('{"retained":"真实记忆"}', encoding='utf-8')
    rows = []
    for request, turn in [('turn-1', 'runtime-1'), ('turn-2', 'runtime-2')]:
        rows.append({'op': 'created', 'message': {'message_id': request, 'turn_id': turn, 'role': 'user', 'metadata': {'request_id': request}}})
    rows += [{'op': 'created', 'message': {'message_id': 'a1', 'turn_id': 'runtime-1', 'role': 'assistant', 'delivery_id': 'd1', 'delivery_state': 'pending_ack'}},
             {'op': 'acked', 'delivery_id': 'd1'},
             {'op': 'created', 'message': {'message_id': 'failure-note', 'turn_id': 'runtime-2', 'role': 'system', 'delivery_id': 'd2', 'delivery_state': 'pending_ack'}}]
    (source / 'visible_transcript.jsonl').write_text('\n'.join(json.dumps(row) for row in rows), encoding='utf-8')
    for name in ('pending_effects.sqlite3', 'input_maintenance.sqlite3'):
        with sqlite3.connect(source / name) as db:
            db.execute('CREATE TABLE effects (state TEXT)'); db.execute("INSERT INTO effects VALUES ('done')")
    provider = {'id': 'response-row', 'channel': 'action', 'state': 'unknown', 'responseId': 'response1',
                'terminalObserved': True, 'status': 'cancelled', 'usage': None,
                'maxTokens': {'input': 245760, 'output': 16384}}
    ledger = {'experimentId': resume.EXPERIMENT, 'blocked': False, 'frozenChannels': {}, 'turnLimit': 12,
              'channelLimits': resume.LIMITS, 'responseLimit': 228, 'turns': ['turn-1', 'turn-2'],
              'responses': [provider], 'pcmBytes': 3200, 'pcmReservedBytes': 32000, 'pcmByteLimit': 480*32000,
              'unknownUsagePolicy': 'terminal_missing_usage_keeps_full_reservation'}
    write(output/'ledger.json', ledger)
    state = output/'server-state.json'; write(state, {'pid': 1234, 'cloud': True})
    manifest = output/'source-manifest-test.json'; write(manifest, {'experimental': True, 'dataDirectory': str(source), 'sourceHashes': {'backend.py': 'a'*64}})
    evidence = output/'evidence.json'; write(evidence, {'experiment': resume.ISOLATION, 'batch_id': resume.EXPERIMENT, 'synthetic_only': True,
        'runtime': {'turns': {'completed': 1, 'failed': 1}, 'active_acks': 0, 'deliveries': {'delivered': 1, 'pending_ack': 1}},
        'queues': {'reply_effects': {'done': 1}, 'input_maintenance': {'done': 1}}, 'observer': {'active': {}}})
    status = output/'status.json'; write(status, {'experimentId': resume.EXPERIMENT, 'connected': False, 'cloudEnabled': True,
        'budget': {'blocked': False, 'reserved': 0, 'turns': 2, 'responses': 1, 'unknown': 1, 'turnLimit': 12, 'responseLimit': 228}})
    return SimpleNamespace(source=source, output=output, target=target, ledger=ledger, provider=provider,
        config=SimpleNamespace(data_dir=target, batch_id=resume.EXPERIMENT),
        kwargs={'process_alive': lambda pid: False, 'state_path': state, 'manifest_path': manifest, 'evidence_path': evidence, 'status_path': status})


def test_terminal_unknown_and_pending_ack_are_preserved_byte_for_byte(stopped):
    old = resume.inventory(stopped.source); ledger = (stopped.output/'ledger.json').read_bytes()
    receipt = resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)
    assert receipt['unknownMaximumReservedTokens'] == 262144 and receipt['pendingAckPreserved'] == 1
    restored = resume.restore_snapshot(stopped.source, stopped.config, receipt, process_alive=lambda _: False)
    assert resume.inventory(stopped.source) == old == resume.inventory(stopped.target)
    assert (stopped.output/'ledger.json').read_bytes() == ledger
    assert not (stopped.target/'.lock').exists() and (stopped.source/'.lock').exists()
    assert resume.read(stopped.source/resume.MARKER)['state'] == 'running'
    assert resume.read(stopped.target/resume.MARKER)['state'] == 'prepared'
    called = []
    value = resume.bootstrap_resumed(stopped.config, restored, process_alive=lambda _: False,
        bootstrap=lambda config, **kwargs: called.append((config, kwargs)) or 'fake-runtime')
    assert value == 'fake-runtime' and called == [(stopped.config, {'seed': False})]
    assert restored['historyAcknowledgedByRecovery'] is False


@pytest.mark.parametrize('change,error', [
    ({'state': 'active'}, 'provider_terminal'),
    ({'terminalObserved': False}, 'provider_terminal'),
    ({'maxTokens': {'input': 1, 'output': 1}}, 'maximum_reservation'),
    ({'state': 'unused'}, 'started_response'),
])
def test_uncertain_or_refunded_provider_cannot_resume(stopped, change, error):
    stopped.provider.update(change); write(stopped.output/'ledger.json', stopped.ledger)
    with pytest.raises(ValueError, match=error): resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)


@pytest.mark.parametrize('field,value,error', [
    ('frozenChannels', {'action': 'missing_terminal'}, 'ledger_blocked'),
    ('turnLimit', 13, 'budget_limit'), ('responseLimit', 229, 'budget_limit'),
    ('pcmByteLimit', 481*32000, 'pcm_reservation'),
    ('turns', ['another-turn'], 'history_ledger'),
])
def test_original_caps_and_visible_user_ownership_are_required(stopped, field, value, error):
    stopped.ledger[field] = value; write(stopped.output/'ledger.json', stopped.ledger)
    with pytest.raises(ValueError, match=error): resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)


def test_live_process_and_mismatched_manifest_are_rejected(stopped):
    with pytest.raises(ValueError, match='stopped_process'):
        resume.validate_source(stopped.source, stopped.output, **{**stopped.kwargs, 'process_alive': lambda _: True})
    manifest = resume.read(stopped.kwargs['manifest_path']); manifest['dataDirectory'] = str(stopped.target); write(stopped.kwargs['manifest_path'], manifest)
    with pytest.raises(ValueError, match='manifest_mismatch'): resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)


def test_inflight_effects_and_active_turns_are_rejected(stopped):
    with sqlite3.connect(stopped.source/'pending_effects.sqlite3') as db: db.execute("UPDATE effects SET state='running'")
    with pytest.raises(ValueError, match='background_not_settled'): resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)
    with sqlite3.connect(stopped.source/'pending_effects.sqlite3') as db: db.execute("UPDATE effects SET state='done'")
    data = resume.read(stopped.kwargs['evidence_path']); data['runtime']['turns'] = {'completed': 1, 'generating': 1}; write(stopped.kwargs['evidence_path'], data)
    with pytest.raises(ValueError, match='runtime_not_settled'): resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)


def test_control_or_source_mutations_between_validation_and_copy_fail_closed(stopped):
    receipt = resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)
    (stopped.source/'memory.json').write_text('changed')
    with pytest.raises(ValueError, match='source_changed'): resume.restore_snapshot(stopped.source, stopped.config, receipt, process_alive=lambda _: False)
    assert set(p.name for p in stopped.target.iterdir()) == {resume.MARKER}


def test_accounting_changes_and_nonempty_destination_are_not_overwritten(stopped):
    receipt = resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)
    stopped.ledger['pcmBytes'] += 2; write(stopped.output/'ledger.json', stopped.ledger)
    with pytest.raises(ValueError, match='accounting_or_receipt_changed'): resume.restore_snapshot(stopped.source, stopped.config, receipt, process_alive=lambda _: False)
    (stopped.target/'other.txt').write_text('keep')
    with pytest.raises(ValueError, match='new_snapshot_directory'): resume.restore_snapshot(stopped.source, stopped.config, receipt, process_alive=lambda _: False)
    assert (stopped.target/'other.txt').read_text() == 'keep'


def test_database_check_reads_committed_wal_and_never_writes_source_sidecars(stopped):
    path = stopped.source/'pending_effects.sqlite3'
    db = sqlite3.connect(path); db.execute('PRAGMA journal_mode=WAL'); db.execute("UPDATE effects SET state='running'"); db.commit()
    before = resume.inventory(stopped.source)
    try:
        with pytest.raises(ValueError, match='background_not_settled'): resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)
        assert resume.inventory(stopped.source) == before
    finally: db.close()


def test_conservative_pcm_credit_roundup_is_allowed_but_unknown_refund_is_not(stopped):
    receipt = resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)
    receipt = resume.restore_snapshot(stopped.source, stopped.config, receipt, process_alive=lambda _: False)
    stopped.ledger['pcmBytes'] = stopped.ledger['pcmReservedBytes']; write(stopped.output/'ledger.json', stopped.ledger)
    assert resume.bootstrap_resumed(stopped.config, receipt, process_alive=lambda _: False, bootstrap=lambda *a, **kw: kw) == {'seed': False}
    stopped.provider['state'] = 'reported'; stopped.provider['usage'] = {'total_tokens': 0, 'input_tokens': 0, 'output_tokens': 0}; write(stopped.output/'ledger.json', stopped.ledger)
    with pytest.raises(ValueError, match='ledger_changed'): resume.bootstrap_resumed(stopped.config, receipt, process_alive=lambda _: False, bootstrap=lambda *a, **kw: None)


def test_provider_ownership_cannot_change_between_copy_and_bootstrap(stopped):
    receipt = resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)
    receipt = resume.restore_snapshot(stopped.source, stopped.config, receipt, process_alive=lambda _: False)
    stopped.provider['owner'] = 'different-turn'; write(stopped.output/'ledger.json', stopped.ledger)
    with pytest.raises(ValueError, match='ledger_changed'):
        resume.bootstrap_resumed(stopped.config, receipt, process_alive=lambda _: False, bootstrap=lambda *a, **kw: None)


@pytest.fixture
def resumed_once(stopped):
    first = resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)
    first = resume.restore_snapshot(stopped.source, stopped.config, first, process_alive=lambda _: False)
    parent = stopped.output/'resume-receipt-first.json'; write(parent, first)
    marker = resume.read(stopped.target/resume.MARKER); marker['state'] = 'running'; write(stopped.target/resume.MARKER, marker)
    # Original evidence is immutable; only the shared ledger advances.
    stopped.ledger['responses'].append({**stopped.provider, 'id': 'response-row-2', 'responseId': 'response2'})
    write(stopped.output/'ledger.json', stopped.ledger)
    state = stopped.output/'server-state-second.json'; write(state, {'pid': 5678, 'cloud': True})
    manifest = stopped.output/'source-manifest-second.json'
    write(manifest, {'experimental': True, 'dataDirectory': str(stopped.target), 'sourceHashes': {'backend.py': 'b'*64}})
    evidence = stopped.output/'evidence-second.json'
    data = resume.read(stopped.kwargs['evidence_path']); data['runtime']['turns'] = {}; write(evidence, data)
    status = stopped.output/'status-second.json'
    data = resume.read(stopped.kwargs['status_path']); data['budget'].update(responses=2, unknown=2); write(status, data)
    return SimpleNamespace(first=first, parent=parent, old=stopped, source=stopped.target, output=stopped.output,
        kwargs={'process_alive': lambda _: False, 'state_path': state, 'manifest_path': manifest,
                'evidence_path': evidence, 'status_path': status})


def test_second_resume_inherits_terminal_turns_without_resetting_accounting(resumed_once, tmp_path):
    case = resumed_once
    source_before = resume.inventory(case.source); old_before = resume.inventory(case.old.source)
    ledger_before = (case.output/'ledger.json').read_bytes(); parent_before = case.parent.read_bytes()
    receipt = resume.validate_source(case.source, case.output, **case.kwargs)
    assert receipt['processRuntimeTurns'] == {}
    assert receipt['runtimeTurns'] == {'completed': 1, 'failed': 1}
    assert receipt['usedTurns'] == 2 and receipt['usedResponses'] == 2
    assert receipt['unknownMaximumReservedTokens'] == 524288 and receipt['pendingAckPreserved'] == 1
    assert receipt['priorReceipt'] == {'path': str(case.parent), 'sha256': resume._digest(case.parent)}
    target = tmp_path/'third-state'; target.mkdir()
    write(target/resume.MARKER, {**resume.read(case.source/resume.MARKER), 'state': 'prepared'})
    config = SimpleNamespace(data_dir=target, batch_id=resume.EXPERIMENT)
    restored = resume.restore_snapshot(case.source, config, receipt, process_alive=lambda _: False)
    assert resume.bootstrap_resumed(config, restored, process_alive=lambda _: False,
        bootstrap=lambda *args, **kw: kw) == {'seed': False}
    assert resume.inventory(target) == source_before == resume.inventory(case.source)
    assert resume.inventory(case.old.source) == old_before
    assert (case.output/'ledger.json').read_bytes() == ledger_before and case.parent.read_bytes() == parent_before


def test_second_resume_only_adds_new_process_terminal_turns(resumed_once):
    case = resumed_once
    case.old.ledger['turns'].append('turn-3'); write(case.output/'ledger.json', case.old.ledger)
    message = {'op': 'created', 'message': {'message_id': 'turn-3', 'turn_id': 'runtime-3',
        'role': 'user', 'metadata': {'request_id': 'turn-3'}}}
    with (case.source/'visible_transcript.jsonl').open('a', encoding='utf-8') as stream:
        stream.write('\n' + json.dumps(message))
    evidence = resume.read(case.kwargs['evidence_path']); evidence['runtime']['turns'] = {'cancelled': 1}; write(case.kwargs['evidence_path'], evidence)
    status = resume.read(case.kwargs['status_path']); status['budget']['turns'] = 3; write(case.kwargs['status_path'], status)
    receipt = resume.validate_source(case.source, case.output, **case.kwargs)
    assert receipt['runtimeTurns'] == {'completed': 1, 'failed': 1, 'cancelled': 1}
    assert receipt['processRuntimeTurns'] == {'cancelled': 1}


@pytest.mark.parametrize('field,value,error', [
    ('turnIds', ['turn-2', 'turn-1'], 'parent_turn_prefix'),
    ('runtimeTurns', {'completed': 2}, 'parent_terminal_counts'),
    ('restoredDirectory', 'unrelated-runtime', 'parent_binding'),
    ('seedSyntheticMemories', True, 'parent_binding'),
    ('priorReceipt', {'path': 'missing-parent', 'sha256': '0'*64}, 'parent'),
])
def test_second_resume_rejects_forged_parent_receipts(resumed_once, field, value, error):
    case = resumed_once
    data = resume.read(case.parent); data[field] = value; write(case.parent, data)
    with pytest.raises((ValueError, FileNotFoundError), match=error if field != 'priorReceipt' else None):
        resume.validate_source(case.source, case.output, **case.kwargs, prior_receipt_path=case.parent)


def test_second_resume_rejects_changed_original_evidence_or_visible_prefix(resumed_once):
    case = resumed_once
    original = case.old.kwargs['evidence_path']; before = original.read_bytes()
    data = resume.read(original); data['runtime']['turns'] = {'completed': 2}; write(original, data)
    with pytest.raises(ValueError, match='parent_proof_changed'):
        resume.validate_source(case.source, case.output, **case.kwargs)
    original.write_bytes(before)
    transcript = case.source/'visible_transcript.jsonl'
    transcript.write_text(transcript.read_text(encoding='utf-8').replace('failure-note', 'renamed-note'), encoding='utf-8')
    with pytest.raises(ValueError, match='parent_visible_prefix_changed'):
        resume.validate_source(case.source, case.output, **case.kwargs)


def test_second_resume_still_rejects_active_process_turn_and_missing_terminal(resumed_once):
    case = resumed_once
    data = resume.read(case.kwargs['evidence_path']); data['runtime']['turns'] = {'generating': 1}; write(case.kwargs['evidence_path'], data)
    with pytest.raises(ValueError, match='runtime_not_settled'):
        resume.validate_source(case.source, case.output, **case.kwargs)
    data['runtime']['turns'] = {}; write(case.kwargs['evidence_path'], data)
    case.old.ledger['responses'][-1]['terminalObserved'] = False; write(case.output/'ledger.json', case.old.ledger)
    with pytest.raises(ValueError, match='provider_terminal'):
        resume.validate_source(case.source, case.output, **case.kwargs)


def test_recursive_receipt_chain_is_verified_against_each_original_source(resumed_once, tmp_path):
    case = resumed_once
    receipt = resume.validate_source(case.source, case.output, **case.kwargs)
    target = tmp_path/'third-state'; target.mkdir()
    write(target/resume.MARKER, {**resume.read(case.source/resume.MARKER), 'state': 'prepared'})
    restored = resume.restore_snapshot(case.source, SimpleNamespace(data_dir=target, batch_id=resume.EXPERIMENT),
        receipt, process_alive=lambda _: False)
    parent = case.output/'resume-receipt-second.json'; write(parent, restored)
    write(target/resume.MARKER, {**resume.read(target/resume.MARKER), 'state': 'running'})
    state = case.output/'server-state-third.json'; write(state, {'pid': 9012, 'cloud': True})
    manifest = case.output/'source-manifest-third.json'
    write(manifest, {'experimental': True, 'dataDirectory': str(target), 'sourceHashes': {'backend.py': 'c'*64}})
    kwargs = {**case.kwargs, 'state_path': state, 'manifest_path': manifest}
    third = resume.validate_source(target, case.output, **kwargs)
    assert third['runtimeTurns'] == {'completed': 1, 'failed': 1} and third['usedTurns'] == 2
    # A real file with a matching hash is insufficient if its destination cannot
    # prove the previous runtime in this chain.
    impostor = case.output/'unrelated-proof.json'
    write(impostor, {**case.first, 'restoredDirectory': str(tmp_path/'unrelated-state')})
    forged = {**restored, 'priorReceipt': {'path': str(impostor), 'sha256': resume._digest(impostor)}}
    write(parent, forged)
    with pytest.raises(ValueError, match='parent_binding_mismatch'):
        resume.validate_source(target, case.output, **kwargs)


def test_parent_proof_change_after_validation_prevents_snapshot_copy(resumed_once, tmp_path):
    case = resumed_once
    receipt = resume.validate_source(case.source, case.output, **case.kwargs)
    target = tmp_path/'third-state'; target.mkdir()
    write(target/resume.MARKER, {**resume.read(case.source/resume.MARKER), 'state': 'prepared'})
    changed = resume.read(case.parent); changed['runtimeTurns'] = {'completed': 2}; write(case.parent, changed)
    with pytest.raises(ValueError, match='parent_chain_hash_mismatch'):
        resume.restore_snapshot(case.source, SimpleNamespace(data_dir=target, batch_id=resume.EXPERIMENT),
            receipt, process_alive=lambda _: False)
    assert set(p.name for p in target.iterdir()) == {resume.MARKER}


def append_transcript(source, *entries):
    with (source/'visible_transcript.jsonl').open('a', encoding='utf-8') as stream:
        for entry in entries:
            stream.write('\n' + json.dumps(entry))


def test_barge_and_unspoken_error_cancellation_preserve_history_without_ack(stopped):
    append_transcript(stopped.source,
        {'op': 'cancelled', 'delivery_id': 'd2', 'reason': 'character_runtime_error_not_spoken'},
        {'op': 'created', 'message': {'message_id': 'interrupted', 'turn_id': 'runtime-1',
            'role': 'assistant', 'delivery_id': 'd3', 'delivery_state': 'pending_ack'}},
        {'op': 'cancelled', 'delivery_id': 'd3', 'reason': 'confirmed_voice_barge_in'},
        {'op': 'created', 'message': {'message_id': 'still-pending', 'turn_id': 'runtime-2',
            'role': 'system', 'delivery_id': 'd4', 'delivery_state': 'pending_ack'}})
    evidence = resume.read(stopped.kwargs['evidence_path'])
    evidence['runtime']['deliveries'] = {'delivered': 1, 'cancelled': 2, 'pending_ack': 1}
    write(stopped.kwargs['evidence_path'], evidence)
    before = (stopped.source/'visible_transcript.jsonl').read_bytes()
    receipt = resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)
    restored = resume.restore_snapshot(stopped.source, stopped.config, receipt, process_alive=lambda _: False)
    assert restored['deliveriesPreserved'] == {'delivered': 1, 'cancelled': 2, 'pending_ack': 1}
    assert restored['pendingAckPreserved'] == 1 and restored['historyAcknowledgedByRecovery'] is False
    assert (stopped.target/'visible_transcript.jsonl').read_bytes() == before
    assert (stopped.source/'visible_transcript.jsonl').read_bytes() == before


@pytest.mark.parametrize('entries,error', [
    ([{'op': 'cancelled', 'delivery_id': 'missing', 'reason': 'confirmed_voice_barge_in'}], 'delivery_transition'),
    ([{'op': 'cancelled', 'delivery_id': 'd1', 'reason': 'confirmed_voice_barge_in'}], 'delivery_transition'),
    ([{'op': 'cancelled', 'delivery_id': 'd2', 'reason': 'confirmed_voice_barge_in'},
      {'op': 'acked', 'delivery_id': 'd2'}], 'delivery_transition'),
    ([{'op': 'cancelled', 'delivery_id': 'd2', 'reason': ''}], 'delivery_cancellation'),
    ([{'op': 'created', 'message': {'message_id': 'other', 'turn_id': 'runtime-1',
        'role': 'assistant', 'delivery_id': 'd2', 'delivery_state': 'pending_ack'}}], 'duplicate_visible_delivery'),
    ([{'op': 'created', 'message': {'message_id': 'unowned', 'turn_id': 'unowned-runtime',
        'role': 'assistant', 'delivery_id': 'd3', 'delivery_state': 'pending_ack'}},
      {'op': 'cancelled', 'delivery_id': 'd3', 'reason': 'confirmed_voice_barge_in'}], 'delivery_cancellation'),
])
def test_cancellation_needs_a_known_pending_delivery_and_owned_turn(stopped, entries, error):
    append_transcript(stopped.source, *entries)
    with pytest.raises(ValueError, match=error):
        resume.validate_source(stopped.source, stopped.output, **stopped.kwargs)
