"""Read-only evidence audit. It never imports a provider or starts a model call."""
from collections import Counter, defaultdict
import json
from pathlib import Path
import time

from analyze import read, stats, summarize


def within(values, limit):
    return {"withinMs": limit, "count": sum(abs(v) <= limit for v in values), "n": len(values)}


def audit(root, prior=None):
    root = Path(root)
    summary = summarize(root)
    groups = defaultdict(list)
    selected, executed, expressions, failures = Counter(), Counter(), Counter(), Counter()
    executors, receipts = Counter(), Counter()
    provider_timings = defaultdict(list)
    interruption_records, cases, gap_records, emotion_records = [], [], [], []
    all_usage = {"channels": Counter(), "states": Counter(), "reportedTokens": 0,
                 "unknownMaxReservedTokens": 0, "pcmSeconds": 0, "unknown": [], "active": []}
    # Include diagnostics and superseded real-wait attempts, exactly as dispatch does.
    for evidence_root in (root, Path(prior) if prior else None):
        if evidence_root is None:
            continue
        for path in evidence_root.glob("**/ledger.json"):
            ledger = read(path, {})
            all_usage["pcmSeconds"] += ledger.get("pcmBytes", 0) / 32000
            for row in ledger.get("responses", []):
                state = row.get("state")
                all_usage["states"][state] += 1
                if state != "unused":
                    all_usage["channels"][row["channel"]] += 1
                all_usage["reportedTokens"] += (row.get("usage") or {}).get("total_tokens", 0) or 0
                record = {"path": str(path.relative_to(evidence_root)), "root": evidence_root.name,
                          "channel": row.get("channel"), "state": state,
                          "reason": row.get("unknownReason"), "terminalObserved": row.get("terminalObserved")}
                if state == "unknown":
                    all_usage["unknown"].append(record)
                    all_usage["unknownMaxReservedTokens"] += sum(row.get("maxTokens", {}).get(k, 0) for k in ("input", "output"))
                if state in {"active", "reserved"}:
                    all_usage["active"].append(record)
    for case in summary["cases"]:
        folder = root / "cases" / case["id"]
        raw = read(folder / "campaign-observations.json")
        if raw is None:
            continue
        # Exclusions describe environmental comparability, not erased failures.
        deviation = read(folder / "render-environment-deviation.json")
        performance = raw.get("renderPerformance", {})
        fps = performance.get("frames", 0) * 1000 / max(performance.get("elapsedMs", 0), 1)
        ordinary_render = not deviation and fps >= 20 and not case["renderFault"]
        executed.update(case["actions"])
        failures.update(case["actionFailures"])
        latest_files = list(folder.glob("client-live-*.json"))
        client = read(max(latest_files, key=lambda f: f.stat().st_mtime_ns), {}) if latest_files else {}
        for record in client.get("interruptions", []):
            interruption_records.append({"case": case["id"], **record})
        event_rows = []
        for path in folder.glob("duplex-*.json"):
            event_rows.extend(read(path, {}).get("events", []))
        for event in event_rows:
            kind = event.get("type")
            if kind == "character_actions":
                selected.update(a["action"] for a in event.get("command", {}).get("actions", []))
            if kind == "character_expression":
                command = event.get("command", {})
                expressions[str(command.get("mode")) + ":" + str(command.get("kind"))] += 1
            if kind == "character_semantic_done":
                timings = event.get("timings", {})
                for name in ("request_sent", "first_argument_delta", "first_complete_arguments", "first_body_delivery"):
                    if isinstance(timings.get(name), (int, float)):
                        provider_timings[name].append(timings[name])
                if event.get("sourceScope") == "user" and isinstance(timings.get("first_body_delivery"), (int, float)):
                    provider_timings["user_body_decision_ms"].append(timings["first_body_delivery"])
        for event in raw.get("bodyEvents", []):
            receipts[event.get("type")] += 1
            if event.get("type") == "action_started":
                executors[event.get("executor")] += 1
        metrics = [t.get("metrics", {}) for t in case["turns"]]
        for metric in metrics:
            for name in ("lastSpeechToVoiceMs", "requestToVoiceMs", "commandLeadMs", "bodyStartLeadMs", "visibleBodyLeadMs", "visibleFaceLeadMs"):
                value = metric.get(name)
                if isinstance(value, (int, float)):
                    groups["all:" + name].append(value)
                    if ordinary_render:
                        groups["ordinaryRender:" + name].append(value)
        for gap in case["gaps"]:
            gap_records.append({"case": case["id"], "kind": case["kind"], "targetSeconds": gap.get("targetSeconds"),
                                "logicalSeconds": gap.get("logicalSeconds"), "realSeconds": gap.get("actualSeconds")})
        emotion = [s.get("face", {}).get("math", {}).get("emotion", {}) for s in raw.get("samples", [])]
        emotion = [e for e in emotion if isinstance(e.get("V"), (int, float))]
        if emotion:
            emotion_records.append({"case": case["id"], "initialLabel": case["emotion"], "n": len(emotion),
                "firstV": emotion[0]["V"], "lastV": emotion[-1]["V"], "minV": min(e["V"] for e in emotion),
                "maxV": max(e["V"] for e in emotion), "firstA": emotion[0].get("A"), "lastA": emotion[-1].get("A"),
                "highSadSamples": sum(e["V"] <= -.7 for e in emotion),
                "highExcitedSamples": sum(e["V"] >= .7 and e.get("A", 0) >= .7 for e in emotion)})
        cases.append({"id": case["id"], "emotion": case["emotion"], "kind": case["kind"],
            "fps": round(fps, 2), "ordinaryRender": ordinary_render, "environmentDeviation": deviation,
            "planned": case["plannedTurns"], "submitted": case["submittedFixtures"], "voicedFixtures": case["voicedFixtures"],
            "completeDialogueCoverage": case["completedFeeds"] == case["plannedTurns"] and case["voicedFixtures"] == case["plannedTurns"],
            "errors": case["errors"], "renderFault": case["renderFault"], "activities": case["activities"],
            "drainQuiescent": case["runtimeEvidence"].get("quiescent"),
            "drainSuccessful": case["runtimeEvidence"].get("successful_drain")})
    return {"at": time.time(), "summary": {k: v for k, v in summary.items() if k != "cases"}, "cases": cases,
            "metrics": {k: stats(v) for k, v in groups.items()},
            "synchronization": {k: [within(v, t) for t in (250, 500, 1000)] for k, v in groups.items() if k.endswith("LeadMs")},
            "modelSelectedActions": dict(selected), "executedActions": dict(executed),
            "expressionCommands": dict(expressions), "executionFailures": dict(failures),
            "executorCounts": dict(executors), "executionReceipts": dict(receipts),
            "decisionTiming": {k: stats(v) for k, v in provider_timings.items()},
            "interruptions": interruption_records, "gaps": gap_records, "emotion": emotion_records,
            "allEvidenceUsage": all_usage}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prior-output", type=Path)
    args = parser.parse_args()
    value = audit(args.output, args.prior_output)
    (args.output / "quality.json").write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"finished": value["summary"]["finished"],
        "inputFixtures": value["summary"]["submittedFixtures"], "voicedFixtures": value["summary"]["voicedFixtures"],
        "uniqueExecutedActions": len(value["executedActions"]), "channels": value["allEvidenceUsage"]["channels"],
        "unknown": len(value["allEvidenceUsage"]["unknown"])}, ensure_ascii=False))
