"""Experimental P + real WAI duplex, isolated state and explicit cloud admission."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from uuid import uuid4

from aiohttp import web, WSMsgType, ClientSession, ClientTimeout

FACE_ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("parallel_face_static", FACE_ROOT / "realtime/qwen/server.py")
legacy = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = legacy
SPEC.loader.exec_module(legacy)
EXPERIMENT = "parallel-duplex-director-20261024"


def create_app(runtime, main, budget, output, *, mode="smart_turn", cloud=False, session_class=None, factory=None, recovery=None):
    if session_class is None:
        from backend import ParallelDuplexSession
        session_class = ParallelDuplexSession
    from tools.voice_avatar.bootstrap import evidence_snapshot, wait_quiescent
    app = web.Application(client_max_size=32 * 1024 * 1024)
    app[legacy.APP_STATE] = SimpleNamespace(root=FACE_ROOT)
    active = set()
    output = Path(output)

    def allow(request, mutation=False):
        if not legacy.allowed_request(request, require_origin=mutation):
            raise web.HTTPForbidden(text="Invalid loopback origin")

    async def status(request):
        allow(request)
        return web.json_response({"experimental": True, "experimentId": EXPERIMENT,
            "mode": mode, "cloudEnabled": cloud, "budget": budget.snapshot(),
            "variants": ["qwen-direct"], "actionMode": "parallel", "connected": bool(active),
            "model": "qwen-audio-3.1-realtime-plus", "memory": "actual_WAI_with_isolated_synthetic_state",
            "plannerKnowsFutureAnswer": False,
            "completedFixtures": (recovery or {}).get("completedFixtures", []),
            "savedSessions": [p.stem for p in sorted(output.glob("duplex-*.json"))],
            "savedReports": [p.name for p in sorted(output.glob("client-*.json"))]},
            headers={"Cache-Control": "no-store"})

    async def evidence(request):
        allow(request)
        result = await asyncio.to_thread(evidence_snapshot, main, runtime)
        return web.json_response(result, headers={"Cache-Control": "no-store"})

    async def drain(request):
        allow(request, True)
        result = await asyncio.to_thread(wait_quiescent, main, runtime, timeout=25)
        return web.json_response(result, headers={"Cache-Control": "no-store"})

    async def socket(request):
        allow(request, True)
        if not cloud or active or budget.data["blocked"]:
            raise web.HTTPConflict(text="Cloud disabled, busy or usage blocked")
        if request.query.get("variant", "qwen-direct") != "qwen-direct":
            raise web.HTTPBadRequest(text="Unsupported variant")
        ws = web.WebSocketResponse(max_msg_size=100_000, heartbeat=15)
        session = session_class(runtime, main, budget, output, ws.send_json,
                                mode=mode, prewarm_policy="after_request", factory=factory)
        active.add(session)
        try:
            await ws.prepare(request)
            await session.open()
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                command = json.loads(message.data)
                if not isinstance(command, dict):
                    raise ValueError("invalid_command")
                kind = command.get("type")
                if kind == "audio":
                    await session.input(command)
                elif kind == "text":
                    await session.submit(command.get("text"))
                elif kind == "actor_state":
                    await session.actor_state(command)
                elif kind == "cancel":
                    await session.cancel("explicit_user_interrupt", command.get("turnId"))
                elif kind == "playback_complete":
                    await session.acknowledge(command)
                elif kind == "close":
                    break
                else:
                    raise ValueError("unsupported_client_command")
        except Exception as exc:
            from tools.voice_avatar.duplex_transport import ProtocolError
            await session.fail(str(exc) if isinstance(exc, ProtocolError) else "bridge_error")
        finally:
            await session.close()
            active.discard(session)
            await ws.close()
        return ws

    async def input_manifest(request):
        allow(request)
        return web.FileResponse(output / "inputs/input-fixtures.json", headers={"Cache-Control": "no-store"})

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
        if not re.fullmatch(r"[A-Za-z0-9_.-]+\.(json|wav|webm|png)", name) or name == "ledger.json":
            raise web.HTTPNotFound()
        if not (output / name).is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(output / name, headers={"Cache-Control": "no-store"})

    async def report(request):
        allow(request, True)
        data = await request.json()
        if not isinstance(data, dict) or data.get("mode") not in {"live", "replay"}:
            raise web.HTTPBadRequest(text="Explicit measurement mode required")
        name = "client-" + data["mode"] + "-" + uuid4().hex + ".json"
        def write():
            with (output / name).open("x", encoding="utf-8") as stream:
                json.dump(data, stream, ensure_ascii=False, indent=2)
        await asyncio.to_thread(write)
        return web.json_response({"saved": True, "name": name})

    async def root(request):
        raise web.HTTPFound("/parallel-duplex/")

    app.router.add_get("/", root)
    app.router.add_get("/api/duplex/status", status)
    app.router.add_get("/api/duplex/evidence", evidence)
    app.router.add_post("/api/duplex/drain", drain)
    app.router.add_get("/api/duplex", socket)
    app.router.add_get("/api/parallel-duplex/input-manifest", input_manifest)
    app.router.add_post("/api/parallel-duplex/report", report)
    app.router.add_get("/parallel-duplex-inputs/{name}", user_input)
    app.router.add_get("/duplex-data/{name}", saved)
    app.router.add_get("/{path:.*}", legacy.static_handler)

    async def shutdown(_):
        await asyncio.gather(*(s.close() for s in list(active)), return_exceptions=True)
        await asyncio.to_thread(runtime.stop)
    app.on_shutdown.append(shutdown)
    return app


async def existing_local_proxy_socket():
    """Use the existing proxy without changing system settings or credentials."""
    from tools.voice_avatar.duplex_transport import ProtocolError, MODEL
    key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    workspace = os.environ.get("DASHSCOPE_WORKSPACE_ID", "").strip()
    if not key or (workspace and not re.fullmatch(r"[A-Za-z0-9-]+", workspace)):
        raise ProtocolError("provider_configuration_invalid")
    endpoint = (f"wss://{workspace}.workspace.beijing.maas.aliyuncs.com/api-ws/v1/realtime"
                if workspace else "wss://dashscope.aliyuncs.com/api-ws/v1/realtime")
    client = ClientSession(timeout=ClientTimeout(total=None, connect=15), trust_env=False)
    try:
        socket = await client.ws_connect(endpoint + "?model=" + MODEL,
            headers={"Authorization": "Bearer " + key}, proxy="http://127.0.0.1:7890", max_msg_size=2*1024*1024)
    except BaseException:
        await client.close()
        raise

    class OwnedSocket:
        async def send_json(self, event):
            return await socket.send_json(event)

        async def receive(self):
            return await socket.receive()

        async def close(self):
            try:
                await socket.close()
            finally:
                await client.close()
    return OwnedSocket()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wai-root", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--port", type=int, default=18803)
    parser.add_argument("--enable-cloud", action="store_true")
    parser.add_argument("--local-proxy", action="store_true")
    parser.add_argument("--resume-from", type=Path, help="Explicit stopped synthetic runtime to copy; keeps the same output ledger")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Invalid port")
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(args.wai_root.resolve()))
    os.environ["WAI_PREPARATION_PROBE"] = "1"
    os.environ["WAI_LATENCY_BATCH1"] = "1"
    os.environ["WAI_REPLY_PREWARM_POLICY"] = "after_request"
    from tools.voice_avatar.bootstrap import configure, bootstrap_runtime
    from tools.voice_avatar.duplex_transport import save_json
    from backend import ParallelBudget, ParallelDuplexSession
    recovery = None
    if args.resume_from:
        import psutil
        from resume import validate_source, restore_snapshot
        recovery = validate_source(args.resume_from, args.output, process_alive=psutil.pid_exists)
    budget = ParallelBudget(args.output / "ledger.json", max_turns=6, max_responses=24)
    config = configure(args.env_file, args.data_dir, batch_id=EXPERIMENT)
    if recovery:
        restore_snapshot(args.resume_from, config, recovery)
    if args.local_proxy:
        os.environ["HTTP_PROXY"] = "http://127.0.0.1:7890"
        os.environ["HTTPS_PROXY"] = "http://127.0.0.1:7890"
        os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    runtime, wai_main = bootstrap_runtime(config, seed=not bool(recovery))
    if recovery:
        save_json(args.output / ("resume-" + uuid4().hex + ".json"), recovery)
        save_json(args.output / "server-state.json", {"pid": os.getpid(), "port": args.port, "batch": EXPERIMENT})
    # Preserve private traceback evidence for failures otherwise normalized by the runtime.
    original_process_turn = runtime.adapter.process_turn
    def diagnosed_process_turn(*a, **kw):
        try:
            return original_process_turn(*a, **kw)
        except Exception:
            import traceback
            (args.output / ("runtime-error-" + uuid4().hex + ".txt")).write_text(traceback.format_exc(), encoding="utf-8")
            raise
    runtime.adapter.process_turn = diagnosed_process_turn
    sources = [p for p in Path(__file__).parent.iterdir() if p.suffix in {".py", ".mjs", ".html", ".css", ".json"}]
    manifest_name = "manifest-resume-" + uuid4().hex + ".json" if recovery else "manifest.json"
    save_json(args.output / manifest_name, {"experimental": True, "batchId": EXPERIMENT,
        "maxTurns": 6, "maxResponses": 24, "model": "qwen-audio-3.1-realtime-plus",
        "topology": "continuous smart_turn listener / actual WAI memory+delivered context / independent voice and intent planner / local director / playback ACK",
        "plannerKnowsFutureAnswer": False, "fixedAnswerScript": False, "syntheticMemory": True,
        "syntheticUserVoice": True, "physicalAcousticsVerified": False, "autonomousTimers": False,
        "backgroundModelsCountedSeparately": True, "optimizedPreparation": True, "prewarmPolicy": "after_request",
        "sourceHashes": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}})
    web.run_app(create_app(runtime, wai_main, budget, args.output, cloud=args.enable_cloud,
                          session_class=ParallelDuplexSession,
                          factory=existing_local_proxy_socket if args.local_proxy else None, recovery=recovery),
                host="127.0.0.1", port=args.port,
                print=lambda _: print("Experimental parallel duplex ready on loopback", flush=True))


if __name__ == "__main__":
    main()
