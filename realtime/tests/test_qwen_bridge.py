"""Offline bridge checks: fake provider only, no real config or cloud access."""
import asyncio
import base64
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import WSServerHandshakeError
from aiohttp.test_utils import TestClient, TestServer


SOURCE = Path(__file__).resolve().parents[1] / "qwen/server.py"
SPEC = importlib.util.spec_from_file_location("avatar_qwen_bridge", SOURCE)
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)


class FakeProvider:
    def __init__(self, *, mismatch=False):
        self.events = asyncio.Queue()
        self.events.put_nowait({"type": "session.created", "session": {"model": bridge.MODEL}})
        self.sent = []
        self.closed = False
        self.mismatch = mismatch
        self.echo_overrides = {}

    async def send(self, event):
        self.sent.append(event)
        if event["type"] == "session.update":
            self.events.put_nowait({"type": "session.updated", "session": {
                **event["session"], "model": "wrong" if self.mismatch else bridge.MODEL, **self.echo_overrides}})

    async def receive(self):
        value = await self.events.get()
        if isinstance(value, Exception):
            raise value
        return value

    async def close(self):
        self.closed = True

    def emit(self, event):
        self.events.put_nowait(event)


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "realtime/qwen").mkdir(parents=True)
        (self.root / "realtime/qwen/index.html").write_text("avatar page", encoding="utf-8")
        (self.root / "realtime/qwen/server.py").write_text("private server source", encoding="utf-8")
        (self.root / "realtime/.env").write_text("FAKE_SECRET", encoding="utf-8")
        self.provider = FakeProvider()
        self.factory_calls = 0
        async def factory(config):
            self.factory_calls += 1
            self.assertEqual(config.key, "fake-only-token")
            return self.provider
        self.app = bridge.create_app(bridge.Config("fake-only-token", secrets=("fake-only-token",)),
                                     root=self.root, log_dir=self.root / "evidence",
                                     provider_factory=factory)
        self.client = TestClient(TestServer(self.app, host="127.0.0.1"))
        await self.client.start_server()
        self.origin = str(self.client.make_url("/")).rstrip("/")
        self.socket = None

    async def asyncTearDown(self):
        if self.socket:
            await self.socket.close()
        await self.client.close()
        self.temp.cleanup()

    async def receive_type(self, expected, timeout=2):
        async with asyncio.timeout(timeout):
            while True:
                message = await self.socket.receive_json()
                if message["type"] == expected:
                    return message

    async def connect(self, mode="manual"):
        self.socket = await self.client.ws_connect("/api/qwen", headers={"Origin": self.origin})
        await self.socket.send_json({"type": "connect", "mode": mode})
        return await self.receive_type("ready")

    async def text(self, request_id="req-1"):
        await self.socket.send_json({"type": "text", "requestId": request_id, "text": "合成测试，不含私人内容"})
        async with asyncio.timeout(2):
            while not any(event["type"] == "response.create" for event in self.provider.sent):
                await asyncio.sleep(0)

    async def created(self, rid="response-1"):
        self.provider.emit({"type": "response.created", "response": {"id": rid}})
        return await self.receive_type("provider")

    async def done(self, rid="response-1", usage=True, status="completed"):
        event = {"type": "response.done", "response": {"id": rid, "status": status}}
        if usage:
            event["response"]["usage"] = {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8}
        self.provider.emit(event)
        return await self.receive_type("provider")

    async def test_status_contains_no_secret_or_config_path(self):
        response = await self.client.get("/api/status")
        self.assertEqual(response.status, 200)
        data = await response.json()
        self.assertTrue(data["configured"])
        self.assertEqual(data["model"], bridge.MODEL)
        self.assertNotIn("fake-only-token", json.dumps(data))
        self.assertEqual(self.factory_calls, 0)

    async def test_static_allowlist_and_implementation_hidden(self):
        self.assertEqual((await self.client.get("/qwen/")).status, 200)
        self.assertEqual((await self.client.get("/qwen/server.py")).status, 404)
        self.assertEqual((await self.client.get("/.env")).status, 403)
        self.assertEqual((await self.client.post("/qwen/")).status, 405)
        self.assertEqual((await self.client.get("/api/status", headers={"Host": "evil.test"})).status, 403)
        self.assertEqual((await self.client.get("/api/status", headers={"Origin": "https://evil.test"})).status, 403)

    async def test_websocket_requires_origin_before_factory(self):
        for origin in (None, "null", "https://evil.test", "http://127.0.0.1:1"):
            with self.subTest(origin=origin):
                with self.assertRaises(WSServerHandshakeError) as caught:
                    await self.client.ws_connect("/api/qwen", headers={} if origin is None else {"Origin": origin})
                self.assertEqual(caught.exception.status, 403)
        self.assertEqual(self.factory_calls, 0)

    async def test_handshake_configuration_and_ping(self):
        ready = await self.connect()
        self.assertEqual(ready["outputSampleRate"], 24000)
        self.assertEqual(ready["inputSampleRate"], 16000)
        settings = self.provider.sent[0]["session"]
        self.assertIsNone(settings["turn_detection"])
        self.assertEqual(settings["tools"], [])
        self.assertEqual(settings["voice"], bridge.VOICE)
        await self.socket.send_json({"type": "ping", "clientNow": 123.5})
        pong = await self.receive_type("pong")
        self.assertEqual(pong["clientNow"], 123.5)
        self.assertGreaterEqual(pong["serverAtMs"], ready["serverAtMs"])

    async def test_witnessed_pcm16_input_alias_handshake(self):
        self.provider.echo_overrides = {"input_audio_format": "pcm16", "output_audio_format": "pcm"}
        ready = await self.connect()
        self.assertEqual(ready["inputSampleRate"], 16000)
        self.assertEqual(self.factory_calls, 1)

    async def test_only_one_browser_can_hold_connection(self):
        await self.connect()
        with self.assertRaises(WSServerHandshakeError) as caught:
            await self.client.ws_connect("/api/qwen", headers={"Origin": self.origin})
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.factory_calls, 1)

    async def test_concurrent_upgrades_reserve_slot_before_prepare_await(self):
        entered, release = asyncio.Event(), asyncio.Event()
        original = bridge.web.WebSocketResponse.prepare
        async def blocked_prepare(socket, request):
            entered.set()
            await release.wait()
            return await original(socket, request)
        with patch.object(bridge.web.WebSocketResponse, "prepare", blocked_prepare):
            first = asyncio.create_task(self.client.ws_connect("/api/qwen", headers={"Origin": self.origin}))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                with self.assertRaises(WSServerHandshakeError) as caught:
                    await self.client.ws_connect("/api/qwen", headers={"Origin": self.origin})
                self.assertEqual(caught.exception.status, 409)
            finally:
                release.set()
                self.socket = await first
        self.assertEqual(self.factory_calls, 0)

    async def test_text_response_identity_pcm_subtitle_and_known_usage(self):
        ready = await self.connect()
        await self.text()
        created = await self.created()
        self.assertEqual(created["connectionId"], ready["connectionId"])
        self.assertEqual(created["requestId"], "req-1")
        pcm = base64.b64encode(b"\x00\x01" * 240).decode()
        native = {"type": "response.audio.delta", "response_id": "response-1", "delta": pcm}
        self.provider.emit(native)
        self.assertEqual((await self.receive_type("provider"))["event"], native)
        self.provider.emit({"type": "response.audio_transcript.delta", "response_id": "response-1", "delta": "你好"})
        self.assertEqual((await self.receive_type("provider"))["event"]["delta"], "你好")
        self.assertEqual((await self.done())["event"]["response"]["status"], "completed")
        self.assertFalse(self.app[bridge.APP_STATE].usage_unknown)

    async def test_audio_sequence_and_manual_commit(self):
        await self.connect()
        await self.socket.send_json({"type": "input_audio", "sequence": 0,
                                     "audio": base64.b64encode(b"\x00\x01" * 1600).decode()})
        ack = await self.receive_type("input_ack")
        self.assertEqual(ack["receivedFrames"], 1600)
        await self.socket.send_json({"type": "commit", "requestId": "audio-1"})
        async with asyncio.timeout(2):
            while not any(event["type"] == "response.create" for event in self.provider.sent):
                await asyncio.sleep(0)
        kinds = [event["type"] for event in self.provider.sent]
        self.assertEqual(kinds[-2:], ["input_audio_buffer.commit", "response.create"])
        self.assertEqual((await self.created())["requestId"], "audio-1")
        await self.done()

    async def test_input_sequence_gap_fails_closed(self):
        await self.connect()
        await self.socket.send_json({"type": "input_audio", "sequence": 1, "audio": "AAA="})
        self.assertEqual((await self.receive_type("error"))["code"], "input_sequence_mismatch")
        await self.receive_type("closed")
        self.assertTrue(self.provider.closed)

    async def test_input_limit_closes_before_sending_excess(self):
        self.app[bridge.APP_STATE].limits.input_seconds = 0.05
        await self.connect()
        await self.socket.send_json({"type": "input_audio", "sequence": 0,
                                     "audio": base64.b64encode(b"\0\0" * 1600).decode()})
        self.assertEqual((await self.receive_type("error"))["code"], "input_audio_limit")
        self.assertNotIn("input_audio_buffer.append", [event["type"] for event in self.provider.sent])

    async def test_output_limit_includes_revoked_audio(self):
        self.app[bridge.APP_STATE].limits.output_seconds = 0.01
        await self.connect()
        await self.text()
        await self.created()
        await self.socket.send_json({"type": "cancel", "responseId": "response-1"})
        await self.receive_type("cancel_ack")
        self.provider.emit({"type": "response.audio.delta", "response_id": "response-1",
                            "delta": base64.b64encode(b"\0\0" * 480).decode()})
        self.assertEqual((await self.receive_type("error"))["code"], "output_audio_limit")
        await self.receive_type("closed")
        self.assertTrue(self.app[bridge.APP_STATE].usage_unknown)

    async def test_cancel_pending_late_created_is_revoked_and_cancelled(self):
        await self.connect()
        await self.text()
        await self.socket.send_json({"type": "cancel", "requestId": "req-1"})
        ack = await self.receive_type("cancel_ack")
        self.assertTrue(ack["pending"])
        self.assertNotIn("response.cancel", [event["type"] for event in self.provider.sent])
        created = await self.created()
        self.assertTrue(created["revoked"])
        self.assertEqual(self.provider.sent[-1]["type"], "response.cancel")
        self.provider.emit({"type": "response.audio.delta", "response_id": "response-1", "delta": "AAA="})
        self.assertTrue((await self.receive_type("provider"))["revoked"])
        await self.done(usage=False, status="cancelled")
        self.assertEqual((await self.receive_type("error"))["code"], "usage_unknown_admission_blocked")
        await self.receive_type("closed")
        self.assertTrue(self.app[bridge.APP_STATE].usage_unknown)

    async def test_cancel_wrong_owner_never_cancels_another_response(self):
        await self.connect()
        await self.text()
        await self.created()
        await self.socket.send_json({"type": "cancel", "responseId": "wrong"})
        self.assertEqual((await self.receive_type("error"))["code"], "cancel_owner_mismatch")
        self.assertNotIn("response.cancel", [event["type"] for event in self.provider.sent])

    async def test_unknown_owner_pcm_is_not_forwarded(self):
        await self.connect()
        self.provider.emit({"type": "response.audio.delta", "response_id": "unknown", "delta": "AAA="})
        self.assertEqual((await self.receive_type("error"))["code"], "response_ownership_unknown")
        await self.receive_type("closed")
        self.assertTrue(self.app[bridge.APP_STATE].usage_unknown)

    async def test_known_ended_audio_still_counts_toward_limit(self):
        self.app[bridge.APP_STATE].limits.output_seconds = 0.01
        await self.connect()
        await self.text()
        await self.created()
        await self.done()
        self.provider.emit({"type": "response.audio.delta", "response_id": "response-1",
                            "delta": base64.b64encode(b"\0\0" * 480).decode()})
        self.assertEqual((await self.receive_type("error"))["code"], "output_audio_limit")
        await self.receive_type("closed")
        self.assertTrue(self.app[bridge.APP_STATE].usage_unknown)

    async def test_known_ended_tail_is_revoked(self):
        await self.connect()
        await self.text()
        await self.created()
        await self.done()
        self.provider.emit({"type": "response.audio_transcript.delta", "response_id": "response-1", "delta": "迟到"})
        event = await self.receive_type("provider")
        self.assertTrue(event["revoked"])
        self.assertEqual(event["requestId"], "req-1")

    async def test_cancel_completed_does_not_send_remote_cancel(self):
        await self.connect()
        await self.text()
        await self.created()
        await self.done()
        await self.socket.send_json({"type": "cancel", "responseId": "response-1"})
        self.assertFalse((await self.receive_type("cancel_ack"))["remoteNeeded"])
        self.assertNotIn("response.cancel", [event["type"] for event in self.provider.sent])

    async def test_vad_auto_response_binds_unique_request(self):
        await self.connect("vad")
        self.assertEqual(bridge.VAD_SILENCE_MS, 1000)
        self.assertEqual(self.provider.sent[0]["session"]["turn_detection"]["silence_duration_ms"], bridge.VAD_SILENCE_MS)
        self.provider.emit({"type": "input_audio_buffer.speech_started", "item_id": "input-1"})
        await self.receive_type("provider")
        self.provider.emit({"type": "input_audio_buffer.speech_stopped", "item_id": "input-1"})
        await self.receive_type("provider")
        created = await self.created()
        self.assertTrue(created["requestId"].startswith("vad-"))
        await self.done()

    async def test_vad_old_500ms_echo_is_rejected_before_ready(self):
        self.provider.echo_overrides = {"turn_detection": {"type": "server_vad", "silence_duration_ms": 500}}
        self.socket = await self.client.ws_connect("/api/qwen", headers={"Origin": self.origin})
        await self.socket.send_json({"type": "connect", "mode": "vad"})
        self.assertEqual((await self.receive_type("error"))["code"], "session_configuration_mismatch")
        await self.receive_type("closed")
        self.assertEqual(sum(event["type"] == "response.create" for event in self.provider.sent), 0)
        self.assertFalse(self.app[bridge.APP_STATE].usage_unknown)

    async def test_vad_created_without_input_turn_is_rejected(self):
        await self.connect("vad")
        self.provider.emit({"type": "response.created", "response": {"id": "unsolicited"}})
        self.assertEqual((await self.receive_type("error"))["code"], "response_ownership_unknown")

    async def test_service_budget_blocks_before_next_request(self):
        self.app[bridge.APP_STATE].limits.total_responses = 1
        await self.connect()
        await self.text()
        await self.created()
        await self.done()
        await self.socket.send_json({"type": "text", "requestId": "req-2", "text": "再次"})
        self.assertEqual((await self.receive_type("error"))["code"], "service_response_limit")
        self.assertEqual(sum(event["type"] == "response.create" for event in self.provider.sent), 1)

    async def test_usage_unknown_prevents_new_provider_connection(self):
        self.app[bridge.APP_STATE].usage_unknown = True
        self.socket = await self.client.ws_connect("/api/qwen", headers={"Origin": self.origin})
        await self.socket.send_json({"type": "connect", "mode": "manual"})
        self.assertEqual((await self.receive_type("error"))["code"], "usage_unknown_admission_blocked")
        self.assertEqual(self.factory_calls, 0)

    async def test_malformed_usage_is_unknown(self):
        await self.connect()
        await self.text()
        await self.created()
        self.provider.emit({"type": "response.done", "response": {"id": "response-1", "status": "completed",
                            "usage": {"input_tokens": 5, "output_tokens": True, "total_tokens": 6}}})
        await self.receive_type("provider")
        self.assertEqual((await self.receive_type("error"))["code"], "usage_unknown_admission_blocked")

    async def test_configuration_mismatch_and_provider_error_are_safe(self):
        self.provider.mismatch = True
        self.socket = await self.client.ws_connect("/api/qwen", headers={"Origin": self.origin})
        await self.socket.send_json({"type": "connect", "mode": "manual"})
        self.assertEqual((await self.receive_type("error"))["code"], "session_configuration_mismatch")
        self.assertTrue(self.provider.closed)

    async def test_provider_error_never_exposes_key(self):
        await self.connect()
        self.provider.emit({"type": "error", "error": {"message": "fake-only-token private/path"}})
        event = await self.receive_type("error")
        self.assertEqual(event["code"], "provider_error")
        self.assertNotIn("fake-only-token", json.dumps(event))

    async def test_response_watchdog_closes_and_marks_unknown(self):
        self.app[bridge.APP_STATE].limits.response_seconds = 0.02
        await self.connect()
        await self.text()
        self.assertEqual((await self.receive_type("error"))["code"], "response_time_limit")
        await self.receive_type("closed")
        self.assertTrue(self.app[bridge.APP_STATE].usage_unknown)

    async def test_unconnected_socket_still_has_lifetime_limit(self):
        self.app[bridge.APP_STATE].limits.lifetime_seconds = 0.03
        self.socket = await self.client.ws_connect("/api/qwen", headers={"Origin": self.origin})
        self.assertEqual((await self.receive_type("error"))["code"], "connection_time_limit")
        await self.receive_type("closed")
        self.assertEqual(self.factory_calls, 0)

    async def test_logs_have_usage_timing_but_no_audio_text_or_key(self):
        await self.connect()
        await self.text()
        await self.created()
        self.provider.emit({"type": "response.audio_transcript.delta", "response_id": "response-1", "delta": "不应进入日志的字幕"})
        await self.receive_type("provider")
        await self.done()
        await self.socket.send_json({"type": "close"})
        await self.receive_type("closed")
        async with asyncio.timeout(2):
            while not list((self.root / "evidence").glob("*.json")):
                await asyncio.sleep(0.01)
        content = next((self.root / "evidence").glob("*.json")).read_text(encoding="utf-8")
        self.assertNotIn("不应进入日志的字幕", content)
        self.assertNotIn("合成测试", content)
        self.assertNotIn("fake-only-token", content)
        self.assertIn('"usageStatus": "reported"', content)
        self.assertIn('"serverAtMs"', content)


