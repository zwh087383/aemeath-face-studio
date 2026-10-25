"""Isolated fake-provider regressions; no credentials or network are loaded."""
import asyncio
from array import array
import base64
import importlib.util
import json
from pathlib import Path
import queue
import sys
import threading
from types import SimpleNamespace

import pytest

FACE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(FACE.parents[1] / "WAI"))
spec = importlib.util.spec_from_file_location("parallel_backend_test", FACE / "realtime/parallel-duplex/backend.py")
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

USAGE = {"input_tokens": 12, "output_tokens": 3, "total_tokens": 15}


class Socket:
    def __init__(self, events=(), *, on_cancel=(), configure_gate=None):
        self.events = asyncio.Queue()
        self.events.put_nowait({"type": "session.created"})
        self.generated = list(events)
        self.cancelled = list(on_cancel)
        self.sent = []
        self.closed = False
        self.configure_gate = configure_gate

    async def send_json(self, event):
        self.sent.append(event)
        if event["type"] == "session.update":
            if self.configure_gate:
                await self.configure_gate.wait()
            self.events.put_nowait({"type": "session.updated", "session": {"model": b.MODEL, **event["session"]}})
        elif event["type"] == "conversation.item.create" and "id" in event["item"]:
            self.events.put_nowait({"type": "conversation.item.created", "item": event["item"]})
        elif event["type"] == "response.create":
            for value in self.generated:
                self.events.put_nowait(value)
        elif event["type"] == "response.cancel":
            for value in self.cancelled:
                self.events.put_nowait(value)

    async def receive(self):
        return await self.events.get()

    async def close(self):
        self.closed = True


def plan_events(intent="greet", usage=USAGE, arguments=None):
    raw = arguments or json.dumps({"intent": intent})
    return [{"type": "response.created", "response": {"id": "planner_1"}},
        {"type": "response.output_item.added", "response_id": "planner_1", "item": {
            "type": "function_call", "id": "item_1", "name": "propose_action", "call_id": "call_1"}},
        {"type": "response.function_call_arguments.delta", "response_id": "planner_1", "delta": raw},
        {"type": "response.function_call_arguments.done", "response_id": "planner_1",
         "name": "propose_action", "call_id": "call_1", "arguments": raw},
        {"type": "response.done", "response": {"id": "planner_1", "status": "completed", "usage": usage}}]


def fake_main():
    return SimpleNamespace(state_bus=SimpleNamespace(get_emotion_dict=lambda: {"V": .2, "A": .4, "D": .5, "S": .1},
        get_relation_dict=lambda: {"L": .6, "T": .7}),
        soul_mgr=SimpleNamespace(get_snapshot=lambda: {"energy": .1}),
        heartbeat_engine=SimpleNamespace(v2=SimpleNamespace(runtime_soul=lambda state, now: {**state, "energy": .55})))


def turn():
    return {"id": "turn_1", "text": "请挥挥手打个招呼。", "cancel": threading.Event(),
            "acknowledged": False, "runtimeId": None, "deliveryId": None, "segments": []}


async def fixture(tmp_path, socket, *, voice_requested=True, notify=None):
    budget = b.ParallelBudget(tmp_path / "ledger.json")
    observed = []
    async def send(row):
        observed.append(row)
        if notify:
            await notify(row)
    async def factory():
        return socket
    session = b.ParallelDuplexSession(SimpleNamespace(), fake_main(), budget, tmp_path, send, factory=factory)
    session.accept_input = True
    session.schedule_planner_warm()
    entry = {"generation": 1, "voice_requested": asyncio.Event(), "cancel": threading.Event(),
             "task": None, "connection": None, "reservation": None}
    if voice_requested:
        entry["voice_requested"].set()
    # Prevent a second spare from reusing the same fake socket. Initial spare
    # still follows the actual production prewarm implementation.
    session.schedule_planner_warm = lambda: None
    return session, budget, entry, observed


@pytest.mark.parametrize("raw", ['{"intent":"greet","future":"x"}', '{"intent":"greet","intent":"none"}',
    '{"intent":"wave"}', '["greet"]', '{"intent":', '{"intent":null}'])
