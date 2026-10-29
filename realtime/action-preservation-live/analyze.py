"""Offline live evidence analysis, including failed providers and untested items."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "outputs/action-preservation-live-20261028"


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def stats(values):
    values = [v for v in values if isinstance(v, (int, float))]
    return {"n": len(values), "median": round(statistics.median(values), 2),
            "min": round(min(values), 2), "max": round(max(values), 2)} if values else {"n": 0}


def analyze_case(folder):
    path = folder / "campaign-observations.json"
    if not path.exists():
        return {"case": folder.name, "status": "not_run"}
    data = read(path)
    probe = data["liveProbe"]
    client = read(max(folder.glob("client-live-*.json"), key=lambda p: p.stat().st_mtime_ns))
    events = client["events"]
    ledger = read(folder / "ledger.json")
    interruptions = []
    for event in probe["clientEvents"]:
        if event["type"] != "provisional_pause" or event["reason"] != "local_voice_activity":
            continue
        sent = [r for r in probe["inputs"] if r["accepted"] and r["rms"] > .015
                and r["at"] <= event["wallMs"] and r["previousTurnId"] == event["turnId"]]
        onset = sent[-1]
        frame = next((f for f in probe["frames"] if f[0] >= onset["at"] and f[2] and f[4] == 0), None)
        cancellation = next((e for e in probe["clientEvents"] if e["type"] == "cancel"
                             and e.get("turnId") == event["turnId"] and e["wallMs"] >= event["wallMs"]), None)
        previous = next((f for f in reversed(probe["frames"]) if f[0] < onset["at"]), None)
        frozen = [f for f in probe["frames"] if frame and frame[0] <= f[0] < frame[0] + 100]
        posture_frozen = bool(previous and frozen and all(f[6] == previous[6] for f in frozen))
        interruptions.append({
            "from": "first audible PCM packet admitted into original client",
            "inputPacketMs": 100,
            "localSourceClearMs": round(event["wallMs"] - onset["at"], 3),
            "firstPausedRenderFrameMs": round(frame[0] - onset["at"], 3) if frame else None,
            "poseUnchangedDuringFirst100ms": posture_frozen,
            "formalRevocationMs": round(cancellation["at"] - onset["at"], 3) if cancellation else None,
            "sourcesBefore": event["sourceBefore"], "sourcesAfter": event["sourceAfter"],
            "activeActionBefore": onset["bodyBefore"], "actionStopLatencyMs": None,
            "audioSilenceMeasuredMs": None,
            "limitations": ["No active model-selected action: pose pause is not an action-stop measurement.",
                "Initial output meter omitted disconnected-input silence blocks; no exact output-silence claim.",
                "No physical microphone, device packet capture, or speaker loopback."]})
    turns = data["finalTurns"]
    actions = [e for e in events if e["type"] == "character_actions"]
    return {"case": folder.name, "status": "action_provider_unavailable" if not actions else "measured",
        "inputFixtures": len(data["finalInputs"]), "responsesWithVoice": sum(t["metrics"].get("lastSpeechToVoiceMs") is not None for t in turns),
        "lastSpeechToFirstVoiceMs": stats([t["metrics"].get("lastSpeechToVoiceMs") for t in turns]),
        "requestToFirstVoiceMs": stats([t["metrics"].get("requestToVoiceMs") for t in turns]),
        "actionCommands": len(actions), "actionProviderRequests": sum(e["type"] == "character_semantic_request" for e in events),
        "actionSkippedReasons": dict(Counter(e.get("reason") for e in events if e["type"] == "character_semantic_skipped")),
        "autonomousContinuation": "not_tested_provider_authentication_failed" if not actions else "inspect_live_events",
        "interruptions": interruptions,
        "historySettled": sum(bool(t.get("historySettled")) for t in turns),
        "revokedAndHistorySettled": sum(bool(t.get("revoked") and t.get("historySettled")) for t in turns),
        "renderFrames": len(probe["frames"]), "audioBlocks": len(probe["audioBlocks"]),
        "observationErrors": probe["errors"], "browserErrors": data["errors"],
        "usage": {"channels": dict(Counter(r["channel"] for r in ledger["responses"] if r["state"] != "unused")),
            "states": dict(Counter(r["state"] for r in ledger["responses"])),
            "reportedTokens": sum((r.get("usage") or {}).get("total_tokens", 0) for r in ledger["responses"]),
            "unknown": [{"channel": r["channel"], "reason": r.get("unknownReason"), "terminalObserved": r["terminalObserved"]}
                        for r in ledger["responses"] if r["state"] == "unknown"],
            "frozenChannels": ledger["frozenChannels"], "pcmSeconds": ledger["pcmBytes"] / 32000}}


def main():
    old = read(OUT / "protected-before.json")
    changed = [name for name, digest in old.items()
               if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest]
    assert not changed, "protected_source_or_old_ledger_changed"
    result = {"experimental": True, "date": "2026-10-28", "status": "blocked_on_deepseek_authentication",
        "baseline": "5bb2fa8c4f2a6d8175abe5d336c9f2e1c50c6b00", "protectedFilesUnchanged": len(old),
        "providerPreflight": read(OUT / "provider-preflight.json"),
        "cases": [analyze_case(OUT / "cases" / name) for name in ("short-03", "short-08")],
        "manualActions": False, "physicalAudioAcceptance": False}
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    (OUT / "summary.json").write_text(encoded, encoding="utf-8")
    (Path(__file__).parent / "RESULTS.json").write_text(encoded, encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
