"""Fake provider only. No credentials, runtime bootstrap, or cloud usage."""
import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import threading

import pytest
from test_parallel_duplex_backend import Socket, fake_main, turn, USAGE

FACE=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location("model_director_test", FACE/"realtime/model-director/backend.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def command(count=3):
    return {"operation":"append","actions":[{"action":"gesture:wave","anchor":"prepare","delay_ms":0} for _ in range(count)]}

def events(*commands,usage=USAGE):
    rows=[{"type":"response.created","response":{"id":"planner_1"}}]
    for i,value in enumerate(commands):
        item,call=f"item_{i}",f"call_{i}"
        raw=json.dumps(value,ensure_ascii=False)
        rows.extend([
            {"type":"response.output_item.added","response_id":"planner_1","item":{
                "type":"function_call","id":item,"call_id":call,"name":"perform_actions"}},
            {"type":"response.function_call_arguments.delta","response_id":"planner_1","item_id":item,"delta":raw},
            {"type":"response.function_call_arguments.done","response_id":"planner_1","item_id":item,"arguments":raw}])
    rows.append({"type":"response.done","response":{"id":"planner_1","status":"completed","usage":usage}})
    return rows

async def fixture(tmp_path,socket,notify=None):
    budget=m.ModelBudget(tmp_path/"ledger.json");seen=[]
    async def send(row):
        seen.append(row)
        if notify:await notify(row)
    async def factory():return socket
    session=m.ModelDuplexSession(SimpleNamespace(),fake_main(),budget,tmp_path,send,factory=factory)
    session.accept_input=True;session.schedule_planner_warm();session.schedule_planner_warm=lambda:None
    entry={"generation":1,"voice_requested":asyncio.Event(),"cancel":threading.Event(),"task":None,"connection":None,"reservation":None}
    entry["voice_requested"].set()
    return session,budget,entry,seen

def test_many_actions_and_multiple_calls_emit_without_receipt_roundtrip(tmp_path):
    async def run():
        socket=Socket(events(command(12),command(8)))
        session,budget,entry,seen=await fixture(tmp_path,socket)
        await session.run_planner(turn(),[],entry)
        plans=[r for r in seen if r["type"]=="action_plan"]
        assert [len(r["command"]["actions"]) for r in plans]==[12,8]
        assert len({r["planId"] for r in plans})==2
        kinds=[r["type"] for r in seen]
        assert max(i for i,k in enumerate(kinds) if k=="action_plan")<kinds.index("planner_receipt_send")
        assert len([r for r in socket.sent if r["type"]=="response.create"])==1
        assert budget.snapshot()["responses"]==1 and budget.snapshot()["unknown"]==0
        assert budget.data["experimentId"]==m.EXPERIMENT
    asyncio.run(run())

def test_schema_has_no_action_count_ceiling_and_catalog_is_complete():
    assert len(m.KEYS)==73
    assert "maxItems" not in m.TOOL["function"]["parameters"]["properties"]["actions"]
    assert len(m.parse_commands(json.dumps(command(300)))["actions"])==300

@pytest.mark.parametrize("raw",[
    '{"operation":"clear","operation":"append","actions":[]}',
    '{"operation":"clear","actions":[{"action":"gesture:wave","anchor":"prepare","delay_ms":0}]}',
    '{"operation":"append","actions":[{"action":"body-stand2-84d0c0a158","anchor":"voice","delay_ms":0}]}',
    '{"operation":"append","actions":[{"action":"gesture:wave","anchor":"prepare","delay_ms":true}]}',
    '{"operation":"append","actions":[],"emotion":"happy"}',
])
def test_malformed_or_fabricated_commands_are_rejected(raw):
    with pytest.raises(ValueError):m.parse_commands(raw)

def test_completed_voice_does_not_discard_later_planner_command(tmp_path):
    async def run():
        s,b,e,seen=await fixture(tmp_path,Socket(events(command())))
        t=turn();t["acknowledged"]=True
        await s.run_planner(t,[],e)
        assert any(r["type"]=="action_plan" for r in seen)
    asyncio.run(run())

def test_cancel_blocks_later_actions_but_keeps_usage_accounting(tmp_path):
    async def run():
        t=turn()
        async def notify(row):
            if row["type"]=="action_plan":t["cancel"].set()
        s,b,e,seen=await fixture(tmp_path,Socket(events(command(),command())),notify)
        await s.run_planner(t,[],e)
        assert len([r for r in seen if r["type"]=="action_plan"])==1
        assert b.snapshot()["unknown"]==0
    asyncio.run(run())

def test_unknown_usage_still_stops_new_calls(tmp_path):
    async def run():
        s,b,e,_=await fixture(tmp_path,Socket(events(command(),usage=None)))
        await s.run_planner(turn(),[],e)
        assert b.data["blocked"] and b.snapshot()["unknown"]==1 and not s.accept_input
    asyncio.run(run())

def test_memory_correction_guard_prevents_using_revoked_context(tmp_path):
    async def run():
        socket=Socket(events(command()));s,b,e,seen=await fixture(tmp_path,socket)
        t=turn();t["guard"]=lambda:False;s.turns[t["id"]]=t;s.current_turn=t
        await s.run_planner(t,[{"role":"system","content":"withdrawn memory"}],e)
        assert t["cancel"].is_set() and not b.data["responses"]
        assert not any(r["type"]=="conversation.item.create" for r in socket.sent)
    asyncio.run(run())

def test_payload_has_no_future_answer_and_history_ack_is_inherited():
    session=object.__new__(m.ModelDuplexSession)
    value=session.make_planner_payload(turn(),[{"role":"user","content":"previous user"}],{})
    assert value["future_reply_available"] is False and "allowed_intents" not in value
    assert len(value["available_actions"])==73
    assert m.ModelDuplexSession.acknowledge is m.base.DuplexSession.acknowledge
    assert m.ModelDuplexSession.reply is m.base.ParallelDuplexSession.reply