def test_strict_one_field_no_future_no_partial(raw):
    with pytest.raises((ValueError, TypeError)):
        b.strict_intent(raw)


def test_new_budget_cap_and_old_budget_unchanged(tmp_path):
    budget = b.ParallelBudget(tmp_path / "ledger.json")
    assert budget.snapshot()["responseLimit"] == 24
    with pytest.raises(ValueError):
        b.DurableBudget(tmp_path / "old.json", max_responses=24)
    with pytest.raises(ValueError):
        b.ParallelBudget(tmp_path / "too-many.json", max_responses=25)
    row = budget.reserve("action_planner", "conn", "turn")
    budget.created(row, "r")
    reopened = b.ParallelBudget(tmp_path / "ledger.json")
    assert reopened.snapshot()["unknown"] == 1 and reopened.data["blocked"]


def test_optional_plan_keeps_full_voice_slot(tmp_path):
    budget = b.ParallelBudget(tmp_path / "ledger.json", max_responses=3)
    budget.reserve("listener", "l", "t")
    budget.reserve("direct_reply", "v", "t")
    assert budget.reserve_optional_planner("p", "t") is None
    assert not budget.data["blocked"]


def test_voice_configuration_has_no_avatar_and_preserves_handoff():
    async def run():
        socket = Socket()
        async def factory(): return socket
        connection = b.VoiceConnection(factory=factory)
        await connection.open(instructions="真实检索上下文", allow_handoff=True)
        settings = next(x["session"] for x in socket.sent if x["type"] == "session.update")
        assert [t["function"]["name"] for t in settings["tools"]] == ["request_full_reply"]
        assert "真实检索上下文" in settings["instructions"]
        assert not any(x["type"] == "response.create" for x in socket.sent)
        await connection.close()
    asyncio.run(run())


def test_math_relation_and_effective_energy_not_legacy_energy():
    result = b.character_snapshot(fake_main(), 2, {"posture": "standing", "hands": "free", "activity": "none"})
    assert result["emotion"]["L"] == .6 and result["emotion"]["T"] == .7
    assert result["effectiveEnergy"] == .55 and result["emotion"]["source"] == "wai_math"


def test_context_captured_before_generation_contains_no_future_line():
    messages = [{"role": "system", "content": "检索：喜欢无糖柠檬水"},
                {"role": "assistant", "content": "上轮已送达"}, {"role": "user", "content": "你记得吗"}]
    payload = b.planner_payload(turn(), messages, {"effectiveEnergy": .4})
    assert payload["future_reply_available"] is False
    assert "target_line" not in payload and "approved_reply" not in payload
    assert payload["delivered_context"][0]["content"] == "上轮已送达"
    assert "无糖柠檬水" in payload["retrieved_context_excerpt"]
    digest = b.digest(payload)
    messages.append({"role": "assistant", "content": "后生成的完整回答"})
    assert b.digest(payload) == digest and "后生成" not in json.dumps(payload, ensure_ascii=False)


def test_complete_plan_uses_own_ids_only_done_executes_and_no_continuation(tmp_path):
    async def run():
        socket = Socket(plan_events())
        session, budget, entry, seen = await fixture(tmp_path, socket)
        await session.run_planner(turn(), [{"role": "user", "content": "hi"}], entry)
        kinds = [r["type"] for r in seen]
        assert kinds.index("planner_first_complete_json") < kinds.index("action_plan") < kinds.index("planner_done")
        action = next(r for r in seen if r["type"] == "action_plan")
        assert action["plannerResponseId"] == "planner_1" and action["turnId"] == "turn_1"
        assert action["sourceRole"] == "planner" and "responseId" not in action
        assert sum(x["type"] == "response.create" for x in socket.sent) == 1
        assert kinds.index("planner_receipt_send") > kinds.index("planner_done")
        assert budget.snapshot()["unknown"] == 0 and socket.closed
    asyncio.run(run())


def test_invalid_plan_does_not_drop_terminal_usage(tmp_path):
    async def run():
        socket = Socket(plan_events(arguments='{"intent":"greet","expression":"happy"}'))
        session, budget, entry, seen = await fixture(tmp_path, socket)
        await session.run_planner(turn(), [], entry)
        assert not any(r["type"] == "action_plan" for r in seen)
        assert any(r["type"] == "planner_plan_rejected" for r in seen)
        assert budget.snapshot()["unknown"] == 0 and not budget.data["blocked"]
    asyncio.run(run())


