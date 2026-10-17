"""Offline protocol preview using two already saved audio responses.

No WAI bootstrap, credentials, websocket provider, history or usage ledger.
The handoff is a synthetic test event, never evidence of a new cloud response.
"""
import argparse
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace

from aiohttp import web

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("offline_direct_static", ROOT / "realtime/qwen/server.py")
static = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = static
spec.loader.exec_module(static)


def protocol_fixture(record):
    candidates = [t for t in record["turns"] if t.get("result", {}).get("status") == "completed"
        and t["result"].get("frames", 0) > 0 and not t.get("revoked")]
    wave = next(t for t in candidates if any(c["plan"]["gesture"] == "wave" for c in t["result"]["calls"]))
    first = next(t for t in candidates if t is not wave)
    cid, tid = "offline-direct", "offline-turn"
    rows = [{"type": "turn_started", "connectionId": cid, "turnId": tid, "serverMs": 0,
             "text": "离线协议演示：历史音频两段拼接，转交指令为模拟事件"}]
    segments, results, offset = [], [], 40
    selected = {"request_sent", "response_created", "audio", "subtitle", "audio_done", "tool", "response_done"}
    for index, original in enumerate([first, wave]):
        source = [e for e in record["events"] if e.get("turnId") == original["id"] and e["type"] in selected]
        origin = source[0]["serverMs"]
        connection, response = f"offline-provider-{index}", f"offline-response-{index}"
        phase = "direct" if index == 0 else "full"
        start_frame = sum(s["frames"] for s in segments)
        result = deepcopy(original["result"])
        result.update(connectionId=connection, responseId=response, index=index, phase=phase, startFrame=start_frame,
            handoff={"reason": "long_answer", "callId": "offline-handoff"} if index == 0 else None)
        for saved in source:
            event = deepcopy(saved)
            event.update(connectionId=cid, turnId=tid, serverMs=offset+saved["serverMs"]-origin,
                providerConnectionId=connection, responseId=response, segmentIndex=index, phase=phase, startFrame=start_frame)
            if event["type"] == "response_done":
                event["result"] = result
                event.pop("budget", None)
            rows.append(event)
        results.append(result)
        segments.append({"index": index, "connectionId": connection, "responseId": response,
            "frames": result["frames"], "audioDone": True, "transcriptDone": True, "status": "completed",
            "phase": phase, "startFrame": start_frame})
        offset = rows[-1]["serverMs"] + 20
        if index == 0:
            rows.append({"type": "handoff_requested", "connectionId": cid, "turnId": tid,
                "serverMs": offset, "segmentIndex": 0, "phase": "direct", "startFrame": 0,
                "providerConnectionId": connection, "responseId": response,
                "reason": "long_answer", "callId": "offline-handoff"})
            offset += 20
    total = {**results[-1], "segments": segments, "frames": sum(s["frames"] for s in segments),
        "transcript": "\n".join(r["transcript"].strip() for r in results), "status": "completed"}
    rows.append({"type": "turn_output_done", "connectionId": cid, "turnId": tid,
        "serverMs": offset, "result": total,
        "providerConnectionId": total["connectionId"], "responseId": total["responseId"]})
    return {"experimental": True, "offline": True, "variant": "qwen-direct", "events": rows,
        "turns": [{"id": tid, "text": rows[0]["text"], "result": total, "revoked": False}],
        "source": "synthetic_handoff_protocol_with_previously_saved_pcm"}


def create_app(fixture):
    app = web.Application()
    app[static.APP_STATE] = SimpleNamespace(root=ROOT)
    async def status(request):
        if not static.allowed_request(request):
            raise web.HTTPForbidden()
        return web.json_response({"offline": True, "experimental": True, "connected": False,
            "variants": ["qwen-direct"], "savedSessions": ["duplex-offline-direct"],
            "budget": {"blocked": False, "turns": 0, "turnLimit": 0, "responses": 0,
                       "responseLimit": 0, "unknown": 0}})
    async def saved(request):
        if not static.allowed_request(request):
            raise web.HTTPForbidden()
        return web.json_response(fixture)
    async def denied(request):
        raise web.HTTPForbidden(text="Offline preview has no model connection")
    app.router.add_get("/api/duplex/status", status)
    app.router.add_get("/duplex-data/duplex-offline-direct.json", saved)
    app.router.add_route("*", "/api/duplex", denied)
    app.router.add_get("/{path:.*}", static.static_handler)
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", type=Path, required=True, help="Saved local session with two complete replies including a wave")
    parser.add_argument("--port", type=int, default=18777)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("invalid_port")
    fixture = protocol_fixture(json.loads(args.record.read_text(encoding="utf-8-sig")))
    web.run_app(create_app(fixture), host="127.0.0.1", port=args.port)
