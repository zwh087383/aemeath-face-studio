"""Replay the two saved commands/receipts through real old/new backend methods.

Uses existing fake-provider fixtures; independent local budgets only. A captured
decision request proves its timing, not a newly generated model continuation.
"""
import ast
import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sys
import subprocess
import tempfile
from types import MethodType

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/"realtime/tests"))
from test_character_center_backend import fixture, user_job, m


async def main():
    out = ROOT/"outputs/action-preservation-20261028"
    data = json.loads((out/"comparison-data.json").read_text(encoding="utf-8-sig"))
    browser = json.loads((out/"browser-comparison.json").read_text(encoding="utf-8-sig"))
    baseline = subprocess.check_output(["git", "show", f"{data['baseline']}:realtime/character-center/backend.py"],
                                       cwd=ROOT, text=True, encoding="utf-8")
    tree = ast.parse(baseline)
    old_method = next(node for cls in tree.body if isinstance(cls, ast.ClassDef)
                      for node in cls.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "action_receipt")
    scope = dict(vars(m)); exec(compile(ast.Module(body=[old_method], type_ignores=[]), "saved-baseline-action-receipt", "exec"), scope)
    report = []
    for case in data["cases"]:
        record = next(c for c in browser if c["id"] == case["id"])
        model_command = case["commands"][case["targetCommandIndex"]]
        for version in ["old", "new"]:
            engine = next(e for e in record["engines"] if e["name"] == version)
            recorded_id = model_command["owner"]["requestId"]
            events = [e for e in engine["events"] if e.get("owner", {}).get("requestId") == recorded_id
                      and e["type"] in {"action_admitted", "action_started", "action_completed", "action_failed", "action_rejected", "action_expired", "action_cancelled"}]
            with tempfile.TemporaryDirectory(prefix="feedback-offline-", dir=out) as directory:
                session, _, _, seen, turn = await fixture(Path(directory), [("perform_actions", model_command["command"])])
                await user_job(session, turn)
                command_id = next(e["commandId"] for e in seen if e["type"] == "character_actions")
                if version == "old": session.action_receipt = MethodType(scope["action_receipt"], session)
                requested, receipts, clock = [], [], 0
                def capture(*args, **kwargs):
                    requested.append({"videoSeconds": clock, "payload": deepcopy(args[3])}); return object()
                session._submit = capture
                for event in events:
                    status = event["type"][7:]; clock = event["videoSeconds"]
                    if version == "old" and status in {"admitted", "started"}: continue
                    if event.get("reason") in {"confirmed_voice_barge_in", "new_user_turn", "explicit_user_interrupt"}:
                        turn["cancel"].set()
                    answer = await session.action_receipt({"commandId": command_id, "index": event["index"],
                        "action": event["action"], "status": status, "reason": event.get("reason"),
                        "actorState": {"support": "standing", "hands": "free", "props": {}, "canYield": False}})
                    receipts.append({"videoSeconds": clock, "status": status, "action": event["action"], "answer": answer})
                report.append({"case": case["id"], "version": version, "requests": requested,
                    "receipts": receipts, "historyAcknowledged": bool(turn.get("acknowledged")), "cloudCalls": 0})
    (out/"feedback-comparison.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    by = {(r["case"], r["version"]): r for r in report}
    assert len(by["short-03", "old"]["requests"]) == 1
    assert not by["short-03", "new"]["requests"]  # user's actual interruption wins
    assert len(by["short-08", "old"]["requests"]) == len(by["short-08", "new"]["requests"]) == 1
    new = by["short-08", "new"]["requests"][0]
    assert new["payload"]["settled_plan"]["all_steps_terminal"]
    assert new["videoSeconds"] > by["short-08", "old"]["requests"][0]["videoSeconds"]
    assert not any(r["historyAcknowledged"] for r in report)
    print(json.dumps([{"case": r["case"], "version": r["version"], "decisionRequestTimes": [v["videoSeconds"] for v in r["requests"]]} for r in report]))


if __name__ == "__main__": asyncio.run(main())
