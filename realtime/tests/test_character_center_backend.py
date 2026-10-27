"""Offline fake-provider checks for the character sidecar; no real WAI or keys."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from test_parallel_duplex_backend import Socket, USAGE, fake_main, turn

HERE = Path(__file__).resolve().parents[1] / "character-center"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


m = load("character_center_backend_test", HERE / "backend.py")
b = load("character_center_budget_test", HERE / "budget.py")
p, q = m.protocol, m.queue_module


def expression(**fields):
    return {"mode": "attitude", "kind": "concern", "strength": .6,
            "evidenceRef": "user:turn_1", **fields}


def actions(count=1):
    return {"operation": "append", "actions": [
        {"action": "gesture:wave", "anchor": "voice", "delay_ms": 0} for _ in range(count)]}


def events(commands, usage=USAGE):
    rows = [{"type": "response.created", "response": {"id": "plan_1"}}]
    for i, (name, command) in enumerate(commands):
        rows += [{"type": "response.output_item.added", "response_id": "plan_1", "item": {
            "type": "function_call", "id": f"item_{i}", "call_id": f"call_{i}", "name": name}},
            {"type": "response.function_call_arguments.done", "response_id": "plan_1",
             "item_id": f"item_{i}", "arguments": json.dumps(command)}]
    rows += [{"type": "response.done", "response": {"id": "plan_1", "status": "completed", "usage": usage}}]
    return rows


async def fixture(tmp_path, commands=(), *, usage=USAGE, notify=None):
    socket = Socket(events(commands, usage))
    seen = []
    async def factory():
        return socket
    async def send(event):
        seen.append(event)
        if notify:
            await notify(event)
    budget = b.CenterBudget(tmp_path / "budget.json")
    session = m.CharacterCenterSession(SimpleNamespace(), fake_main(), budget, tmp_path, send, factory=factory)
    session.schedule_planner_warm()
    session.schedule_planner_warm = lambda: None
    t = turn()
    session.turns[t["id"]] = t
    session.current_turn = t
    return session, budget, socket, seen, t


async def user_job(session, t):
    payload = await session._payload(t, [])
    payload.update(turn_id=t["id"], evidence_refs=["user:" + t["id"]], media_anchor={"kind": "immediate"})
    job = session._submit("user:" + t["id"], "user", 1, payload, turn=t, priority=2)
    await job.task
    return job


def test_protocol_has_two_independent_tools_and_complete_catalog():
    tools = p.tools()
    assert [row["function"]["name"] for row in tools] == ["set_expression", "perform_actions"]
    ids = tools[1]["function"]["parameters"]["properties"]["actions"]["items"]["properties"]["action"]["enum"]
    assert "native:thinking01" in ids and "activity:read_seated" in ids
    assert not any("stand2" in value.lower() for value in ids)
    assert len(p.parse_actions(json.dumps(actions(300)))["actions"]) == 300


@pytest.mark.parametrize("value", [
    expression(mode="attitude", kind="surprise"), expression(strength=True),
    expression(strength=float("nan")), expression(mathV=.4), expression(evidenceRef=""),
    expression(revision=9), expression(kind="invented"),
])
def test_expression_rejects_bad_types_and_model_owned_revisions(value):
    with pytest.raises(ValueError):
        p.parse_expression(json.dumps(value))


def test_duplicate_fields_are_not_silently_accepted():
    with pytest.raises(ValueError):
        p.parse_expression('{"mode":"clear","mode":"attitude","kind":"warm","strength":0.2,"evidenceRef":"x"}')


def test_tools_arrive_independently_before_receipts_and_usage_settles(tmp_path):
    async def run():
        session, budget, socket, seen, t = await fixture(tmp_path, [
            ("set_expression", expression()), ("perform_actions", actions(2))])
        await user_job(session, t)
        outputs = [e for e in seen if e["type"] in {"character_expression", "character_actions"}]
        assert [e["type"] for e in outputs] == ["character_expression", "character_actions"]
        assert len({e["requestId"] for e in outputs}) == 1
        assert len({e["commandId"] for e in outputs}) == 2
        assert outputs[0]["sourceScope"] == "user" and outputs[0]["mediaAnchor"] == {"kind": "immediate"}
        assert max(seen.index(e) for e in outputs) < next(i for i,e in enumerate(seen) if e["type"] == "character_semantic_done")
        assert sum(e["type"] == "response.create" for e in socket.sent) == 1
        assert budget.snapshot()["unknown"] == 0 and socket.closed
    asyncio.run(run())


def test_terminal_missing_usage_retains_reservation_without_freezing_action_channel(tmp_path):
    async def run():
        session, budget, _, _, t = await fixture(tmp_path, [("set_expression", expression())], usage=None)
        await user_job(session, t)
        assert budget.snapshot()["unknown"] == 1
        assert budget.available("action_planner") and not budget.data["blocked"]
    asyncio.run(run())


def test_fabricated_evidence_drops_only_that_tool_and_drains_usage(tmp_path):
    async def run():
        session, budget, _, seen, t = await fixture(tmp_path, [
            ("set_expression", expression(evidenceRef="invented")), ("perform_actions", actions())])
        await user_job(session, t)
        assert not any(e["type"] == "character_expression" for e in seen)
        assert any(e["type"] == "character_actions" for e in seen)
        assert budget.snapshot()["unknown"] == 0
    asyncio.run(run())


def test_revocation_suppresses_later_tool_without_losing_terminal(tmp_path):
    async def run():
        holder = {}
        async def notify(event):
            if event["type"] == "character_expression":
                holder["session"].semantic_queue.invalidate("user:turn_1", "test_correction")
        session, budget, _, seen, t = await fixture(tmp_path, [
            ("set_expression", expression()), ("perform_actions", actions())], notify=notify)
        holder["session"] = session
        await user_job(session, t)
        assert any(e["type"] == "character_expression" for e in seen)
        assert not any(e["type"] == "character_actions" for e in seen)
        assert budget.snapshot()["unknown"] == 0
    asyncio.run(run())


def test_correction_guard_prevents_context_transmission(tmp_path):
    async def run():
        session, budget, socket, seen, t = await fixture(tmp_path)
        t["guard"] = lambda: False
        await user_job(session, t)
        assert t["cancel"].is_set()
        assert not budget.data["responses"]
        assert not any(e["type"] == "conversation.item.create" for e in socket.sent)
        # An unclaimed prewarm has no generation; close it explicitly in fixture.
        if session.planner_warm_task:
            await session.planner_warm_task
            await session.planner_warm_connection.close()
    asyncio.run(run())


def test_math_updates_are_separate_from_semantic_and_body_generations(tmp_path):
    async def run():
        seen = []
        async def send(event): seen.append(event)
        main = fake_main()
        session = m.CharacterCenterSession(SimpleNamespace(), main, b.CenterBudget(tmp_path / "b.json"), tmp_path, send)
        await session.publish_math()
        await session.publish_math()
        main.state_bus.get_emotion_dict = lambda: {"V": -.4, "A": .4, "D": .5, "S": .1}
        await session.publish_math()
        assert [e["mathRevision"] for e in seen] == [1, 2]
        assert session.semantic_queue.revision == 0 and session.action_generation == 0
        assert all(e["type"] == "character_math" for e in seen)
    asyncio.run(run())


def test_partial_input_does_not_invoke_semantic_model(tmp_path):
    async def run():
        seen = []
        async def send(event): seen.append(event)
        session = m.CharacterCenterSession(SimpleNamespace(), fake_main(), b.CenterBudget(tmp_path / "b.json"), tmp_path, send)
        await session.emit("speech_started", itemId="input_1")
        await session.emit("input_partial", itemId="input_1", text="我以为", stash="出事")
        assert session.semantic_queue.revision == 0
        assert any(e["type"] == "character_attention" and e["semanticUnderstanding"] is False for e in seen)
    asyncio.run(run())


def test_assistant_received_text_is_always_held_to_its_actual_segment_end(tmp_path):
    async def run():
        session, budget, _, seen, t = await fixture(tmp_path, [
            ("set_expression", expression(evidenceRef="assistant:turn_1:0:8"))])
        anchor = {"kind": "segment_end", "turnId": t["id"], "segmentIndex": 0,
                  "providerConnectionId": "voice_conn", "responseId": "voice_1"}
        await session._plan_assistant(t["id"], "assistant:turn_1:0", "不过事情解决了。", anchor, True)
        job = session.semantic_queue.active
        await job.task
        event = next(e for e in seen if e["type"] == "character_expression")
        assert event["mediaAnchor"] == anchor
        assert event["sourceScope"] == "assistant"
        assert budget.snapshot()["unknown"] == 0
    asyncio.run(run())


def test_activity_can_plan_without_any_voice_turn_and_pause_revokes(tmp_path):
    async def run():
        session, budget, _, seen, _ = await fixture(tmp_path, [("perform_actions", {
            "operation": "append", "actions": [{"action": "native:stand01", "anchor": "immediate", "delay_ms": 0}]})])
        session.current_turn = None
        result = await session.plan_activity({"activityId": "reading_1", "sourceVersion": 1, "status": "running"})
        await session.semantic_queue.active.task
        assert result["queued"] and any(e["type"] == "character_actions" and e["activityId"] == "reading_1" for e in seen)
        await session.plan_activity({"id": "reading_1", "version": 1, "status": "paused"})
        assert any(e["type"] == "character_revoke" and e["sourceKey"] == "activity:reading_1" for e in seen)
        assert budget.data["responses"][0]["role"] == "activity_planner"
    asyncio.run(run())


def test_existing_voice_submission_and_input_admission_still_use_original_implementations():
    assert m.CharacterCenterSession.submit is m.base.DuplexSession.submit
    assert m.CharacterCenterSession.flush_fragments is m.base.ParallelDuplexSession.flush_fragments


def test_activity_voice_snapshot_is_frozen_and_rechecked_without_display_revision(tmp_path):
    async def run():
        session, _, socket, _, t = await fixture(tmp_path)
        capture = {"context": {"status": "paused", "artifactId": "note1", "summary": "NASA reading note"},
                   "sourceToken": {"sourceId": "source1", "revocationEpoch": 0, "artifactId": "note1"}}
        valid_calls, memory_calls = [], []
        async def provider(): return capture
        async def validate(token):
            valid_calls.append(dict(token))
            return token["revocationEpoch"] == 0
        session.activity_context_provider, session.activity_context_validator = provider, validate
        t["guard"] = lambda: memory_calls.append(True) or True
        original = [{"role": "user", "content": "What were you doing?"}]
        messages = await session._with_activity_context(t, original)
        assert len(original) == 1 and "NASA reading note" in messages[-1]["content"]
        capture["context"]["status"] = "running"
        capture["sourceToken"]["revocationEpoch"] = 99
        await session.check_direct_context(t, "stream_audio")
        await session.check_direct_context(t, "stream_subtitle")
        assert len(valid_calls) == 3 and len(memory_calls) == 2
        assert all(row["revocationEpoch"] == 0 for row in valid_calls)
        assert not t["cancel"].is_set() and t["activitySourceGuard"]["checks"] == 2
        payload = await session._payload(t, messages)
        assert payload["background_activity"]["context"]["status"] == "paused"
        await session.planner_warm_task
        await socket.close()
    asyncio.run(run())


def test_activity_source_revocation_rejects_final_ack_before_history(tmp_path, monkeypatch):
    async def run():
        session, _, socket, seen, t = await fixture(tmp_path)
        current, acknowledgements = {"valid": True}, []
        async def provider():
            return {"context": {"status": "paused"}, "sourceToken": {"sourceId": "source1", "epoch": 0}}
        async def validate(token): return current["valid"]
        async def inherited_ack(self, command):
            acknowledgements.append(command)
            return True
        monkeypatch.setattr(m.base.DuplexSession, "acknowledge", inherited_ack)
        session.activity_context_provider, session.activity_context_validator = provider, validate
        await session._with_activity_context(t, [])
        command = {"turnId": t["id"]}
        assert await session.acknowledge(command) is True
        assert acknowledgements == [command]  # Original receipt/history path still owns valid ACKs.
        current["valid"] = False
        assert await session.acknowledge(command) is False
        assert acknowledgements == [command] and t["cancel"].is_set()
        assert any(e["type"] == "revoked" and e["reason"] == "activity_voice_source_revoked" for e in seen)
        assert any(e["type"] == "ack_rejected" for e in seen)
        await session.planner_warm_task
        await socket.close()
        await session.flush_persistence()
    asyncio.run(run())


@pytest.mark.parametrize("failure", [RuntimeError, ValueError])
def test_activity_context_does_not_wait_for_action_planner_and_unknown_is_explicit(tmp_path, monkeypatch, failure):
    async def run():
        session, _, socket, seen, t = await fixture(tmp_path)
        voice_messages, planner_wait = [], asyncio.Event()
        async def failed_provider(): raise failure("private_provider_detail")
        async def blocked_planner(*args): await planner_wait.wait()
        async def inherited_reply(self, turn, messages, chunks, **kwargs):
            voice_messages.extend(messages)
            return "voice_returned"
        session.activity_context_provider = failed_provider
        session._plan_user = blocked_planner
        monkeypatch.setattr(m.base.DuplexSession, "reply", inherited_reply)
        result = await asyncio.wait_for(session.reply(t, [{"role": "user", "content": "Progress?"}], None), .5)
        assert result == "voice_returned" and not planner_wait.is_set()
        assert '"availability": "unknown"' in voice_messages[-1]["content"]
        assert "private_provider_detail" not in json.dumps(voice_messages + seen)
        assert t["id"] not in session._activity_voice_tokens
        assert any(e["type"] == "character_voice_activity_context" and e["status"] == "unavailable" for e in seen)
        planner_wait.set()
        await session.planner_warm_task
        await socket.close()
    asyncio.run(run())


def test_multiple_complete_face_and_body_calls_are_not_gated_by_first_tool(tmp_path):
    async def run():
        commands = [("perform_actions", actions(4)), ("set_expression", expression()),
                    ("set_expression", expression(mode="reaction", kind="surprise")),
                    ("perform_actions", actions(3))]
        session, budget, _, seen, t = await fixture(tmp_path, commands)
        await user_job(session, t)
        outputs = [e for e in seen if e["type"] in {"character_expression", "character_actions"}]
        assert [e["type"] for e in outputs] == ["character_actions", "character_expression", "character_expression", "character_actions"]
        assert len({e["commandId"] for e in outputs}) == 4
        assert budget.snapshot()["responses"] == 1
    asyncio.run(run())


def test_subtitle_tokens_do_not_each_launch_a_semantic_request(tmp_path):
    async def run():
        seen, planned = [], []
        async def send(event): seen.append(event)
        session = m.CharacterCenterSession(SimpleNamespace(), fake_main(), b.CenterBudget(tmp_path / "b.json"), tmp_path, send)
        async def capture(*args): planned.append(args)
        session._plan_assistant = capture
        for delta in ["这", "是", "第", "一", "句", "。"]:
            await session.emit("subtitle", turnId="turn_1", segmentIndex=0,
                responseId="r", providerConnectionId="p", delta=delta)
            await asyncio.sleep(0)
        assert len(planned) == 1 and planned[0][2] == "这是第一句。"
        assert planned[0][3]["kind"] == "audio_frame"
        assert planned[0][3]["frame"] == 0
        assert planned[0][3]["alignment"] == "received_pcm_frontier_not_word_aligned"
        await session.emit("response_done", turnId="turn_1", segmentIndex=0, result={
            "responseId": "r", "connectionId": "p", "transcript": "这是第一句。", "status": "completed"})
        await asyncio.sleep(0)
        assert len(planned) == 1
    asyncio.run(run())


def test_listener_channel_limit_preserves_final_input_admission(tmp_path):
    async def run():
        seen = []
        async def send(event): seen.append(event)
        budget = b.CenterBudget(tmp_path / "b.json", limits={"listener": 1, "voice": 2, "action": 2, "background": 2})
        row = budget.reserve("listener", "l", "input_1")
        budget.created(row, "r")
        budget.settle(row, {"id": "r", "status": "completed", "usage": USAGE})
        session = m.CharacterCenterSession(SimpleNamespace(), fake_main(), budget, tmp_path, send)
        session.accept_input = True
        await session.prepare_next()
        assert not session.accept_input and session.input_exhausted
        assert any(e["type"] == "input_exhausted" for e in seen)
        assert not any(e["type"] == "input_limit" for e in seen)
        assert budget.available("direct_reply")
    asyncio.run(run())


def test_plain_append_coalesces_without_cancelling_current_work():
    async def run():
        gate = asyncio.Event()
        started = []
        async def execute(job):
            started.append(job)
            await gate.wait()
        queue = q.SemanticQueue(execute)
        a = queue.submit("reply", "assistant", 1, {"text": "一"})
        await asyncio.sleep(0)
        queue.submit("reply", "assistant", 2, {"text": "一二"})
        c = queue.submit("reply", "assistant", 3, {"text": "一二三"})
        assert queue.active is a and queue.pending is c and not a.cancel_requested.is_set()
        assert queue.valid(a)
        gate.set()
        await a.task
        await c.task
        assert [job.payload["text"] for job in started] == ["一", "一二三"]
    asyncio.run(run())


def test_foreground_preempts_background_with_one_drain_and_no_third_provider():
    async def run():
        gates, started = {}, []
        async def execute(job):
            started.append(job)
            gates[job.request_id] = asyncio.Event()
            await gates[job.request_id].wait()
        queue = q.SemanticQueue(execute)
        back = queue.submit("activity:a", "activity", 1, {}, priority=0)
        await asyncio.sleep(0)
        first = queue.submit("user:1", "user", 1, {}, priority=2, replace=True)
        await asyncio.sleep(0)
        second = queue.submit("user:2", "user", 1, {}, priority=2, replace=True)
        await asyncio.sleep(0)
        assert len(started) == 2 and queue.draining is back and queue.active is first
        assert back.cancel_requested.is_set() and not first.cancel_requested.is_set()
        assert not queue.valid(first) and not queue.valid(back)
        gates[back.request_id].set()
        await back.task
        await asyncio.sleep(0)
        assert queue.active is second and queue.draining is first and first.cancel_requested.is_set()
        gates[first.request_id].set()
        gates[second.request_id].set()
        await asyncio.gather(first.task, second.task)
    asyncio.run(run())


def test_slow_audit_fsync_does_not_hold_response_future_and_close_flushes(tmp_path, monkeypatch):
    async def run():
        gate, started = asyncio.Event(), asyncio.Event()
        writes = []
        async def slow_persist(session):
            started.set()
            await gate.wait()
            writes.append(True)
        monkeypatch.setattr(m.base.DuplexSession, "persist", slow_persist)
        async def send(event): pass
        session = m.CharacterCenterSession(SimpleNamespace(), fake_main(), b.CenterBudget(tmp_path / "b.json"), tmp_path, send)
        # The original stream consumer waits for reply future.result(timeout=2)
        # after its sentinel. Audit persistence now returns without that fsync.
        await asyncio.wait_for(session.persist(), .1)
        await asyncio.wait_for(started.wait(), 1)
        for _ in range(10):
            await session.persist()
        flush = asyncio.create_task(session.flush_persistence())
        await asyncio.sleep(0)
        assert not flush.done() and not writes
        gate.set()
        await flush
        assert len(writes) == 2  # one in-flight snapshot plus one coalesced tail
    asyncio.run(run())


def test_runtime_failure_with_pre_set_cancel_still_notifies_once_and_cancels_error_delivery(tmp_path):
    async def run():
        seen, cancelled = [], []
        async def send(event): seen.append(event)
        runtime = SimpleNamespace(cancel_delivery=lambda delivery, reason: cancelled.append((delivery, reason)) or True)
        session = m.CharacterCenterSession(runtime, fake_main(), b.CenterBudget(tmp_path / "b.json"), tmp_path, send)
        t = turn();t["runtimeId"] = "runtime_1";t["cancel"].set()
        session.turns[t["id"]] = t;session.current_turn = t
        error = SimpleNamespace(event_type="message.created", payload={"message": {
            "role": "system", "source": "runtime_error", "turn_id": "runtime_1", "delivery_id": "error_delivery"}})
        await session.runtime_event(error)
        failed = SimpleNamespace(event_type="turn.failed", payload={"turn_id": "runtime_1"})
        await session.runtime_event(failed)
        await session.runtime_event(failed)
        assert len([e for e in seen if e["type"] == "revoked"]) == 1
        assert len([e for e in seen if e["type"] == "turn_error"]) == 1
        assert cancelled == [("error_delivery", "character_runtime_error_not_spoken")]
        assert not t["acknowledged"]
        session.character_closing = True
        await session.flush_persistence()
    asyncio.run(run())


def test_math_polls_energy_once_per_second_and_keeps_actor_out_of_events(tmp_path):
    async def run():
        seen, energy_calls = [], []
        async def send(event): seen.append(event)
        main = fake_main()
        main.heartbeat_engine.v2.runtime_soul = lambda state, now: energy_calls.append(now) or {"energy": .6}
        session = m.CharacterCenterSession(SimpleNamespace(), main, b.CenterBudget(tmp_path / "b.json"), tmp_path, send)
        session.actor = {"posture": "standing", "huge_bone_evidence": [1] * 1000}
        for i in range(10):
            main.state_bus.get_emotion_dict = lambda i=i: {"V": i/20, "A": .4}
            await session.publish_math()
        assert len(energy_calls) == 1 and len(seen) == 10
        assert all("actorState" not in row["state"] for row in seen)
        assert all(row["state"]["energyCapturedAt"] and not row["state"]["energyStale"] for row in seen)
        session._energy_captured_at -= 6000
        main.heartbeat_engine.v2.runtime_soul = lambda *_: (_ for _ in ()).throw(RuntimeError("unavailable"))
        session._energy_attempt_at = -float("inf")
        await session.publish_math()
        assert seen[-1]["state"]["effectiveEnergy"] is None and seen[-1]["state"]["energyStale"]
    asyncio.run(run())


def test_idle_listener_close_does_not_revoke_voice_and_explicit_resume_counts_new_slot(tmp_path):
    async def run():
        seen = []
        async def send(event): seen.append(event)
        socket = Socket()
        async def factory(): return socket
        budget = b.CenterBudget(tmp_path / "b.json")
        session = m.CharacterCenterSession(SimpleNamespace(), fake_main(), budget, tmp_path, send, factory=factory)
        class Closed:
            id = "idle_old"
            async def receive(self, timeout): raise m.base.ProtocolError("provider_connection_closed")
            async def close(self): pass
        session.listener = Closed()
        session.prepared = budget.reserve("listener", "idle_old", "next_input")
        session.accept_input = True
        session.input_sequence = 17
        await session.read_listener()
        assert session.listener_idle_closed and session.prepared is None
        assert budget.data["responses"][0]["state"] == "unused"
        assert not any(e["type"] in {"blocked", "revoked"} for e in seen)
        result = await session.resume_listener()
        assert result["ready"] and session.input_sequence == 17
        assert session.prepared["state"] == "reserved" and session.prepared["role"] == "listener"
        assert not any(e["type"] in {"input_audio_buffer.append", "response.create"} for e in socket.sent)
        reused = await session.resume_listener()
        assert reused["reused"] and session.listener_reconnect_attempts == 1
        session.reader.cancel();await asyncio.gather(session.reader, return_exceptions=True)
        await session.listener.close()
        session.character_closing = True
        await session.flush_persistence()
    asyncio.run(run())


def test_listener_cannot_resume_while_previous_response_terminal_is_unknown(tmp_path):
    async def run():
        seen = []
        async def send(event): seen.append(event)
        runtime = SimpleNamespace()
        budget = b.CenterBudget(tmp_path / "b.json")
        session = m.CharacterCenterSession(runtime, fake_main(), budget, tmp_path, send)
        class Closed:
            id = "active_old"
            async def receive(self, timeout): raise m.base.ProtocolError("provider_connection_closed")
        row = budget.reserve("listener", "active_old", "input_1")
        budget.created(row, "active_response")
        session.listener = Closed()
        session.listener_response = {"reservation": row}
        await session.read_listener()
        assert not session.listener_idle_closed and not budget.available("listener")
        result = await session.resume_listener()
        assert result["ready"] is False and session.listener_reconnect_attempts == 0
        assert row["state"] == "unknown"
        session.character_closing = True
        await session.flush_persistence()
    asyncio.run(run())


@pytest.mark.parametrize("age,claimed,replaced", [(59, False, False), (61, False, True), (184, True, False)])
def test_only_expired_unclaimed_voice_prewarm_is_replaced_without_generation(tmp_path, age, claimed, replaced):
    async def run():
        sockets, observed = [], []
        async def factory():
            socket = Socket()
            sockets.append(socket)
            return socket
        async def send(event): observed.append(event)
        budget = b.CenterBudget(tmp_path / "ttl-ledger.json")
        session = m.CharacterCenterSession(SimpleNamespace(), fake_main(), budget, tmp_path, send,
                                          factory=factory, prewarm_policy="after_request")
        session.schedule_warm()
        old = await session.warm_task
        assert hasattr(old, "_character_warm_ready_at")
        old._character_warm_ready_at -= age
        old.claimed = claimed
        selected = await session.take_reply_connection(turn())
        assert (selected is not old) is replaced
        assert sockets[0].closed is replaced
        assert len(sockets) == (2 if replaced else 1)
        assert not budget.data["responses"]
        assert all(e["type"] != "response.create" for socket in sockets for e in socket.sent)
        expired = [e for e in observed if e["type"] == "prewarm_expired"]
        assert bool(expired) is replaced
        if replaced:
            assert expired[0]["ttlSeconds"] == 60 and expired[0]["responseRequested"] is False
            assert expired[0]["warmAgeMs"] >= 61000
            assert selected._character_warm_ready_at > old._character_warm_ready_at
        # A mistakenly supplied claimed connection remains an error for the
        # original generation guard; TTL must never replay its response.
        if claimed:
            assert selected.claimed
        await selected.close()
    asyncio.run(run())
