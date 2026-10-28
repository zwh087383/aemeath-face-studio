"""Offline, sanitized closure metrics. Never opens a provider or modifies a ledger."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path

from analyze import read, stats


def audit(root, prior):
    quality = read(root / "quality.json")
    summary = read(root / "summary.json")
    ordinary = {c["id"] for c in quality["cases"] if c["ordinaryRender"]}
    phases, lags, pause_records = defaultdict(list), defaultdict(list), []
    cancellation, activity_choices, history = Counter(), Counter(), Counter()
    activity_kinds = defaultdict(Counter)
    source_versions = defaultdict(set)
    queue_failures, correction_receipts = [], []
    audio_status = Counter()
    audio_faults, midstream_buffer_samples, revoked_settled = [], [], []
    for case in summary["cases"]:
        folder = root / "cases" / case["id"]
        raw = read(folder / "campaign-observations.json")
        source = read(folder / "case-source.json", {})
        for name, digest in source.get("sourceHashes", {}).items():
            source_versions[name].add(digest)
        for turn in case["turns"]:
            if turn.get("revoked") and (turn.get("historySettled") or turn.get("settledAt")):
                revoked_settled.append(case["id"])
            if case["id"] not in ordinary:
                continue
            inp = turn.get("input") or {}
            if not isinstance(turn.get("voiceAt"), (int, float)):
                continue
            points = (inp.get("lastSpeechAt"), inp.get("stoppedAt"), inp.get("finalAt"),
                      turn.get("requestAt"), turn.get("voiceAt"))
            for name, start, end in zip(("tail_to_stop", "stop_to_transcript", "transcript_to_request", "request_to_voice"), points, points[1:]):
                if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start:
                    phases[name].append(end - start)
            for key in ("commandLeadMs", "bodyStartLeadMs", "visibleBodyLeadMs", "visibleFaceLeadMs"):
                value = turn.get("metrics", {}).get(key)
                if isinstance(value, (int, float)):
                    lags[key].append(-value)
        for event in raw.get("bodyEvents", []):
            if event.get("type") == "action_cancelled":
                cancellation[event.get("reason")] += 1
        for sample in raw.get("samples", []):
            audio = sample.get("audio", {})
            audio_status[audio.get("status", "missing")] += 1
            if audio.get("fault") or audio.get("lastError"):
                audio_faults.append(case["id"])
            if audio.get("status") == "buffering" and audio.get("time", 0) > 0:
                midstream_buffer_samples.append(case["id"])
        for activity in case["activities"]:
            group = activity_kinds[activity["expected"]]
            group["planned"] += 1
            group["started"] += activity["status"] != "not_started"
            group["matched"] += bool(activity["matched"])
            group[activity["status"]] += 1
        snapshot = case["runtimeEvidence"].get("snapshot", {})
        history.update(snapshot.get("history", {}).get("by_role", {}))
        for name, queue in snapshot.get("queues", {}).items():
            if queue.get("failed", 0):
                queue_failures.append({"case": case["id"], "queue": name, "failed": queue["failed"]})
        clients = list(folder.glob("client-live-*.json"))
        client = read(max(clients, key=lambda p: p.stat().st_mtime_ns), {}) if clients else {}
        for event in client.get("client", {}).get("events", []):
            if event.get("type") == "provisional_pause":
                cancel = next((e for e in client.get("interruptions", [])
                               if e.get("turnId") == event.get("turnId") and e.get("at", 0) >= event["at"]), {})
                pause_records.append({"case": case["id"], "accepted": event.get("accepted"),
                    "sourcesBefore": event.get("sourceBefore"), "sourcesAfter": event.get("sourceAfter"),
                    "confirmationWaitMs": round(cancel["at"] - event["at"], 2) if cancel else None,
                    "reason": cancel.get("reason")})
        for path in folder.glob("duplex-*.json"):
            for event in read(path, {}).get("events", []):
                if event.get("type") == "character_actions" and event.get("sourceScope") == "activity":
                    activity_choices.update(a["action"] for a in event.get("command", {}).get("actions", []))
                if event.get("type") == "revoked" and event.get("reason") == "direct_context_revoked":
                    correction_receipts.append({"case": case["id"], "type": event["type"], "reason": event["reason"]})
    incomplete = [{k: c[k] for k in ("id", "kind", "planned", "submitted", "voicedFixtures", "errors")}
                  for c in quality["cases"] if not c["completeDialogueCoverage"]]
    coverage = {kind: {"planned": sum(c["kind"] == kind for c in quality["cases"]),
                       "completeInputAndVoiceCoverage": sum(c["kind"] == kind and c["completeDialogueCoverage"] for c in quality["cases"])}
                for kind in ("single", "short", "long")}
    interrupts = quality["interruptions"]
    buttons = [e for e in interrupts if e["reason"] == "explicit_user_interrupt"]
    usage = quality["allEvidenceUsage"]
    ledger_hashes, reserved_tokens = {}, 0
    for evidence in (root, prior):
        for path in sorted(evidence.glob("**/ledger.json")):
            ledger_hashes[evidence.name + "/" + path.relative_to(evidence).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
            for row in read(path, {}).get("responses", []):
                if row.get("state") == "reserved":
                    reserved_tokens += sum(row.get("maxTokens", {}).get(k, 0) for k in ("input", "output"))
    (root / "closure-ledger-hashes.json").write_text(json.dumps(ledger_hashes, indent=2), encoding="utf-8")
    return {"experimental": True, "campaign": root.name, "completedAt": "2026-10-28",
        "catalogCapabilities": 83, "finishedScenarios": summary["finished"],
        "plannedInputs": 180, "submittedInputs": summary["submittedFixtures"], "voicedInputs": summary["voicedFixtures"],
        "coverage": coverage, "incompleteScenarios": incomplete,
        "normalRenderResponses": len(lags["bodyStartLeadMs"]), "excludedRenderCases": sorted(set(c["id"] for c in quality["cases"]) - ordinary),
        "phaseMs": {k: stats(v) for k, v in phases.items()},
        "latencyMs": quality["metrics"], "lateRelativeToVoiceMs": {k: stats(v) for k, v in lags.items()},
        "synchronization": quality["synchronization"], "decisionTimingMs": quality["decisionTiming"],
        "activityLifecycle": dict(activity_kinds), "activityModelChoices": dict(activity_choices),
        "executedActionKinds": len(quality["executedActions"]), "executedActions": quality["executedActions"],
        "executionReceipts": quality["executionReceipts"], "expiredReasons": quality["executionFailures"],
        "cancelReasons": dict(cancellation), "expressionCommands": quality["expressionCommands"],
        "interruptions": {"reasons": dict(Counter(e["reason"] for e in interrupts)),
            "buttonCallbacksMs": stats([e["returnMs"] for e in buttons]),
            "allRecordedSourcesCleared": all(e["sourcesAfter"] == 0 for e in interrupts), "localVoicePauses": pause_records},
        "history": {"roles": dict(history), "queueFailures": queue_failures,
            "successfulDrainCases": sum(bool(c["drainSuccessful"]) for c in quality["cases"]), "correctionReceipts": correction_receipts,
            "settledResponses": sum(c["settled"] for c in summary["cases"]), "revokedAndSettledCases": revoked_settled},
        "audioSampling": {"statusCounts": dict(audio_status), "faultCases": sorted(set(audio_faults)),
            "midstreamBufferSamples": len(midstream_buffer_samples), "midstreamBufferCases": sorted(set(midstream_buffer_samples)),
            "limitation": "Approximate one-second snapshots cannot exclude short underruns or physical audible gaps."},
        "emotionInitialCoverage": summary["emotionCoverage"],
        "emotionThresholdCoverage": {"highSadCases": sum(e["initialLabel"] == "high_sad" and e["highSadSamples"] > 0 for e in quality["emotion"]),
            "highExcitedCases": sum(e["initialLabel"] == "high_excited" and e["highExcitedSamples"] > 0 for e in quality["emotion"])},
        "gaps": {kind: {k: stats([g[k] for g in quality["gaps"] if g["kind"] == kind]) for k in ("logicalSeconds", "realSeconds")} for kind in ("short", "long")},
        "usage": {k: usage[k] for k in ("channels", "states", "reportedTokens", "unknownMaxReservedTokens", "pcmSeconds")},
        "unsettledReservedMaxTokens": reserved_tokens,
        "sourceVersionCounts": {k: len(v) for k, v in source_versions.items()},
        "evidenceBoundaries": ["Synthetic user PCM; real Qwen voice and DeepSeek tool calls.",
            "Idle scheduling at up to 10x; speech and animations at original speed.",
            "Lifecycle success is not complete physical reading performance.",
            "Visible-face threshold is not a semantic expression accuracy metric.",
            "Callback return time is not microphone-to-speaker interruption latency.",
            "The separate 262-capability library was not tested in this campaign."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prior-output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.output, args.prior_output)
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: result[k] for k in ("coverage", "phaseMs", "lateRelativeToVoiceMs", "activityLifecycle", "activityModelChoices", "cancelReasons", "interruptions", "history", "gaps", "usage", "unsettledReservedMaxTokens")}, ensure_ascii=False))