def test_error_cancels_and_drains_instead_of_manufacturing_unknown(tmp_path):
    async def run():
        values = plan_events()
        socket = Socket([values[0], {"type": "response.audio.delta", "response_id": "planner_1", "delta": "AA=="}],
            on_cancel=[{"type": "response.done", "response": {"id": "planner_1", "status": "cancelled", "usage": USAGE}}])
        session, budget, entry, seen = await fixture(tmp_path, socket)
        await session.run_planner(turn(), [], entry)
        assert any(x["type"] == "response.cancel" for x in socket.sent)
        assert budget.snapshot()["unknown"] == 0 and not budget.data["blocked"]
        assert next(r for r in seen if r["type"] == "planner_done")["afterError"]
    asyncio.run(run())


def test_unknown_usage_blocks_new_calls_and_never_fakes_zero(tmp_path):
    async def run():
        socket = Socket(plan_events(usage=None))
        session, budget, entry, seen = await fixture(tmp_path, socket)
        await session.run_planner(turn(), [], entry)
        assert budget.data["blocked"] and budget.snapshot()["unknown"] == 1
        assert not session.accept_input
        with pytest.raises(b.ProtocolError):
            await budget.acall("reserve", "reply", "new", "new")
    asyncio.run(run())


def test_cancel_prevents_late_plan_but_drains_accounting(tmp_path):
    async def run():
        current = turn()
        async def notify(row):
            if row["type"] == "planner_first_argument_delta":
                current["cancel"].set()
        socket = Socket(plan_events())
        session, budget, entry, seen = await fixture(tmp_path, socket, notify=notify)
        await session.run_planner(current, [], entry)
        assert not any(r["type"] == "action_plan" for r in seen)
        assert any(x["type"] == "response.cancel" for x in socket.sent)
        assert budget.snapshot()["unknown"] == 0
    asyncio.run(run())


def test_planner_waits_for_voice_send_without_voice_waiting_for_planner(tmp_path, monkeypatch):
    async def run():
        gate = asyncio.Event()
        socket = Socket(plan_events(), configure_gate=gate)
        budget = b.ParallelBudget(tmp_path / "ledger.json")
        observed = []
        async def send(row): observed.append(row)
        async def factory(): return socket
        session = b.ParallelDuplexSession(SimpleNamespace(), fake_main(), budget, tmp_path, send, factory=factory)
        session.schedule_planner_warm()
        session.schedule_planner_warm = lambda: None
        async def voice_reply(self, current, messages, chunks, **options):
            await self.emit("request_sent", turnId=current["id"], providerConnectionId="voice_only")
            await self.emit("turn_output_done", turnId=current["id"], result={"status": "completed"})
            return "voice_finished"
        monkeypatch.setattr(b.DuplexSession, "reply", voice_reply)
        current = turn()
        result = await asyncio.wait_for(session.reply(current, [], queue.Queue(), phase="direct"), .3)
        assert result == "voice_finished" and not gate.is_set()
        assert not any(x["type"] == "response.create" for x in socket.sent)
        gate.set()
        await session.planners[current["id"]]["task"]
        assert any(r["type"] == "action_plan" for r in observed)
        assert [r["type"] for r in observed].index("turn_output_done") < [r["type"] for r in observed].index("planner_done")
        count = len([x for x in socket.sent if x["type"] == "response.create"])
        await session.reply(current, [{"role": "assistant", "content": "当前语音已生成的首段"}], queue.Queue(), phase="full")
        assert len([x for x in socket.sent if x["type"] == "response.create"]) == count
    asyncio.run(run())


def test_no_generation_before_voice_request(tmp_path):
    async def run():
        socket = Socket(plan_events())
        session, budget, entry, seen = await fixture(tmp_path, socket, voice_requested=False)
        task = asyncio.create_task(session.run_planner(turn(), [], entry))
        await asyncio.sleep(.05)
        assert not any(x["type"] == "response.create" for x in socket.sent)
        assert not budget.data["responses"]
        entry["voice_requested"].set()
        await task
        assert budget.snapshot()["responses"] == 1
    asyncio.run(run())


