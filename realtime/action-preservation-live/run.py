"""Only the two fresh, bounded live cases. Never retries a charged case."""
import importlib.util
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import psutil

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "outputs/action-preservation-live-20261028"
CAMPAIGN = ROOT / "realtime/character-campaign"
spec = importlib.util.spec_from_file_location("original_campaign_helpers", CAMPAIGN / "run.py")
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
read, save, http = helpers.read, helpers.save, helpers.http
PORT = 18822
SESSION = "action-preservation-live"


async def provider_preflight(config):
    """Existing provider's read-only authentication check, before any Qwen call."""
    sys.path.insert(0, config["wai_root"])
    sys.path.insert(0, str(ROOT / "realtime/character-center"))
    from deepseek_planner import DeepSeekConfig, DeepSeekPlannerConnection
    settings = DeepSeekConfig.from_file(config["env_file"],
        proxy="http://127.0.0.1:7890" if config["local_proxy"] else None)
    connection = DeepSeekPlannerConnection(config=settings)
    try:
        await connection.open()
        save(OUT / "latest-preflight.json", {"at": time.time(), "ready": True, "generationRequests": 0})
    except Exception as error:
        save(OUT / "latest-preflight.json", {"at": time.time(), "ready": False,
            "reason": type(error).__name__, "generationRequests": 0})
        raise RuntimeError("action_provider_preflight_failed_no_voice_started") from None
    finally:
        await connection.close()


def main():
    config = read(OUT / "launch.private.json")
    scope = read(OUT / "scope.json")
    assert scope["cases"] == ["short-03", "short-08"]
    asyncio.run(provider_preflight(config))
    state_path = OUT / "live-state.json"
    state = read(state_path, {"cases": {}, "startedAt": time.time(), "scope": scope["cases"]})
    cli = shutil.which("playwright-cli.cmd")
    if not cli:
        raise RuntimeError("playwright_missing")
    def browser(*args, timeout=120):
        return subprocess.run([cli, "-s=" + SESSION, *args], cwd=ROOT, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    url = f"http://127.0.0.1:{PORT}"
    try:
        http(url + "/api/duplex/status")
    except Exception:
        pass
    else:
        raise RuntimeError("test_port_occupied")
    for identity in scope["cases"]:
        if identity in state["cases"]:
            continue
        folder = OUT / "cases" / identity
        if (folder / "ledger.json").exists():
            raise RuntimeError("unregistered_ledger_never_retry")
        # Both cases have disjoint fixed limits, no capacity transfer or extra case.
        state["cases"][identity] = {"status": "attempted", "environment": helpers.environment()}
        state["current"] = identity
        save(state_path, state)
        command = [sys.executable, "-u", str(CAMPAIGN / "server.py"), "--manifest", str(OUT / "manifest.json"),
            "--case", identity, "--output", str(folder), "--data-dir", str(Path(config["data_root"]) / identity),
            "--env-file", config["env_file"], "--wai-root", config["wai_root"], "--port", str(PORT),
            "--asset-port", "18821", "--multi-listener-limit", "20"]
        if config["local_proxy"]:
            command.append("--local-proxy")
        stdout = (folder / "server-stdout.log").open("w", encoding="utf-8")
        stderr = (folder / "server-stderr.log").open("w", encoding="utf-8")
        process = subprocess.Popen(command, cwd=ROOT, stdout=stdout, stderr=stderr,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"}, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        state["cases"][identity]["pid"] = process.pid
        save(state_path, state)
        print(json.dumps({"case": identity, "event": "starting"}), flush=True)
        try:
            deadline = time.monotonic() + 100
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("server_exited_before_ready")
                try:
                    status = http(url + "/api/duplex/status")
                    if status["cloudEnabled"] and http(url + "/api/campaign/case")["id"] == identity:
                        assert status["budget"]["turns"] == 0
                        break
                except Exception:
                    pass
                time.sleep(.5)
            else:
                raise RuntimeError("server_start_timeout")
            browser("close", timeout=30)
            nav = browser("open", url + "/character-center/?live=" + identity,
                "--config=" + str(CAMPAIGN / "browser-config.json"))
            (folder / "browser-navigation.txt").write_text(nav.stdout + nav.stderr, encoding="utf-8")
            if nav.returncode:
                raise RuntimeError("browser_navigation_failed")
            started = browser("run-code", "--filename=" + str(OUT / "run-browser.generated.js"))
            (folder / "browser-start.txt").write_text(started.stdout + started.stderr, encoding="utf-8")
            if started.returncode or "### Error" in started.stdout:
                raise RuntimeError("browser_start_failed")
            deadline = time.monotonic() + 850
            last_phase = None
            while time.monotonic() < deadline:
                progress = read(folder / "progress.json", {})
                if progress.get("phase") != last_phase:
                    last_phase = progress.get("phase")
                    print(json.dumps({"case": identity, "phase": last_phase}), flush=True)
                if last_phase == "finished":
                    state["cases"][identity].update(status="finished", errors=progress.get("errors", []))
                    break
                if process.poll() is not None:
                    raise RuntimeError("server_exited_during_case")
                if progress and time.time() - progress.get("serverReceivedAt", 0) > 130:
                    raise RuntimeError("browser_progress_stalled")
                time.sleep(2)
            else:
                raise RuntimeError("case_deadline")
            shot = browser("screenshot", "--filename=" + str(folder / "preview-final.png"), timeout=30)
            state["cases"][identity]["screenshotSaved"] = shot.returncode == 0
        except Exception as error:
            state["cases"][identity].update(status="failed", error=type(error).__name__ + ":" + str(error))
            try:
                browser("run-code", "async page => await page.evaluate(async()=>{await window.characterCenter?.save();await window.characterCenter?.close();})", timeout=40)
            except Exception:
                pass
        finally:
            until = time.monotonic() + 45
            while time.monotonic() < until:
                ledger = read(folder / "ledger.json", {})
                if not any(r.get("state") in {"reserved", "active"} for r in ledger.get("responses", [])):
                    break
                time.sleep(1)
            try:
                save(folder / "final-server-status.json", http(url + "/api/duplex/status"))
            except Exception:
                pass
            browser("close", timeout=30)
            if process.poll() is None:
                try:
                    children = psutil.Process(process.pid).children(recursive=True)
                except psutil.NoSuchProcess:
                    children = []
                for child in reversed(children):
                    try:
                        child.terminate()
                    except psutil.NoSuchProcess:
                        pass
                psutil.wait_procs(children, timeout=5)
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
            stdout.close()
            stderr.close()
            state["cases"][identity].update(endedAt=time.time(), endingEnvironment=helpers.environment())
            save(state_path, state)
        print(json.dumps({"case": identity, **state["cases"][identity]}, ensure_ascii=False), flush=True)
        if state["cases"][identity]["status"] == "failed":
            break
    state.update(current=None, endedAt=time.time())
    save(state_path, state)


if __name__ == "__main__":
    main()
