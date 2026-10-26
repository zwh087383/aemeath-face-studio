"""Summarise saved observations without calls, retries, or changing evidence."""
import argparse
from collections import Counter
import json
from pathlib import Path
from statistics import median


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def summary(directory):
    directory = Path(directory)
    trials, actions, suites = {}, {}, []
    for path in sorted(directory.glob("client-live-*.json"), key=lambda p: p.stat().st_mtime):
        data = read(path)
        for trial in data.get("trials", []):
            trials[trial["id"]] = trial
        for row in data.get("center", {}).get("body", {}).get("rows", []):
            # Body row serials restart with each browser, so bind to source/turn.
            key = (row.get("owner", {}).get("sourceKey"), row.get("id"))
            actions[key] = row
        if data.get("suite"):
            suites.append(data["suite"])
    rows = []
    # Browser monotonic clocks restart on reload. Preserve first-seen order of
    # chronological report files rather than sorting cross-browser clocks.
    for t in trials.values():
        voice, method = t.get("voiceAt"), "owned_audio_context_marker"
        if voice is not None and voice < t.get("requestAt", 0):
            # Preserve a transparent approximate recovery for the first-browser
            # measurement bug. This is not promoted to a precise marker sample.
            voice = (t["playbackAt"] + t["firstVoicedFrame"] / 24
                     if t.get("playbackAt") is not None and t.get("firstVoicedFrame") is not None else None)
            method = "estimated_from_owner_checked_playback_frame_plus_voiced_offset"
        def elapsed(end, start):
            return round(end-start, 1) if isinstance(end, (float,int)) and isinstance(start, (float,int)) else None
        inp=t.get("input") or {}
        rows.append({"id":t["id"],"text":t.get("text"),"answer":t.get("transcript"),
            "status":"settled" if t.get("settledAt") is not None else "revoked" if t.get("revoked") else "failed" if t.get("error") else "unsettled",
            "error":t.get("error"),"measurement":method,"lastSpeechToVoiceMs":elapsed(voice,inp.get("lastSpeechAt")),
            "lastSpeechToAdmissionMs":elapsed(t.get("startedAt"),inp.get("lastSpeechAt")),
            "admissionToContextMs":elapsed(t.get("contextReadyAt"),t.get("startedAt")),
            "contextToRequestMs":elapsed(t.get("requestAt"),t.get("contextReadyAt")),
            "requestToVoiceMs":elapsed(voice,t.get("requestAt")),
            "commandLeadMs":elapsed(voice,t.get("firstActionAt")),
            "bodyStartLeadMs":elapsed(voice,t.get("bodyStartedAt")),
            "faceTargetLeadMs":elapsed(voice,t.get("faceAppliedAt")),
            "firstBodyAction":t.get("firstBodyAction")})
    exact=[r["lastSpeechToVoiceMs"] for r in rows if r["measurement"]=="owned_audio_context_marker" and r["lastSpeechToVoiceMs"] is not None]
    return {"experimental":True,"physicalSpeakerMeasurement":False,
        "turns":rows,"exactFirstVoice":{"count":len(exact),"medianMs":median(exact) if exact else None},
        "actions":[{"action":r["action"],"status":r["status"],"reason":r.get("reason"),"owner":r.get("owner")} for r in actions.values()],
        "actionCounts":dict(Counter(r["action"] for r in actions.values())),
        "latestSuite":suites[-1] if suites else None,
        "ledger":read(directory/"ledger.json"),
        "measurementLimit":"Marker repair retains original reports; reconstructed rows are estimates. First visible changes are thresholds, not motion capture or an aesthetic score."}


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory",type=Path)
    args=parser.parse_args()
    result=summary(args.directory)
    target=args.directory/"summary.json"
    target.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"saved":str(target),"turns":len(result["turns"]),"exactFirstVoice":result["exactFirstVoice"]},ensure_ascii=False))