def test_revoked_memory_context_is_not_sent_to_planner(tmp_path):
    async def run():
        socket = Socket(plan_events())
        session, budget, entry, seen = await fixture(tmp_path, socket)
        current = turn()
        current["guard"] = lambda: False
        session.turns[current["id"]] = current
        session.current_turn = current
        await session.run_planner(current, [{"role": "system", "content": "已撤销的记忆"}], entry)
        assert current["cancel"].is_set()
        assert not any(x["type"] == "conversation.item.create" for x in socket.sent)
        assert not any(x["type"] == "response.create" for x in socket.sent)
        assert not budget.data["responses"]
    asyncio.run(run())


def test_legacy_visual_tool_cannot_bypass_director_and_ack_methods_inherited(tmp_path):
    async def run():
        socket = Socket()
        session, _, entry, seen = await fixture(tmp_path, socket)
        await session.emit("tool", turnId="t", name="perform_avatar", arguments='{"gesture":"wave"}')
        assert seen[-1]["type"] == "voice_visual_tool_ignored"
        assert b.ParallelDuplexSession.acknowledge is b.DuplexSession.acknowledge
        # The experiment adds pending-input cleanup; active-turn cancellation
        # is still delegated unchanged to the inherited implementation.
        current = turn()
        session.turns[current["id"]] = current
        session.current_turn = current
        assert await session.cancel("confirmed_voice_barge_in")
        assert current["cancel"].is_set()
        assert any(row["type"] == "revoked" for row in seen)
        await session.actor_state({"actorState": {"posture": "unknown", "hands": "unknown", "activity": "unknown"}})
        with pytest.raises(b.ProtocolError):
            await session.actor_state({"posture": "sitting", "hands": "book", "activity": "reading"})
        warm = await session.planner_warm_task
        await warm.close()
    asyncio.run(run())


async def input_fixture(tmp_path):
    budget = b.ParallelBudget(tmp_path / "input-ledger.json")
    seen, submitted = [], []
    async def send(event): seen.append(event)
    session = b.ParallelDuplexSession(SimpleNamespace(), fake_main(), budget, tmp_path, send)
    session.accept_input = True
    async def listener_send(event): pass
    session.listener.send = listener_send
    async def submit(text, *, item_id=None): submitted.append((text, item_id))
    session.submit = submit
    return session, seen, submitted


async def pcm(session, ms, amplitude=0):
    # Exercise the real input override without a provider or future fixture.
    remaining = round(ms * 16)
    while remaining:
        count = min(1600, remaining)
        raw = array("h", [amplitude] * count).tobytes()
        await session.input({"sequence": session.input_sequence,
                             "pcm": base64.b64encode(raw).decode()})
        await asyncio.sleep(0)
        remaining -= count


def pending_input(session, identity):
    if session.fragment_timer:
        session.fragment_timer.cancel()
        session.fragment_timer = None
    value = {"id": identity, "valid": None, "done": False, "transcript": None, "dispatched": False}
    session.items[identity] = value
    session.current_item = value
    return value


async def final_input(session, item, text):
    item.update(valid=True, done=True, transcript=text)
    session.latest_valid = item["id"]
    await session.maybe_dispatch(item)


def test_pcm_gate_joins_observed_smart_turn_fragments_before_any_wai_admission(tmp_path):
    async def run():
        session, seen, submitted = await input_fixture(tmp_path)
        first = pending_input(session, "a")
        await pcm(session, 100, 2000)
        await final_input(session, first, "我纠正一下，我。")
        assert session.fragment_timer and not submitted  # original dangling rule
        second = pending_input(session, "b")
        await pcm(session, 100, 2000)
        await pcm(session, 100)
        await final_input(session, second, "现在最喜欢的是无糖乌龙茶")
        assert not submitted and session._tail_wait_started is not None
        await pcm(session, 360)  # The observed 460-ms internal gap is not enough.
        assert not submitted
        third = pending_input(session, "c")
        await pcm(session, 100, 2000)
        await pcm(session, 700)
        assert not submitted  # even enough silence cannot outrun pending ASR/usage
        await final_input(session, third, "不是无糖柠檬水，请记住。")
        assert submitted == [("我纠正一下，我。\n现在最喜欢的是无糖乌龙茶\n不是无糖柠檬水，请记住。", "c")]
        assert not session.fragments
        assert [row["type"] for row in seen].count("input_tail_deferred") == 1
        released = next(row for row in seen if row["type"] == "input_tail_released")
        assert released["actualTailMs"] == 700 and released["addedWaitMs"] >= 0
        assert budget_count(session) == 0
    asyncio.run(run())


