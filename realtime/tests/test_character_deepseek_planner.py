"""Offline end-to-end planner adapter checks. No paid calls or credentials."""
import asyncio
from functools import partial
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from test_character_center_backend import m, b, user_job, fake_main, turn, actions

HERE = Path(__file__).parents[1] / "character-center"
spec = importlib.util.spec_from_file_location("deepseek_planner_test", HERE / "deepseek_planner.py")
ds = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ds
spec.loader.exec_module(ds)


def response_events(*, usage=True, bad_owner=False):
    raw = json.dumps(actions(), ensure_ascii=False)
    rows = [{"id":"ds_response_1", "choices":[{"index":0,"delta":{"tool_calls":[{
        "index":0,"id":"ds_call_1","function":{"name":"perform_actions","arguments":raw[:12]}}]}}]},
        {"id":"foreign" if bad_owner else "ds_response_1", "choices":[{"index":0,"delta":{"tool_calls":[{
            "index":0,"function":{"arguments":raw[12:]}}]}}]},
        {"id":"ds_response_1", "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}]
    if usage:
        rows.append({"id":"ds_response_1","choices":[],"usage":{"prompt_tokens":15,"completion_tokens":8,"total_tokens":23}})
    return [b"data: "+json.dumps(row).encode()+b"\n" for row in rows] + [b"data: [DONE]\n"]


class Content:
    def __init__(self, rows, gate=None):
        self.rows, self.gate = rows, gate
    async def __aiter__(self):
        if self.gate:
            await self.gate.wait()
        for row in self.rows:
            await asyncio.sleep(0)
            yield row


class Response:
    status = 200
    def __init__(self, rows=(), gate=None):
        self.content = Content(rows, gate)
    async def __aenter__(self):
        return self
    async def __aexit__(self, *args):
        pass
    async def read(self):
        return b'{}'


class Http:
    def __init__(self, rows, gate=None):
        self.rows, self.gate, self.posts = rows, gate, []
        self.raw_posts, self.headers = [], []
        self.closed = False
    def get(self, *args, **kwargs):
        return Response()
    def post(self, *args, **kwargs):
        wire = kwargs["data"]
        assert isinstance(wire, bytes)
        self.raw_posts.append(wire)
        self.headers.append(kwargs["headers"])
        self.posts.append(json.loads(wire))
        return Response(self.rows, self.gate)
    async def close(self):
        self.closed = True


async def configured(http):
    config = ds.DeepSeekConfig("offline-placeholder")
    connection = ds.DeepSeekPlannerConnection(config=config, http_factory=lambda:http)
    await connection.open()
    await connection.add_context([{"role":"user","content":"{}"}], batch=True)
    return connection


def test_original_tools_and_sse_flow_then_receipt_cannot_generate_again():
    async def run():
        http = Http(response_events())
        c = await configured(http)
        await c.send({"type":"response.create"})
        seen = []
        while not seen or seen[-1]["type"] != "response.done":
            seen.append(await c.receive())
        assert seen[0]["type"] == "response.created"
        done = next(e for e in seen if e["type"] == "response.function_call_arguments.done")
        assert done["name"] == "perform_actions" and json.loads(done["arguments"]) == actions()
        assert seen[-1]["response"]["usage"]["total_tokens"] == 23
        assert http.posts[0]["messages"][0]["content"] == m.protocol.RULES
        assert http.posts[0]["tools"] == m.protocol.tools()
        await c.send({"type":"conversation.item.create","item":{"type":"function_call_output","call_id":"ds_call_1"}})
        with pytest.raises(m.base.ProtocolError):
            await c.send({"type":"response.create"})
        assert len(http.posts) == 1
        await c.close()
        assert http.closed
    asyncio.run(run())


def test_cancel_drains_terminal_usage_instead_of_aborting_http():
    async def run():
        gate = asyncio.Event()
        http = Http(response_events(), gate)
        c = await configured(http)
        await c.send({"type":"response.create"})
        await c.send({"type":"response.cancel"})
        assert not c.task.cancelled()
        gate.set()
        while True:
            e = await c.receive()
            if e["type"] == "response.done":
                assert e["response"]["status"] == "cancelled"
                assert e["response"]["usage"]["total_tokens"] == 23
                break
        await c.close()
    asyncio.run(run())


def test_wrong_owner_is_rejected_without_dispatching_tool():
    async def run():
        c = await configured(Http(response_events(bad_owner=True)))
        await c.send({"type":"response.create"})
        kinds = []
        with pytest.raises(m.base.ProtocolError):
            while True:
                kinds.append((await c.receive())["type"])
        assert "response.function_call_arguments.done" not in kinds
        await c.close()
    asyncio.run(run())


@pytest.mark.parametrize("cancel_at_command", [False, True])
def test_actual_sidecar_uses_same_guards_and_settles_action_channel(tmp_path, cancel_at_command):
    async def run():
        http = Http(response_events())
        seen = []
        budget = b.CenterBudget(tmp_path / "budget.json", stop_on_unknown=True)
        t = turn()
        async def notify(event):
            seen.append(event)
            if cancel_at_command and event["type"] == "character_semantic_request":
                t["cancel"].set()
        def connection(**kwargs):
            return ds.DeepSeekPlannerConnection(config=ds.DeepSeekConfig("offline"), http_factory=lambda:http, **kwargs)
        session = m.CharacterCenterSession(SimpleNamespace(), fake_main(), budget, tmp_path, notify,
                                           planner_connection_class=connection)
        session.schedule_planner_warm()
        session.schedule_planner_warm = lambda:None
        session.turns[t["id"]] = t
        session.current_turn = t
        await user_job(session, t)
        if cancel_at_command:
            assert not any(e["type"] == "character_actions" for e in seen)
        else:
            action = next(e for e in seen if e["type"] == "character_actions")
            assert action["command"] == actions()
            assert action["plannerProvider"] == "deepseek"
        assert budget.data["responses"][0]["state"] == "reported"
        assert budget.data["responses"][0]["channel"] == "action"
        assert len(http.raw_posts) == 1
        assert budget.data["responses"][0]["maxTokens"] == ds.request_token_bound(len(http.raw_posts[0]))
        assert len(http.raw_posts[0]) <= ds.MAX_REQUEST_BYTES
        sent_payload = json.loads(http.posts[0]["messages"][1]["content"])
        expected = m.input_view.compact_catalog(session.catalog)
        assert sent_payload["available_actions"] == expected
        assert [row[0] for row in sent_payload["available_actions"]["actions"]] == [row["id"] for row in session.catalog]
        await session.close()
    asyncio.run(run())


def test_size_bound_and_missing_usage_fail_closed(tmp_path):
    async def run():
        c = ds.DeepSeekPlannerConnection(config=ds.DeepSeekConfig("offline"), http_factory=lambda:Http(response_events()))
        await c.open()
        with pytest.raises(m.base.ProtocolError, match="size_bound"):
            await c.add_context([{"role":"user","content":"x"*ds.MAX_REQUEST_BYTES}])
        assert c.body is None and c.request_bytes is None and c.request_size_bytes == 0
        await c.close()
    asyncio.run(run())
    budget = b.CenterBudget(tmp_path / "budget.json", stop_on_unknown=True)
    row = budget.reserve("action_planner", "deepseek", "one", ds.DeepSeekPlannerConnection.token_bound)
    budget.created(row, "ds_response_1")
    budget.settle(row, {"id":"ds_response_1","status":"completed","usage":None})
    assert budget.data["blocked"]
    assert not budget.available("direct_reply")
    assert row["state"] == "unknown" and row["maxTokens"]["output"] == 2048


def test_exact_wire_byte_limit_utf8_and_frozen_request_match_reserved_bound():
    async def run():
        async def empty():
            http = Http(response_events())
            c = ds.DeepSeekPlannerConnection(config=ds.DeepSeekConfig("offline"), http_factory=lambda: http)
            await c.open()
            return c, http
        baseline, _ = await empty()
        await baseline.add_context([{"role": "user", "content": ""}])
        overhead = baseline.request_size_bytes
        await baseline.close()
        capacity = ds.MAX_REQUEST_BYTES - overhead
        # Three-byte Chinese plus remaining ASCII reaches the exact wire bound.
        text = "中" * (capacity // 3) + "x" * (capacity % 3)
        accepted, http = await empty()
        messages = [{"role": "user", "content": text}]
        await accepted.add_context(messages)
        assert accepted.request_size_bytes == ds.MAX_REQUEST_BYTES
        assert accepted.token_bound == ds.request_token_bound(ds.MAX_REQUEST_BYTES)
        frozen = accepted.request_bytes
        messages[0]["content"] = "mutated after reservation"
        accepted.body["max_tokens"] = 999999
        await accepted.send({"type": "response.create"})
        while (await accepted.receive())["type"] != "response.done":
            pass
        assert http.raw_posts == [frozen]
        assert http.posts[0]["messages"][1]["content"] == text
        assert http.posts[0]["max_tokens"] == ds.MAX_OUTPUT_TOKENS
        assert http.headers[0]["Content-Type"] == "application/json; charset=utf-8"
        await accepted.close()
        rejected, rejected_http = await empty()
        with pytest.raises(m.base.ProtocolError, match="size_bound"):
            await rejected.add_context([{"role": "user", "content": text + "x"}])
        assert rejected.body is None and rejected.request_bytes is None
        with pytest.raises(m.base.ProtocolError, match="request_state_invalid"):
            await rejected.send({"type": "response.create"})
        assert rejected_http.posts == []
        await rejected.close()
    asyncio.run(run())


def test_configuration_repr_hides_key_and_other_endpoints_rejected(tmp_path):
    env = tmp_path / "runtime.env"
    env.write_text('DEEPSEEK_API_KEY=private-value\nDEEPSEEK_BASE_URL=https://evil.invalid\n')
    with pytest.raises(ValueError):
        ds.DeepSeekConfig.from_file(env)
    assert "private-value" not in repr(ds.DeepSeekConfig("private-value"))
