"""Prepare/resume one isolated campaign; never erase or retry a billed scene."""
import argparse
import asyncio
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def evidence_totals(roots):
    channels, states, tokens, pcm, unknown, seen = Counter(), Counter(), 0, 0, [], set()
    for root in roots:
        for path in Path(root).glob("**/ledger.json"):
            key = str(path.resolve()).casefold()
            if key in seen:
                continue
            seen.add(key)
            value = read(path)
            pcm += value.get("pcmBytes", 0) / 32000
            for row in value.get("responses", []):
                state = row.get("state")
                states[state] += 1
                if state != "unused":
                    channels[row.get("channel")] += 1
                tokens += (row.get("usage") or {}).get("total_tokens", 0) or 0
                if state in {"unknown", "reserved", "active"}:
                    unknown.append({"evidence": str(path.relative_to(ROOT)), "channel": row.get("channel"),
                        "state": state, "reason": row.get("unknownReason"), "terminalObserved": row.get("terminalObserved")})
    return {"channels": dict(channels), "states": dict(states), "reportedTokens": tokens,
        "pcmSeconds": round(pcm, 3), "retainedUnsettledRecords": unknown, "ledgers": len(seen)}


def prepare(out):
    if out.exists():
        raise RuntimeError("new_batch_directory_already_exists_never_overwrite")
    from manifest import build, write
    old = ROOT / "outputs/character-campaign-simtime-20261027"
    configuration = read(ROOT / "outputs/postvoice-interruption-20261029/launch.private.json")
    data_root = Path(configuration["data_root"]).parent / out.name
    if data_root.exists():
        raise RuntimeError("new_runtime_directory_already_exists")
    out.mkdir(parents=True)
    write(out / "manifest.json")
    hashes = {}
    for case in build()["scenarios"]:
        source = old / "cases" / case["id"] / "inputs"
        destination = out / "cases" / case["id"] / "inputs"
        shutil.copytree(source, destination)
        for file in source.iterdir():
            if file.is_file():
                assert digest(file) == digest(destination / file.name)
                hashes[str((destination / file.name).relative_to(out))] = digest(file)
    save(out / "input-hashes.json", hashes)
    configuration["data_root"] = str(data_root)
    save(out / "launch.private.json", configuration)
    subprocess.run([sys.executable, str(ROOT / "realtime/action-preservation-live/build-browser.py"),
        "--output", str(out), "--active-barge", "--postvoice-barge"], cwd=ROOT, check=True)
    # Capture exact sources, including locally present asset adapters, without
    # copying credentials, runtime stores, private textures or model packages.
    files = set()
    for folder in ("realtime", "preview/core", "preview/studio", "scripts/action-preparation"):
        files.update(p for p in (ROOT / folder).rglob("*") if p.is_file() and p.suffix in {".py", ".js", ".mjs", ".cjs", ".html", ".css"})
    frozen = {}
    for source in sorted(files):
        name = source.relative_to(ROOT).as_posix()
        target = out / "source-snapshot" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        frozen[name] = digest(source)
    wai_root = Path(configuration["wai_root"])
    for folder in (wai_root / "wai", wai_root / "tools/voice_avatar"):
        for source in folder.rglob("*.py"):
            name = Path(os.path.relpath(source, ROOT)).as_posix()
            target = out / "source-snapshot/WAI" / source.relative_to(wai_root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            frozen[name] = digest(source)
    save(out / "frozen-source.json", frozen)
    prior_roots = [ROOT / "outputs" / name for name in (
        "character-campaign-20261027", "character-campaign-simtime-20261027",
        "action-preservation-live-20261028", "action-preservation-live-20261029", "postvoice-interruption-20261029")]
    protected = read(ROOT / "outputs/postvoice-interruption-20261029/trajectory-protected-before.json")
    protected = {name: digest(ROOT / name) for name in protected}
    for folder in prior_roots:
        for file in folder.glob("**/ledger.json"):
            protected[file.relative_to(ROOT).as_posix()] = digest(file)
    save(out / "protected-before.json", protected)
    save(out / "prior-evidence-roots.json", [str(p.relative_to(ROOT)) for p in prior_roots])
    save(out / "prior-usage-retained.json", evidence_totals(prior_roots))
    save(out / "scope.json", {"batch": out.name, "authorizationDate": "2026-10-30",
        "totals": build()["totals"], "newIndependentAuthorization": True,
        "waitAcceleration": "up to 10x long idle scheduling only; hold during actual background model work",
        "audioAnimationAndCloudTiming": "real time", "fixedActions": False,
        "oldRecordsImmutable": True, "preservedSources": len(frozen), "preservedInputs": len(hashes)})
    (out / "RESULTS.md").write_text("# 新一轮大批量测试正在准备\n\n100场、180段输入、20项后台活动。成功、失败和用量未知全部保留。\n仅长间隔闲置排期最多10倍模拟；声音、动作、模型耗时原速。旧批结论不会显示成本批结果。\n", encoding="utf-8")
    print(json.dumps({"prepared": True, "scenarios": 100, "inputs": 180, "activities": 20, "frozenSources": len(frozen)}), flush=True)


def run(out):
    # OS lock survives neither process death nor reboot, and never erases evidence.
    import msvcrt
    lock = (out / "controller.lock").open("a+b")
    lock.seek(0); lock.write(b"1"); lock.flush(); lock.seek(0)
    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    configuration = read(out / "launch.private.json")
    spec = importlib.util.spec_from_file_location("campaign_provider_preflight", ROOT / "realtime/action-preservation-live/run.py")
    preflight = importlib.util.module_from_spec(spec); spec.loader.exec_module(preflight)
    preflight.OUT = out
    from run import http
    http("http://127.0.0.1:8765/health")
    asyncio.run(preflight.provider_preflight(configuration))
    argv = [sys.executable, "-u", str(HERE / "run.py"), "--output", str(out),
        "--data-root", configuration["data_root"], "--env-file", configuration["env_file"],
        "--wai-root", configuration["wai_root"], "--port", "18824", "--asset-port", "18821",
        "--multi-listener-limit", "20", "--browser-driver", str(out / "run-browser.generated.js"),
        "--browser-session", "character-campaign-rerun-20261030", "--frozen-source", str(out / "frozen-source.json")]
    if configuration["local_proxy"]:
        argv.append("--local-proxy")
    save(out / "resume-command.private.json", argv)
    save(out / "controller-process.json", {"pid": os.getpid(), "startedAt": time.time(), "headless": True, "port": 18824})
    code = subprocess.call(argv, cwd=ROOT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    from analyze import summarize
    from quality import audit
    save(out / "summary.json", summarize(out))
    save(out / "quality.json", audit(out))
    prior = [ROOT / p for p in read(out / "prior-evidence-roots.json")]
    save(out / "all-evidence-usage.json", evidence_totals([*prior, out]))
    protected = read(out / "protected-before.json")
    changed = [p for p,h in protected.items() if not (ROOT/p).is_file() or digest(ROOT/p) != h]
    save(out / "controller-completion.json", {"at": time.time(), "exitCode": code,
        "protectedFiles": len(protected), "changedProtectedFiles": changed,
        "sourceFrozen": len(read(out / "frozen-source.json")), "humanVisualReviewPending": True})
    state = read(out / "campaign-state.json")
    print(json.dumps({"controllerEnded": True, "status": state.get("status"), "attempted": len(state.get("cases", {})), "changedProtected": len(changed)}), flush=True)
    lock.close()
    return code


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prepare", action="store_true")
    args = parser.parse_args()
    if args.prepare:
        prepare(args.output.resolve())
    else:
        raise SystemExit(run(args.output.resolve()))
