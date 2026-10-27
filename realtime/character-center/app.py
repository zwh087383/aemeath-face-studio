"""Isolated continuous-character experiment; cloud disabled unless explicit."""
from __future__ import annotations
import argparse
import asyncio
import base64
import importlib.util
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from uuid import uuid4
from aiohttp import web, WSMsgType, ClientSession

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def create_app(runtime, main, budget, output, *, cloud=False, asset_port=18809, session_class=None, factory=None):
    legacy = load("center_static_guard", ROOT / "realtime/qwen/server.py")
    from tools.voice_avatar.bootstrap import evidence_snapshot, wait_quiescent
    from tools.voice_avatar.duplex_transport import save_json, ProtocolError
    output = Path(output)
    app = web.Application(client_max_size=32*1024*1024)
    active, sockets, notifications = set(), set(), set()
    activity = None

    def allow(request, mutation=False):
        if not legacy.allowed_request(request, require_origin=mutation):
            raise web.HTTPForbidden(text="Invalid loopback origin")

    async def publish(event):
        for session, ws in tuple(sockets):
            if not ws.closed:
                await ws.send_json({"connectionId": session.id, **event})

    def background(coro):
        task = asyncio.create_task(coro)
        notifications.add(task)
        task.add_done_callback(notifications.discard)
        return task

    if runtime is not None:
        from activity import ReadingActivities
        activity = ReadingActivities(main, output, publish, allow_existing_proxy=factory is not None, budget=budget)

    async def status(request):
        allow(request)
        return web.json_response({"experimentId": budget.data["experimentId"], "experimental": True,
            "cloudEnabled": cloud, "connected": bool(active), "budget": budget.snapshot(),
            "memory": "actual_WAI_isolated" if runtime else "local_component_preview",
            "plannerKnowsFutureAnswer": False, "activity": await asyncio.to_thread(activity.snapshot) if activity else None,
            "cases": activity.records if activity else {}, "savedSessions": [p.stem for p in sorted(output.glob("duplex-*.json"))],
            "savedReports": [p.name for p in sorted(output.glob("client-*.json"))],
            "savedVideos": [p.name for p in sorted(output.glob("preview-*.webm"))]}, headers={"Cache-Control": "no-store"})

    async def evidence(request):
        allow(request)
        value = await asyncio.to_thread(evidence_snapshot, main, runtime) if runtime else {"runtimeStarted": False}
        return web.json_response(value)

    async def drain(request):
        allow(request, True)
        return web.json_response(await asyncio.to_thread(wait_quiescent, main, runtime, timeout=25) if runtime else {})

    async def socket(request):
        allow(request, True)
        if not cloud or active or not budget.available("listener"):
            raise web.HTTPConflict(text="Cloud disabled, busy, or listener admission exhausted")
        ws = web.WebSocketResponse(max_msg_size=100000, heartbeat=15)
        async def emit(event):
            await ws.send_json(event)
            if activity and event.get("type") in {"speech_started", "speech_stopped", "turn_started", "settled", "revoked", "turn_error", "closed"}:
                background(activity.on_event(event))
        session = session_class(runtime, main, budget, output, emit, mode="smart_turn", prewarm_policy="after_request", factory=factory,
                                activity_validator=activity.valid if activity else None,
                                activity_context_provider=activity.voice_context if activity else None,
                                activity_context_validator=activity.voice_context_valid if activity else None)
        active.add(session)
        try:
            await ws.prepare(request)
            sockets.add((session, ws))
            await session.open()
            if activity:
                await activity.attach(session)
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                command = json.loads(message.data)
                if not isinstance(command, dict):
                    raise ProtocolError("invalid_command")
                kind = command.get("type")
                if kind == "audio":
                    pcm = base64.b64decode(command.get("pcm", ""), validate=True)
                    await budget.acall("account_pcm", len(pcm))
                    await session.input(command)
                elif kind == "text":
                    await session.submit(command.get("text"))
                elif kind == "actor_state":
                    await session.actor_state(command)
                elif kind == "playback_receipt":
                    await session.playback_receipt(command)
                elif kind == "action_receipt":
                    session.spawn(session.receive_action_receipt(command))
                elif kind == "listener_resume":
                    await session.resume_listener()
                elif kind == "cancel":
                    await session.cancel("explicit_user_interrupt", command.get("turnId"))
                elif kind == "playback_complete":
                    await session.acknowledge(command)
                elif kind == "close":
                    break
                else:
                    raise ProtocolError("unsupported_client_command")
        except Exception as exc:
            await session.fail(str(exc) if isinstance(exc, ProtocolError) else "bridge_error:" + type(exc).__name__)
        finally:
            if activity and activity.session is session:
                activity.session = None
            await session.close()
            active.discard(session)
            sockets.discard((session, ws))
            await ws.close()
        return ws

    async def activity_command(request):
        allow(request, True)
        if not activity or not active:
            raise web.HTTPConflict(text="Connect bounded real session first")
        command = await request.json()
        try:
            if command.get("operation") == "start":
                result = await activity.start(command.get("caseId"))
            elif command.get("operation") == "revoke":
                result = await activity.revoke()
            else:
                raise ValueError("unsupported_activity_operation")
            return web.json_response(result)
        except (ValueError, RuntimeError) as exc:
            raise web.HTTPConflict(text=str(exc))

    async def initial_state(request):
        allow(request, True)
        if not cloud or not active:
            raise web.HTTPConflict(text="A bounded connected experiment is required")
        if any(s.current_turn and not s.current_turn.get("acknowledged") and not s.current_turn["cancel"].is_set() for s in active):
            raise web.HTTPConflict(text="Wait until the current reply is settled")
        from initial_state import initialise_math
        try:
            return web.json_response(await asyncio.to_thread(initialise_math, main, output, (await request.json()).get("fixtureId")))
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc))

    async def input_manifest(request):
        allow(request)
        return web.FileResponse(output / "inputs/input-fixtures.json")

    async def user_input(request):
        allow(request)
        name = request.match_info["name"]
        manifest = json.loads((output / "inputs/input-fixtures.json").read_text(encoding="utf-8-sig"))
        if name not in {row["id"] + ".wav" for row in manifest["clips"]}:
            raise web.HTTPNotFound()
        return web.FileResponse(output / "inputs" / name)

    async def saved(request):
        allow(request)
        name = request.match_info["name"]
        if not re.fullmatch(r"(?:duplex-|client-|preview-)[A-Za-z0-9_.-]+\.(json|wav|webm|png)", name):
            raise web.HTTPNotFound()
        if not (output / name).is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(output / name, headers={"Cache-Control": "no-store"})

    async def report(request):
        allow(request, True)
        data = await request.json()
        if not isinstance(data, dict) or data.get("mode") not in {"live", "replay", "component"}:
            raise web.HTTPBadRequest(text="Explicit measurement mode required")
        name = "client-" + data["mode"] + "-" + uuid4().hex + ".json"
        await asyncio.to_thread(save_json, output / name, data)
        return web.json_response({"saved": True, "name": name})

    async def static(request):
        allow(request)
        if request.path == "/":
            raise web.HTTPFound("/character-center/")
        if request.path == "/realtime/character-center/face-profiles.mjs":
            return web.FileResponse(ROOT / "realtime/character-center/face-profiles.mjs", headers={"Content-Type": "text/javascript", "Cache-Control": "no-store"})
        # Fixed loopback helper retains source fingerprints and private-asset allowlists.
        async with ClientSession() as client:
            async with client.get(f"http://127.0.0.1:{asset_port}" + str(request.rel_url), allow_redirects=False) as response:
                return web.Response(body=await response.read(), status=response.status,
                    headers={"Content-Type": response.headers.get("Content-Type", "application/octet-stream"), "Cache-Control": "no-store"})

    app.router.add_get("/api/duplex/status", status)
    app.router.add_get("/api/duplex/evidence", evidence)
    app.router.add_post("/api/duplex/drain", drain)
    app.router.add_get("/api/duplex", socket)
    app.router.add_post("/api/character-center/activity", activity_command)
    app.router.add_post("/api/character-center/initial-state", initial_state)
    app.router.add_get("/api/parallel-duplex/input-manifest", input_manifest)
    app.router.add_get("/parallel-duplex-inputs/{name}", user_input)
    app.router.add_get("/duplex-data/{name}", saved)
    app.router.add_post("/api/parallel-duplex/report", report)
    app.router.add_get("/{path:.*}", static)

    async def shutdown(_):
        if activity:
            await activity.close()
        await asyncio.gather(*(s.close() for s in tuple(active)), return_exceptions=True)
        await asyncio.gather(*notifications, return_exceptions=True)
        if runtime:
            await asyncio.to_thread(runtime.stop)
    app.on_shutdown.append(shutdown)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wai-root", type=Path, required=True)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--port", type=int, default=18808)
    parser.add_argument("--asset-port", type=int, default=18809)
    parser.add_argument("--enable-cloud", action="store_true")
    parser.add_argument("--turn-limit", type=int, default=12)
    parser.add_argument("--listener-limit", type=int, default=18)
    parser.add_argument("--voice-limit", type=int, default=30)
    parser.add_argument("--action-limit", type=int, default=60)
    parser.add_argument("--background-limit", type=int, default=120)
    parser.add_argument("--pcm-seconds", type=int, default=480)
    parser.add_argument("--local-proxy", action="store_true")
    parser.add_argument("--resume-source", type=Path)
    parser.add_argument("--resume-state", type=Path)
    parser.add_argument("--resume-evidence", type=Path)
    parser.add_argument("--resume-status", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.wai_root.resolve()))
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    runtime = module = factory = session_class = None
    if args.enable_cloud:
        if not args.env_file or not args.data_dir:
            parser.error("Cloud mode requires isolated environment and data directory")
        from tools.voice_avatar.bootstrap import configure, bootstrap_runtime
        recovery = None
        if args.resume_source:
            if not all((args.resume_state,args.resume_evidence,args.resume_status)):
                parser.error("Resume requires prior process, runtime evidence, and status receipts")
            import psutil
            from resume import validate_source, restore_snapshot, bootstrap_resumed
            recovery = validate_source(args.resume_source.resolve(), args.output,
                process_alive=psutil.pid_exists, state_path=args.resume_state.resolve(),
                evidence_path=args.resume_evidence.resolve(), status_path=args.resume_status.resolve())
        config = configure(args.env_file.resolve(), args.data_dir.resolve(), batch_id="continuous-character-center-20261025")
        if recovery:
            recovery = restore_snapshot(args.resume_source.resolve(), config, recovery, process_alive=psutil.pid_exists)
        import os
        os.environ.update(WAI_LIFE_THREADS="1", WAI_PREPARATION_PROBE="1", WAI_LATENCY_BATCH1="1", WAI_REPLY_PREWARM_POLICY="after_request")
        from budget import CenterBudget
        budget = CenterBudget(args.output / "ledger.json", max_turns=args.turn_limit,
            limits={"listener":args.listener_limit,"voice":args.voice_limit,
                    "action":args.action_limit,"background":args.background_limit}, pcm_seconds=args.pcm_seconds)
        from provider_accounting import install_accounting
        install_accounting(budget)
        runtime, module = (bootstrap_resumed(config, recovery, process_alive=psutil.pid_exists)
                           if recovery else bootstrap_runtime(config))
        from tools.voice_avatar.duplex_transport import save_json
        if recovery:
            save_json(args.output / ("resume-receipt-" + uuid4().hex + ".json"), recovery)
        import hashlib
        paths = sorted(Path(__file__).parent.glob("*"))
        save_json(args.output / ("source-manifest-" + uuid4().hex + ".json"), {
            "experimental": True, "dataDirectory": str(config.data_dir), "initialConditions": "four_explicit_math_fixtures",
            "sourceHashes": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in paths if p.is_file() and p.suffix in {".py", ".mjs", ".html", ".css", ".json"}}})
        from backend import CharacterCenterSession
        session_class = CharacterCenterSession
        if args.local_proxy:
            factory = load("center_proxy_transport", ROOT / "realtime/parallel-duplex/app.py").existing_local_proxy_socket
    else:
        class LocalBudget:
            data = {"experimentId": "continuous-character-center-20261025", "blocked": False}
            def snapshot(self):
                return {"turns": 0, "turnLimit": 0, "responses": 0, "responseLimit": 0, "unknown": 0, "blocked": False}
        budget = LocalBudget()
    web.run_app(create_app(runtime, module, budget, args.output, cloud=args.enable_cloud, asset_port=args.asset_port,
                           session_class=session_class, factory=factory), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
