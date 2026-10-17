"""Aggregate local experiment evidence without publishing raw prompts or PCM."""
import argparse
import hashlib
import json
import statistics
from pathlib import Path


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def delta(end, start):
    return round(end - start, 3) if isinstance(end, (int, float)) and isinstance(start, (int, float)) else None


def distribution(values):
    values = sorted(v for v in values if isinstance(v, (int, float)))
    return {"n": len(values), "median": round(statistics.median(values), 3),
            "min": round(values[0], 3), "max": round(values[-1], 3)} if values else {"n": 0}


def build(output, face_root):
    browser = {}
    cases = []
    for path in output.glob("*-browser.json"):
        data = read(path)
        if "client" not in data:
            continue
        for trial in data["client"]["trials"]:
            browser[trial["id"]] = (trial, data, path.name)
        video = path.name.replace("-browser.json", ".webm")
        cases.append({"name": data["name"], "failure": data.get("failure"), "mode": data["mode"],
                      "video": video, "videoAvailable": (output / video).is_file(),
                      "posterAvailable": (output / (data["name"] + "-poster.jpg")).is_file()})
    rows, interrupts = [], []
    for path in output.glob("duplex-*.json"):
        data = read(path)
        events = data["events"]
        for turn in data["turns"]:
            trial, observed, source = browser.get(turn["id"], ({}, {}, None))
            own = [e for e in events if e.get("turnId") == turn["id"]]
            def first(kind):
                return next((e for e in own if e["type"] == kind), {})
            result = turn.get("result") or {}
            request, pcm, tool, receipt = [first(k) for k in ("request_sent", "audio", "tool", "tool_receipt_send")]
            context, started = first("context_ready"), first("turn_started")
            item = [e for e in events if e.get("itemId") == turn.get("itemId")]
            def input_time(kind):
                return next((e["serverMs"] for e in item if e["type"] == kind), None)
            same = bool(pcm and tool and pcm.get("responseId") == tool.get("responseId") == result.get("responseId"))
            row = {"turnId": turn["id"], "connectionId": data["connectionId"], "input": turn["text"],
                "transcript": result.get("transcript", "").strip(), "status": result.get("status"),
                "acknowledged": turn["acknowledged"], "revoked": turn["revoked"],
                "speechFrames": result.get("frames", 0), "plans": [c["plan"] for c in result.get("calls", [])],
                "sameResponseSpeechAndTool": same,
                "bothBeforeReceipt": bool(same and (not receipt or max(pcm["serverMs"], tool["serverMs"]) < receipt["serverMs"])),
                "toolOnly": bool(result.get("calls") and not result.get("frames")),
                "browserEvidence": source,
                "contextMessages": context.get("messages"), "contextChars": context.get("contextChars"),
                "factsInPrompt": context.get("syntheticFactsPresent", []),
                "preparationMs": context.get("preparationMs"),
                "requestToPcmMs": delta(pcm.get("serverMs"), request.get("serverMs")),
                "validTurnToFinalAsrMs": delta(input_time("input_final"), input_time("speech_stopped")),
                "finalAsrToWaiMs": delta(started.get("serverMs"), input_time("input_final")),
                "inputEndToPlaybackMs": delta(trial.get("playbackAt"), (trial.get("input") or {}).get("lastSpeechAt")),
                "requestToPlaybackMs": delta(trial.get("playbackAt"), trial.get("requestAt")),
                "motionAfterPlaybackMs": delta(trial.get("motionAt"), trial.get("playbackAt")),
                "expressionAfterPlaybackMs": delta(trial.get("expressionAt"), trial.get("playbackAt")),
                "mouthAfterPlaybackMs": delta(trial.get("mouthAt"), trial.get("playbackAt")),
                "error": first("turn_error").get("code"),
                "deliveryRejected": bool(first("delivery_rejected")),
                "overlapInputAcks": sum(e["type"] == "input_ack" and e.get("replyActive")
                    and request.get("serverMs", float("inf")) <= e["serverMs"] <= first("response_done").get("serverMs", -1) for e in events)}
            rows.append(row)
            if observed:
                for interruption in observed["client"]["interruptions"]:
                    if interruption["turnId"] == turn["id"] and interruption not in interrupts:
                        interrupts.append(interruption)
    ledger = read(output / "ledger.json")
    protected = read(output / "preserved-before.json")
    preservation = {name: {"sha256": digest, "unchanged": hashlib.sha256((face_root/name).read_bytes()).hexdigest()==digest}
                    for name, digest in protected.items()}
    rows.sort(key=lambda r: ledger["turns"].index(r["turnId"]))
    successes = [r for r in rows if r["acknowledged"]]
    return {"experimental": True, "source": "actual_WAI_cloud_speech_and_browser_playback",
        "input": "local_synthetic_spoken_questions_streamed_at_original_speed", "syntheticMemory": True,
        "physicalAcousticsVerified": False, "autonomousTimersCameraNeo4j": False,
        "clockBoundary": "browser input last voiced sample and playback same clock; provider stages use server monotonic clock",
        "rows": rows, "cases": cases, "interruptions": interrupts,
        "counts": {"waiAttempts": len(rows), "acknowledged": len(successes), "toolOnly": sum(r["toolOnly"] for r in rows),
                   "cooutput": sum(r["sameResponseSpeechAndTool"] for r in rows)},
        "successfulTurnLatency": {k: distribution(r[k] for r in successes) for k in
            ("inputEndToPlaybackMs", "preparationMs", "requestToPcmMs", "requestToPlaybackMs", "motionAfterPlaybackMs", "expressionAfterPlaybackMs")},
        "usage": {"responseCount": sum(r["responseId"] is not None for r in ledger["responses"]),
                  "unknown": sum(r["state"] == "unknown" for r in ledger["responses"]),
                  "blocked": ledger["blocked"], "reasons": ledger["reasons"],
                  "reportedTokens": sum(r["usage"]["total_tokens"] for r in ledger["responses"] if r["state"]=="reported"),
                  "scope": "Qwen realtime only; WAI auxiliary models are additional"},
        "preservation": preservation, "allProtectedUnchanged": all(p["unchanged"] for p in preservation.values())}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--write", type=Path, required=True)
    args = parser.parse_args()
    result = build(args.output, Path(__file__).resolve().parents[2])
    metadata = args.output / "run-metadata.json"
    if metadata.is_file():
        extra = read(metadata)
        switch = extra.pop("promptSwitchAfterAttempt", 3)
        # Supplementary test receipts are explicitly supplied local evidence,
        # never inferred from a successful provider response.
        result.update(extra)
        for i, row in enumerate(result["rows"]):
            row["promptVariant"] = "initial" if i < switch else "speech_first"
    args.write.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"counts": result["counts"], "latency": result["successfulTurnLatency"],
                      "usage": result["usage"], "protected": result["allProtectedUnchanged"]}, ensure_ascii=False))
