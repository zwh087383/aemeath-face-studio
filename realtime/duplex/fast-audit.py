"""Summarize the bounded three-arm experiment; never invokes a provider."""
import argparse
import hashlib
import json
import statistics
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def diff(a, b):
    return round(a-b, 3) if isinstance(a, (float, int)) and isinstance(b, (float, int)) else None


def metric_summary(rows, arm):
    good = [r for r in rows if r["arm"] == arm and r["acknowledged"]]
    metrics = {}
    for k in ("inputEndToPlaybackMs", "preparationMs", "contextSetupMs", "requestToPcmMs"):
        values = [r[k] for r in good if isinstance(r[k], (float, int))]
        metrics[k] = round(statistics.median(values), 3) if values else None
    return {"arm": arm, "successfulN": len(good), **metrics}


def build(root, face):
    plan = read(root / "batch-plan.json")
    rows, cases, budgets, interruptions, maintenance, session_failures = [], [], [], [], [], []
    for arm in plan["arms"]:
        output = root / arm["variant"]
        if not (output / "ledger.json").exists():
            continue
        ledger = read(output / "ledger.json")
        budgets.append({"arm": arm["variant"], "blocked": ledger["blocked"],
            "reasons": ledger["reasons"],
            "turns": len(ledger["turns"]), "turnLimit": ledger["turnLimit"],
            "responses": sum(r.get("responseId") is not None for r in ledger["responses"]),
            "responseLimit": ledger["responseLimit"],
            "unknown": sum(r["state"] == "unknown" for r in ledger["responses"]),
            "reserved": sum(r["state"] == "reserved" for r in ledger["responses"]),
            "reportedTokens": sum(r["usage"]["total_tokens"] for r in ledger["responses"] if r["state"] == "reported")})
        if (output / "drain.json").exists():
            drain = read(output / "drain.json")
            snapshot = drain["snapshot"]
            maintenance.append({"arm": arm["variant"],
                **{k: drain[k] for k in ("quiescent", "timed_out", "successful_drain")},
                **{k: snapshot[k] for k in ("history", "diary", "queues", "runtime")},
                "memoryCount": snapshot["memory"]["count"]})
        browsers = {}
        seen_interrupts = set()
        for path in output.glob("*-browser.json"):
            data = read(path)
            cases.append({"arm": arm["variant"], "name": data["name"], "failure": data.get("failure"),
                "videoUrl": f'http://127.0.0.1:{arm["port"]}/duplex-data/{data["name"]}.webm',
                "videoAvailable": (output / (data["name"] + ".webm")).is_file()
                    and (output / (data["name"] + ".webm")).stat().st_size > 0})
            for trial in data.get("client", {}).get("trials", []):
                if trial["startedAt"] >= data["start"]:
                    browsers[trial["id"]] = (trial, path.name, data["name"])
            for item in data.get("client", {}).get("interruptions", []):
                key = (item["turnId"], item.get("at"), item.get("reason"))
                if key not in seen_interrupts:
                    seen_interrupts.add(key)
                    interruptions.append({"arm": arm["variant"], **item})
        for path in output.glob("duplex-*.json"):
            session = read(path)
            session_failures.extend({"arm": arm["variant"], "source": path.name,
                **{k: e[k] for k in ("type", "code", "serverMs") if k in e}}
                for e in session["events"] if e["type"] == "blocked")
            for turn in session["turns"]:
                trial, source, name = browsers.get(turn["id"], ({}, None, None))
                own = [e for e in session["events"] if e.get("turnId") == turn["id"]]
                def first(kind): return next((e for e in own if e["type"] == kind), {})
                context = first("context_ready")
                result = turn.get("result") or {}
                fast = [e for e in own if e["type"] == "fast_reply"]
                def stage(kind): return next((e for e in fast if e["stage"] == kind), {})
                pcm, tool, receipt = [first(k) for k in ("audio", "tool", "tool_receipt_send")]
                same = bool(pcm and tool and pcm.get("responseId") == tool.get("responseId") == result.get("responseId"))
                inp = trial.get("input") or {}
                rows.append({"arm": arm["variant"], "case": name, "turnId": turn["id"],
                    "input": turn["text"], "transcript": result.get("transcript", "").strip(),
                    "acknowledged": turn["acknowledged"], "revoked": turn["revoked"],
                    "route": context.get("route"), "fastDecision": stage("model_decided").get("control"),
                    "fastNeeds": stage("model_decided").get("needs", []),
                    "fastStages": [{k: e[k] for k in ("stage", "serverMs", "reason", "memoryIds", "usedMemoryIds") if k in e} for e in fast],
                    "fastModelMs": diff(stage("model_decided").get("serverMs"), stage("model_started").get("serverMs")),
                    "fastDraft": turn.get("fastDraft"), "prewarmed": first("reply_connecting").get("prewarmed", False),
                    "preparationMs": context.get("preparationMs"), "contextChars": context.get("contextChars"),
                    "inputEndToPlaybackMs": diff(trial.get("playbackAt"), inp.get("lastSpeechAt")),
                    "endpointAndAdmissionMs": diff(trial.get("startedAt"), inp.get("lastSpeechAt")),
                    "contextSetupMs": diff(trial.get("requestAt"), trial.get("contextReadyAt")),
                    "requestToPcmMs": diff(trial.get("firstPcmAt"), trial.get("requestAt")),
                    "pcmToPlaybackMs": diff(trial.get("playbackAt"), trial.get("firstPcmAt")),
                    "motionAfterPlaybackMs": diff(trial.get("motionAt"), trial.get("playbackAt")),
                    "expressionAfterPlaybackMs": diff(trial.get("expressionAt"), trial.get("playbackAt")),
                    "plans": [c["plan"] for c in result.get("calls", [])],
                    "sameResponseBeforeReceipt": bool(same and receipt and max(pcm["serverMs"], tool["serverMs"]) < receipt["serverMs"]),
                    "status": result.get("status"), "error": first("turn_error").get("code"),
                    "source": source})
    preservation = {f: hashlib.sha256((face/f).read_bytes()).hexdigest() == digest
                    for f, digest in read(root / "preserved-before.json").items()}
    summary = [metric_summary(rows, arm["variant"]) for arm in plan["arms"]]
    # Only these two final ASR strings were identical in all three arms.
    # The long input was segmented differently, so exclude it from matched latency.
    matched = {"你还记得我在星桥咖啡店最喜欢喝什么吗？", "早上好呀，今天见到你很开心。"}
    paired = [metric_summary([r for r in rows if r["input"] in matched], arm["variant"])
              for arm in plan["arms"]]
    local_replays = [read(p) for p in root.glob("*/replay-*-regression.json")]
    requests = read(root / "model-request-metadata.json") if (root / "model-request-metadata.json").exists() else []
    return {"experimental": True, "physicalAcousticsVerified": False, "syntheticMemory": True,
            "fastPath": "existing text DONE/HANDOFF followed by Qwen speech and native action; both costs included",
            "rows": rows, "cases": cases, "budgets": budgets, "summary": summary,
            "matchedShortSummary": paired, "matchedShortInputs": sorted(matched),
            "maintenance": maintenance, "modelRequests": requests, "sessionFailures": session_failures,
            "localReplays": local_replays, "interruptions": interruptions, "preservation": preservation,
            "allProtectedUnchanged": all(preservation.values())}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--save", type=Path, required=True)
    args = parser.parse_args()
    report = build(args.root, Path(__file__).resolve().parents[2])
    args.save.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"summary": report["summary"], "budgets": report["budgets"]}, ensure_ascii=True))
