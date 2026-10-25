"""No cloud or WAI startup: protect the isolated server's admission/evidence APIs."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys

import aiohttp
from aiohttp.test_utils import TestClient, TestServer

FACE = Path(__file__).resolve().parents[2]
WAI = FACE.parents[1] / "WAI"
sys.path.insert(0, str(WAI))
spec = importlib.util.spec_from_file_location("parallel_duplex_app_test", FACE / "realtime/parallel-duplex/app.py")
app_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = app_module
spec.loader.exec_module(app_module)


class Budget:
    data = {"blocked": False}

    def snapshot(self):
        return {"blocked": False, "turns": 0, "responseLimit": 24, "unknown": 0}


class Runtime:
    def stop(self):
        pass


def test_reports_are_origin_guarded_immutable_and_distinct_from_live(tmp_path):
    async def run():
        app = app_module.create_app(Runtime(), None, Budget(), tmp_path, session_class=object)
        async with TestClient(TestServer(app)) as client:
            origin = str(client.make_url("/")).rstrip("/")
            headers = {"Origin": origin}
            denied = await client.post("/api/parallel-duplex/report", json={"mode": "live"}, headers={"Origin": "https://example.com"})
            assert denied.status == 403
            for mode in (None, "unknown"):
                bad = await client.post("/api/parallel-duplex/report", json={"mode": mode}, headers=headers)
                assert bad.status == 400
            names = []
            for mode in ("live", "live", "replay"):
                response = await client.post("/api/parallel-duplex/report", json={"mode": mode, "reportId": "same", "latency": 123}, headers=headers)
                assert response.status == 200
                names.append((await response.json())["name"])
            assert len(set(names)) == 3
            assert all(json.loads((tmp_path / name).read_text())["latency"] == 123 for name in names)
    asyncio.run(run())


def test_cloud_disabled_cannot_connect_and_input_route_has_allowlist(tmp_path):
    async def run():
        folder = tmp_path / "inputs"
        folder.mkdir()
        (folder / "input-fixtures.json").write_text(json.dumps({"clips": [{"id": "question"}]}))
        (folder / "question.wav").write_bytes(b"RIFF test only")
        (folder / "private.wav").write_bytes(b"not allowed")
        app = app_module.create_app(Runtime(), None, Budget(), tmp_path, cloud=False, session_class=object)
        async with TestClient(TestServer(app)) as client:
            origin = str(client.make_url("/")).rstrip("/")
            try:
                await client.ws_connect("/api/duplex", headers={"Origin": origin})
                assert False, "cloud disabled must fail before constructing a session"
            except aiohttp.WSServerHandshakeError as exc:
                assert exc.status == 409
            assert (await client.get("/parallel-duplex-inputs/question.wav")).status == 200
            assert (await client.get("/parallel-duplex-inputs/private.wav")).status == 404
            assert (await client.get("/duplex-data/ledger.json")).status == 404
            assert (await (await client.get("/api/duplex/status")).json())["cloudEnabled"] is False
    asyncio.run(run())
