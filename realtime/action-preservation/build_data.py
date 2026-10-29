"""Build a local comparison from existing model decisions; never calls a provider."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = "21288ee870b178d80c5b38eb060625d9ae1e5589"


def build(evidence, output):
    cases = []
    for name, focus, stop in [("short-03", 20, 30), ("short-08", 12, 25)]:
        directory = evidence / "cases" / name
        observation_file = directory / "campaign-observations.json"
        obs = json.loads(observation_file.read_text(encoding="utf-8-sig"))
        candidates = [(p, json.loads(p.read_text(encoding="utf-8-sig"))) for p in directory.glob("client-live-*.json")]
        client_file, client = max(candidates, key=lambda pair: len(pair[1]["events"]))
        origin = obs["recordingStartedAt"]
        trial = client["trials"][0]
        rows = client["center"]["body"]["rows"]
        commands = []
        for event in client["events"]:
            if event["type"] != "character_actions" or event.get("turnId") != trial["id"]:
                continue
            selected = [row for row in rows if row["owner"]["requestId"] == event["commandId"]]
            if not selected:
                raise ValueError(f"missing_original_queue_receipt:{name}:{event['commandId']}")
            commands.append({"command": event["command"], "owner": selected[0]["owner"],
                "acceptedAt": selected[0]["acceptedAt"], "videoSeconds": (event["browserAt"]-origin)/1000,
                "originalResults": [{k: row.get(k) for k in ("action", "index", "status", "reason", "admittedAt", "displayedAt", "completedAt")}
                                    for row in selected]})
        frames = [{"time": row["at"]/1000, "dt": min(.05, max(0, row["dt"]/1000)),
                   "videoSeconds": (row["at"]-origin)/1000}
                  for row in client["frames"] if (row["at"]-origin)/1000 <= stop]
        samples = [{"videoSeconds": (row["at"]-origin)/1000, "weights": row["face"]["weights"]}
                   for row in obs["samples"] if (row["at"]-origin)/1000 <= stop+1]
        cases.append({"id": name, "focus": focus, "stop": stop, "commands": commands, "frames": frames,
            "revocations": [{"videoSeconds": (e["browserAt"]-origin)/1000, "sourceKey": e.get("sourceKey"),
                             "turnId": e.get("turnId"), "reason": e.get("reason", "source_revoked")}
                            for e in client["events"] if e["type"] == "character_revoke"
                            and e.get("turnId") == trial["id"] and (e["browserAt"]-origin)/1000 <= stop],
            "faceSamples": samples, "turnId": trial["id"], "text": trial["text"], "reply": trial["transcript"],
            "audioStart": (trial["playbackAt"]-origin)/1000,
            "audioEnd": (trial["playbackEndedAt"]-origin)/1000,
            "audioDuration": trial["frames"]/24000,
            "originalVideo": f"/action-preservation/video/{name}.webm",
            "evidenceHashes": {"observations": hashlib.sha256(observation_file.read_bytes()).hexdigest(),
                               "client": hashlib.sha256(client_file.read_bytes()).hexdigest()},
            "originalTarget": "gesture:comfort" if name == "short-03" else "gesture:delighted",
            "targetCommandIndex": 3 if name == "short-03" else 1})
    output.mkdir(parents=True, exist_ok=True)
    data = {"experimental": True, "cloudCalls": 0, "baseline": BASELINE,
        "method": "Same recorded model commands, original source clock and recorded frame deltas. Old redundant revisions are deliberately replayed against both versions. No new model decision or fabricated continuation.",
        "limits": "First-turn control replay, not a new free conversation. Face weights are sampled, not phoneme-accurate. New execution differs from the original video; compare old renderer events with original receipts first.",
        "cases": cases}
    path = output / "comparison-data.json"
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"path": str(path), "cases": [{"id": c["id"], "commands": len(c["commands"]), "frames": len(c["frames"])} for c in cases]}))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--evidence", type=Path, default=ROOT/"outputs/character-campaign-simtime-20261027")
    p.add_argument("--output", type=Path, default=ROOT/"outputs/action-preservation-20261028")
    a = p.parse_args(); build(a.evidence, a.output)
