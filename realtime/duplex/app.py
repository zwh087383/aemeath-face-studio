"""Experimental D + WAI full passive path, loopback-only continuous voice UI."""
from __future__ import annotations
import argparse
import asyncio
from dataclasses import dataclass
import importlib.util
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace

from aiohttp import web, WSMsgType

FACE_ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("face_legacy_static", FACE_ROOT / "realtime/qwen/server.py")
legacy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = legacy
spec.loader.exec_module(legacy)


def create_app(runtime, main, budget, output, *, mode="smart_turn"):
    from tools.voice_avatar.duplex_runtime import DuplexSession
    from tools.voice_avatar.bootstrap import evidence_snapshot, wait_quiescent
    app = web.Application(client_max_size=1_000_000)
    app[legacy.APP_STATE] = SimpleNamespace(root=FACE_ROOT)
    active = set()

    def allow(request):
        if not legacy.allowed_request(request):
            raise web.HTTPForbidden(text="Invalid loopback origin")

    async def status(request):
        allow(request)
        return web.json_response({"experimental": True, "mode": mode, "budget": budget.snapshot(),
            "variants": ["full-cold", "full-warm", "memory-warm", "qwen-direct"],
            "connected": bool(active), "model": "qwen-audio-3.1-realtime-plus",
            "memory": "actual_WAI_with_isolated_synthetic_state", "defaultStrength": .65,
            "savedSessions": [p.stem for p in sorted(output.glob("duplex-*.json"))]},
            headers={"Cache-Control": "no-store"})

    async def evidence(request):
        allow(request)
        result = await asyncio.to_thread(evidence_snapshot, main, runtime)
        return web.json_response(result, headers={"Cache-Control": "no-store"})

    async def drain(request):
        allow(request)
        result = await asyncio.to_thread(wait_quiescent, main, runtime, timeout=25)
        return web.json_response(result, headers={"Cache-Control": "no-store"})

    async def socket(request):
        allow(request)
        if active or budget.data["blocked"]:
            raise web.HTTPConflict(text="Busy or usage blocked")
        variant = request.query.get("variant", "full-cold")
        if variant not in {"full-cold", "full-warm", "memory-warm", "qwen-direct"}:
            raise web.HTTPBadRequest(text="Unsupported reply variant")
        ws = web.WebSocketResponse(max_msg_size=100_000, heartbeat=15)
        session = DuplexSession(runtime, main, budget, output, ws.send_json, mode=mode, variant=variant)
        active.add(session)
        try:
            await ws.prepare(request)
            await session.open()
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                command = json.loads(message.data)
                kind = command.get("type")
                if kind == "audio":
                    await session.input(command)
                elif kind == "text":
                    await session.submit(command.get("text"))
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

    async def saved(request):
        allow(request)
        name = request.match_info["name"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+\.(json|wav|webm|png|jpg)", name):
            raise web.HTTPNotFound()
        target = output / name
        if not target.is_file() or name == "ledger.json":
            raise web.HTTPNotFound()
        return web.FileResponse(target, headers={"Cache-Control": "no-store"})

    async def root(request):
        raise web.HTTPFound("/duplex/")

    app.router.add_get("/", root)
    app.router.add_get("/api/duplex/status", status)
    app.router.add_get("/api/duplex/evidence", evidence)
    app.router.add_post("/api/duplex/drain", drain)
    app.router.add_get("/api/duplex", socket)
    app.router.add_get("/duplex-data/{name}", saved)
    app.router.add_get("/{path:.*}", legacy.static_handler)

    async def shutdown(_):
        await asyncio.gather(*(s.close() for s in list(active)), return_exceptions=True)
        await asyncio.to_thread(runtime.stop)
    app.on_shutdown.append(shutdown)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wai-root", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=FACE_ROOT / "outputs/qwen-duplex-d-20261017")
    parser.add_argument("--port", type=int, default=18772)
    parser.add_argument("--max-turns", type=int, default=8)
    parser.add_argument("--max-responses", type=int, default=16)
    parser.add_argument("--mode", choices=("smart_turn", "server_vad"), default="smart_turn")
    parser.add_argument("--batch-id", default="duplex-d-20261017")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("invalid_port")
    args.output = args.output.resolve()
    sys.path.insert(0, str(args.wai_root.resolve()))
    from tools.voice_avatar.duplex_transport import DurableBudget, save_json
    from tools.voice_avatar.bootstrap import configure, bootstrap_runtime
    budget = DurableBudget(args.output / "ledger.json", max_turns=args.max_turns, max_responses=args.max_responses)
    config = configure(args.env_file, args.data_dir, batch_id=args.batch_id)
    runtime, wai_main = bootstrap_runtime(config)
    save_json(args.output / "manifest.json", {"experimental": True, "mode": args.mode,
        "batchId": args.batch_id, "variants": ["full-cold", "full-warm", "memory-warm", "qwen-direct"],
        "maxTurns": args.max_turns, "maxResponses": args.max_responses,
        "topology": "continuous listener / final ASR / WAI retrieval+context / D response / playback ACK",
        "directTopology": "local memory+context / Qwen direct audio / optional request_full_reply / full-analysis Qwen / aggregate playback ACK",
        "syntheticMemory": True, "spontaneousReply": True, "prerecordedAnswer": False,
        "autonomousTimers": False, "physicalAcousticsVerified": False})
    web.run_app(create_app(runtime, wai_main, budget, args.output, mode=args.mode), host="127.0.0.1", port=args.port,
                print=lambda value: print("Experimental WAI D duplex service listening on loopback", flush=True))


if __name__ == "__main__":
    main()
