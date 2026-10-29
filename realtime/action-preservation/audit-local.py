"""Verify local comparison evidence and emit a small publishable result.

Requires the saved local campaign and comparison outputs. Does not call a model.
"""
import hashlib
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "outputs/action-preservation-20261028"


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def verify_hashes(manifest, base):
    expected = read(manifest)
    changed = [name for name, digest in expected.items()
               if hashlib.sha256((base / name).read_bytes()).hexdigest() != digest]
    assert not changed, f"protected_files_changed:{changed}"
    return len(expected)


def request_status(path, **kwargs):
    try:
        with urlopen(Request("http://127.0.0.1:18821" + path, **kwargs), timeout=10) as response:
            return response.status
    except HTTPError as error:
        return error.code


def main():
    protected = verify_hashes(OUT / "protected-before.json", ROOT)
    ledgers = verify_hashes(ROOT / "outputs/character-campaign-simtime-20261027/closure-ledger-hashes.json", ROOT / "outputs")
    browser = read(OUT / "browser-comparison.json")
    feedback = read(OUT / "feedback-comparison.json")
    interrupt = read(OUT / "interrupt-browser.json")
    assert all(interrupt["checks"].values())
    assert "153 passed" in (OUT / "python-tests.txt").read_text(encoding="utf-8-sig")
    node = (OUT / "node-tests.txt").read_text(encoding="utf-8-sig")
    assert "pass 54" in node and "fail 0" in node
    cases = []
    for case in browser:
        assert not case["error"]
        versions = []
        for engine in case["engines"]:
            assert engine["finite"] and engine["bodyAmplitude"] == engine["sourceSpeed"] == 1
            target = engine["target"][0]
            events = [e for e in engine["events"] if e.get("id") == target["id"]]
            started = next(e for e in events if e["type"] == "action_started")
            ended = next(e for e in events if e["type"] in {"action_completed", "action_cancelled"})
            entry = next(f for f in feedback if f["case"] == case["id"] and f["version"] == engine["name"])
            assert not entry["historyAcknowledged"] and entry["cloudCalls"] == 0
            versions.append({"version": engine["name"], "action": target["action"],
                "executedMs": round((ended["at"] - started["at"]) * 1000, 3),
                "outcome": target["status"], "reason": target.get("reason"),
                "movingOrdinaryReplacements": engine["movingReplaced"],
                "offlineDecisionRequestVideoSeconds": [round(r["videoSeconds"], 4) for r in entry["requests"]]})
        assert versions[0]["movingOrdinaryReplacements"] == 1
        assert versions[1]["movingOrdinaryReplacements"] == 0
        cases.append({"case": case["id"], "versions": versions})
    routes = {
        "page": request_status("/action-preservation/"),
        "localFixture": request_status("/action-preservation/data.json"),
        "privateLedger": request_status("/action-preservation/ledger.json"),
        "externalOrigin": request_status("/action-preservation/data.json", headers={"Origin": "https://example.com"}),
        "writeMethod": request_status("/action-preservation/", method="POST", data=b""),
        "videoRange": request_status("/action-preservation/video/short-03.webm", headers={"Range": "bytes=0-127"}),
    }
    assert routes == {"page": 200, "localFixture": 200, "privateLedger": 404,
                      "externalOrigin": 403, "writeMethod": 405, "videoRange": 206}
    result = {
        "experimental": True, "date": "2026-10-28", "baseline": browser[0]["baseline"],
        "method": "Same saved real model commands in old/new PMX executors; feedback scheduling checked with fake providers.",
        "newCloudCalls": 0, "pythonTestsPassed": 153, "nodeTestsPassed": 54,
        "protectedHashesUnchanged": protected, "existingLedgerHashesUnchanged": ledgers,
        "sourceAnimationSpeed": 1, "bodyAmplitude": 1, "cases": cases,
        "manualInterruption": {"checks": interrupt["checks"],
            "localCommandCancelMs": round(interrupt["cancelled"]["interruption"]["commandCancelMs"], 3),
            "scope": "Local cancel call only; not microphone, VAD, server confirmation or physical audio latency."},
        "httpChecks": routes,
        "limitations": ["No new free conversation or cloud latency measurement.",
            "Face samples are contextual replay, not phoneme alignment acceptance.",
            "First interrupt harness omitted the existing whole-turn fence; failure preserved and harness corrected before acceptance."]}
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    (Path(__file__).parent / "RESULTS.json").write_text(encoded, encoding="utf-8")
    (OUT / "audit-receipt.json").write_text(encoded, encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
