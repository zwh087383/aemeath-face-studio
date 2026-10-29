"""Offline comparison of real post-voice interruption and planner media evidence."""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("live_analysis", ROOT / "realtime/action-preservation-live/analyze-resumed.py")
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


def summarize(folder):
    result = live.analyze_case(folder)
    files = list(folder.glob("client-live-*.json"))
    if not files:
        return result
    client = live.read(max(files, key=lambda p: p.stat().st_mtime_ns))
    events = client["events"]
    requests = {e["requestId"]: e for e in events if e["type"] == "character_semantic_request"}
    decisions = []
    for event in events:
        if event["type"] != "character_actions":
            continue
        request = requests.get(event.get("requestId"), {})
        voice = request.get("voicePlayback", {})
        actions = event.get("command", {}).get("actions", [])
        decisions.append({"requestId": event.get("requestId"), "modelInputPlayback": voice,
            "requestAtMs": request.get("browserAt"), "decisionAtMs": event.get("browserAt"),
            "operation": event.get("command", {}).get("operation"), "actions": actions,
            "selectedVoiceAgainstInput": voice.get("can_anchor_voice") is False and any(a.get("anchor") == "voice" for a in actions)})
    result["modelPlaybackEvidence"] = {
        "requests": len(requests),
        "states": dict(Counter(e.get("voicePlayback", {}).get("state", "missing") for e in requests.values())),
        "requestsMissingEvidence": sum("voicePlayback" not in e for e in requests.values()),
        "commandsSelectingUnavailableVoice": sum(d["selectedVoiceAgainstInput"] for d in decisions),
        "decisions": decisions,
        "rejectedBrowserReports": dict(Counter(e.get("reason") for e in events if e["type"] == "character_playback_state_rejected")),
    }
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "outputs/postvoice-interruption-20261029")
    args = parser.parse_args()
    out = args.output.resolve()
    result = {"experimental": True, "manualActionCommands": False,
        "baselineReport": "realtime/action-preservation-live/RETEST-20261029.json",
        "cases": [summarize(out / "cases" / name) for name in ("short-03", "short-08")],
        "scope": live.read(out / "scope.json"),
        "limits": ["Digital audio and sampled bones only, not physical acoustic latency.",
                   "Free model outputs differ between runs; timing comparisons are observational, not controlled causal estimates.",
                   "Request-time availability can change while a model generates; do not silently re-anchor its selected action."]}
    (out / "postvoice-analysis.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"cases": [{"case": c["case"], "status": c["status"],
        "bodyOnlyInputs": len(c.get("bodyOnlyInputResponses", [])), "modelPlayback": c.get("modelPlaybackEvidence", {}).get("states")}
        for c in result["cases"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
