"""Prepare two independent live cases from original user fixtures; no cloud calls."""
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
OLD = ROOT / "outputs/character-campaign-simtime-20261027"
OUT = ROOT / "outputs/action-preservation-live-20261028"
CASES = ("short-03", "short-08")


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if (OUT / "manifest.json").exists():
        raise RuntimeError("prepared_batch_exists_do_not_overwrite")
    prior = read(OLD / "resume-controller-command-2.private.json")
    def option(flag):
        return prior[prior.index(flag) + 1]
    data_root = Path(option("--data-root")).parent / OUT.name
    if data_root.exists():
        raise RuntimeError("isolated_runtime_already_exists")
    manifest = read(OLD / "manifest.json")
    for spec in manifest["scenarios"]:
        if spec["id"] == "short-08":
            spec["interruptions"] = [{"beforeTurn": 2, "voiceAgeMs": 900}]
    save(OUT / "manifest.json", manifest)  # existing server validates original full schema
    fixtures = {}
    for identity in CASES:
        destination = OUT / "cases" / identity / "inputs"
        shutil.copytree(OLD / "cases" / identity / "inputs", destination)
        for path in destination.rglob("*"):
            if path.is_file():
                old = OLD / "cases" / identity / "inputs" / path.relative_to(destination)
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                assert digest == hashlib.sha256(old.read_bytes()).hexdigest()
                fixtures[str(path.relative_to(OUT))] = digest
    protected = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                 for name in read(ROOT / "outputs/action-preservation-20261028/protected-before.json")}
    for path in (ROOT / "realtime/character-center").iterdir():
        if path.is_file():
            protected[path.relative_to(ROOT).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    for path in (ROOT / "outputs").glob("**/ledger.json"):
        protected[path.relative_to(ROOT).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    save(OUT / "protected-before.json", protected)
    save(OUT / "launch.private.json", {"env_file": option("--env-file"), "wai_root": option("--wai-root"),
        "data_root": str(data_root), "local_proxy": "--local-proxy" in prior})
    save(OUT / "scope.json", {"cases": list(CASES), "plannedInputs": 10,
        "channelLimits": {"listener": 40, "voice": 14, "action": 80, "background": 100},
        "responseLimit": 234, "pcmSeconds": 360, "fixtureHashes": fixtures,
        "differenceFromOriginal": "short-08 third input also barges during speech; final 15 seconds observes autonomous continuations",
        "manualActionCommands": False, "futureAnswerProvided": False,
        "unknownUsage": manifest["policy"]["unknownUsage"],
        "observation": "real cloud voice/actions, synthesized user PCM, headless digital WebAudio and actual pose frames; no physical microphone/speaker claim"})
    print(json.dumps({"preparedCases": list(CASES), "inputFiles": len(fixtures), "protectedFiles": len(protected), "responsesCeiling": 234}))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUT)
    OUT = parser.parse_args().output.resolve()
    main()