def budget_count(session):
    return session.budget.snapshot()["responses"]


@pytest.mark.parametrize("text", ["你记得我喜欢什么吗？", "好", "是", "嗯"])
def test_pcm_gate_adds_no_debounce_when_cloud_final_already_late(tmp_path, text):
    async def run():
        session, seen, submitted = await input_fixture(tmp_path)
        item = pending_input(session, "a")
        await pcm(session, 20, 2000)
        await pcm(session, 800)
        await final_input(session, item, text)
        assert submitted == [(text, "a")]
        assert not any(row["type"].startswith("input_tail_") for row in seen)
    asyncio.run(run())


def test_pcm_gate_does_not_treat_stream_dropout_or_continuing_voice_as_silence(tmp_path):
    async def run():
        session, _, submitted = await input_fixture(tmp_path)
        item = pending_input(session, "a")
        await pcm(session, 100, 2000)
        await final_input(session, item, "还没说完")
        # Wall-clock waiting is not evidence of silence.
        session._tail_wait_started -= 60
        await session.flush_fragments()
        await pcm(session, 2000, 2000)
        assert not submitted and session.input_tail_status()[0] == 0
        await pcm(session, 650)
        await asyncio.sleep(0)
        assert submitted == [("还没说完", "a")]
    asyncio.run(run())


@pytest.mark.parametrize("operation", ["cancel", "close"])
def test_pending_pcm_gate_and_fragment_timer_cannot_revive_after_cancel_or_close(tmp_path, monkeypatch, operation):
    async def run():
        session, _, submitted = await input_fixture(tmp_path)
        item = pending_input(session, "a")
        await pcm(session, 100, 2000)
        await final_input(session, item, "等我说完")
        session.arm_fragment_flush()
        timer = session.fragment_timer
        if operation == "close":
            async def base_close(self): self.stopping = True
            monkeypatch.setattr(b.DuplexSession, "close", base_close)
            await session.close()
        else:
            await session.cancel("explicit_user_interrupt")
        await asyncio.sleep(0)
        assert timer.cancelled() and not session.fragments
        assert session._tail_wait_started is None
        session.observe_input_pcm(array("h", [0] * 16000).tobytes())
        await session.flush_fragments()
        assert not submitted
    asyncio.run(run())


def test_new_speech_during_gate_release_is_rechecked_before_admission(tmp_path):
    async def run():
        session, _, submitted = await input_fixture(tmp_path)
        item = pending_input(session, "a")
        await pcm(session, 100, 2000)
        await final_input(session, item, "请听我说")
        original_send = session.send_browser
        async def send(row):
            await original_send(row)
            if row["type"] == "input_tail_released":
                pending_input(session, "b")
        session.send_browser = send
        await pcm(session, 700)
        assert not submitted
        assert session.input_tail_status()[1]
    asyncio.run(run())


@pytest.mark.parametrize("tail,admitted", [(800, True), (100, False)])
def test_final_reserved_reply_is_not_lost_at_input_cap_but_requires_real_tail(tmp_path, tail, admitted):
    async def run():
        session, seen, submitted = await input_fixture(tmp_path)
        item = pending_input(session, "last")
        await pcm(session, 100, 2000)
        await pcm(session, tail)
        session.accept_input = False
        session.input_exhausted = True
        await final_input(session, item, "最后一条有效输入")
        assert bool(submitted) is admitted
        if not admitted:
            session._tail_wait_started -= 60
            await session.flush_fragments()
            assert not submitted
            assert next(row for row in seen if row["type"] == "input_tail_deferred")["inputExhausted"]
            session.discard_pending_input()
    asyncio.run(run())