class ConfigTests(unittest.TestCase):
    def test_directional_pcm_aliases_and_explicit_rates(self):
        base = {"model": bridge.MODEL, "voice": bridge.VOICE, "modalities": ["text", "audio"],
                "input_audio_format": "pcm16", "output_audio_format": "pcm"}
        self.assertTrue(bridge.session_matches(base, "manual"))  # manual omission witnessed in live echo
        self.assertTrue(bridge.session_matches({**base, "output_audio_format": "pcm24"}, "manual"))
        self.assertFalse(bridge.session_matches({**base, "input_audio_format": "pcm24"}, "manual"))
        self.assertFalse(bridge.session_matches({**base, "output_audio_format": "pcm16"}, "manual"))
        self.assertFalse(bridge.session_matches({**base, "input_audio_sample_rate": 24000}, "manual"))
        self.assertFalse(bridge.session_matches({**base, "output_audio_channels": 2}, "manual"))
        self.assertFalse(bridge.session_matches({**base, "model": "unverified-alias"}, "manual"))
        self.assertFalse(bridge.session_matches({**base, "modalities": ["audio", "audio"]}, "manual"))
        self.assertFalse(bridge.session_matches({**base, "turn_detection": {"type": "server_vad"}}, "manual"))
        # These assertions cover configuration only. They deliberately do not
        # imitate the cloud detector's treatment of pauses inside speech.
        self.assertTrue(bridge.session_matches({**base, "turn_detection": {
            "type": "server_vad", "silence_duration_ms": 1000}}, "vad"))
        for duration in (0, 500, 800, 2000, "1000", 1000.0, True):
            with self.subTest(duration=duration):
                self.assertFalse(bridge.session_matches({**base, "turn_detection": {
                    "type": "server_vad", "silence_duration_ms": duration}}, "vad"))

    def test_echo_is_allowlisted_and_redacted(self):
        echo = bridge.safe_session_echo({"model": bridge.MODEL, "instructions": "SECRET PROMPT",
                                         "key": "sensitive", "voice": "sensitive",
                                         "turn_detection": {"type": "server_vad", "private": "SECRET"}}, ("sensitive",))
        self.assertEqual(echo["voice"], "[REDACTED]")
        self.assertNotIn("instructions", echo)
        self.assertNotIn("key", echo)
        self.assertNotIn("private", echo["turn_detection"])

    def test_only_allowlisted_settings_are_read_and_environment_wins(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "runtime.env"
            source.write_text('DASHSCOPE_API_KEY="file-fake"\nDASHSCOPE_WORKSPACE_ID=workspacefake\nOTHER_SECRET=ignored\n', encoding="utf-8")
            config = bridge.load_config(source, {"DASHSCOPE_API_KEY": "env-fake"})
            self.assertEqual(config.key, "env-fake")
            self.assertIn("workspacefake.cn-beijing.maas.aliyuncs.com", config.endpoint)
            self.assertNotIn("ignored", repr(config))

    def test_bad_endpoint_rejected(self):
        for value in ("http://evil.test", "wss://evil.test/api-ws/v1/realtime",
                      "wss://a.aliyuncs.com/api-ws/v1/realtime?key=secret"):
            with self.subTest(value=value), self.assertRaises(bridge.BridgeFailure):
                bridge.load_config(environ={"QWEN_AUDIO_REALTIME_BASE_URL": value})


if __name__ == "__main__":
    unittest.main()
