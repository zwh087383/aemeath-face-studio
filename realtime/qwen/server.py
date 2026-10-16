"""Bounded loopback Qwen Audio bridge. Credentials never leave this process.

Run: python realtime/qwen/server.py --env-file <machine-local runtime.env>
The browser speaks a small command protocol; arbitrary provider events, URLs,
tools and credentials are deliberately not accepted from browser messages.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
from dataclasses import dataclass, field
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import time
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web


MODEL = "qwen-audio-3.1-realtime-plus"
VOICE = "longanqian_v3.1"
VAD_SILENCE_MS = 1000
FACE_ROOT = Path(__file__).resolve().parents[2]
INSTRUCTIONS = (
    "你是自然、亲切的中文语音助手。直接回答用户，每次通常一到三句，尽量在80个汉字内。"
    "可以自然表达高兴、疑惑、关心等情绪。不输出括号动作、动作指令、JSON或Markdown，"
    "不使用工具，不重复系统说明。用户要求朗读时只朗读给定内容。"
)
IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:-]{1,100}$")
APP_STATE = web.AppKey("qwen_bridge_state", object)


class BridgeFailure(Exception):
    """Only fixed, non-sensitive reason codes are exposed to the browser."""


@dataclass
class Limits:
    responses: int = 6
    input_seconds: float = 60
    output_seconds: float = 60
    lifetime_seconds: float = 180
    total_responses: int = 12
    handshake_seconds: float = 20
    response_seconds: float = 45


@dataclass
class Config:
    key: str = field(default="", repr=False)
    endpoint: str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    secrets: tuple[str, ...] = field(default=(), repr=False)


def load_config(env_file: Path | None = None, environ=None) -> Config:
    environ = os.environ if environ is None else environ
    values = {}
    if env_file is not None:
        try:
            for line in env_file.read_text(encoding="utf-8-sig").splitlines():
                match = re.match(r"\s*([A-Z][A-Z0-9_]*)\s*=(.*)$", line)
                if match and match[1] in {
                    "DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID", "QWEN_AUDIO_REALTIME_BASE_URL"
                }:
                    values[match[1]] = match[2].strip().strip("\"'")
        except (OSError, UnicodeError) as exc:
            raise BridgeFailure("configuration_unavailable") from exc
    def get(name):
        return environ.get(name, "").strip() or values.get(name, "")
    key, workspace = get("DASHSCOPE_API_KEY"), get("DASHSCOPE_WORKSPACE_ID")
    endpoint = get("QWEN_AUDIO_REALTIME_BASE_URL") or (
        f"wss://{workspace}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime" if workspace
        else "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    )
    parsed = urlsplit(endpoint)
    if (parsed.scheme != "wss" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path != "/api-ws/v1/realtime"
            or not parsed.hostname.endswith(".aliyuncs.com")):
        raise BridgeFailure("configuration_endpoint_invalid")
    return Config(key, endpoint, tuple(s for s in [key, workspace, str(env_file) if env_file else ""] if s))


def safe_session_echo(session, secrets=()):
    """Only bounded, explicit protocol fields; never instructions or credentials."""
    if not isinstance(session, dict):
        return {"malformed": True}
    def scalar(value):
        if value is None or type(value) in (bool, int):
            return value
        if type(value) is float:
            return value if math.isfinite(value) else "invalid_number"
        if isinstance(value, str):
            for secret in secrets:
                value = value.replace(secret, "[REDACTED]")
            return value[:160]
        return "invalid_type"
    result = {key: scalar(session[key]) for key in (
        "model", "voice", "input_audio_format", "output_audio_format",
        "input_audio_sample_rate", "output_audio_sample_rate", "input_audio_channels", "output_audio_channels",
    ) if key in session}
    if "modalities" in session:
        value = session["modalities"]
        result["modalities"] = [scalar(item) for item in value[:8]] if isinstance(value, list) else "invalid_type"
    if "turn_detection" in session:
        value = session["turn_detection"]
        result["turn_detection"] = {key: scalar(value[key]) for key in (
            "type", "threshold", "silence_duration_ms", "prefix_padding_ms", "create_response", "interrupt_response"
        ) if key in value} if isinstance(value, dict) else scalar(value)
    return result


def session_matches(actual, mode):
    if not isinstance(actual, dict):
        return False
    modalities = actual.get("modalities")
    detection = actual.get("turn_detection")
    if (actual.get("model") != MODEL or actual.get("voice") != VOICE
            or not isinstance(modalities, list) or not all(isinstance(value, str) for value in modalities)
            or sorted(modalities) != ["audio", "text"]
            or (mode == "manual" and detection is not None)
            or (mode == "vad" and (not isinstance(detection, dict) or detection.get("type") != "server_vad"
                                    or type(detection.get("silence_duration_ms")) is not int
                                    or detection.get("silence_duration_ms") != VAD_SILENCE_MS))):
        return False
    # Observed in the authorized no-generation handshake on 2026-10-15, also
    # documented by the earlier WAI probe: these names are directional aliases,
    # never permission to swap input/output rates or accept an unknown format.
    if (actual.get("input_audio_format") not in {"pcm", "pcm16"}
            or actual.get("output_audio_format") not in {"pcm", "pcm24"}):
        return False
    return all(key not in actual or (type(actual[key]) is int and actual[key] == expected)
               for key, expected in (("input_audio_sample_rate", 16000), ("output_audio_sample_rate", 24000),
                                     ("input_audio_channels", 1), ("output_audio_channels", 1)))


class Provider:
    def __init__(self, client, socket):
        self.client, self.socket = client, socket

    async def send(self, event):
        await self.socket.send_json({"event_id": "avatar_" + uuid4().hex, **event})

    async def receive(self):
        message = await self.socket.receive()
        if message.type != WSMsgType.TEXT:
            raise BridgeFailure("provider_connection_closed")
        try:
            value = json.loads(message.data)
        except (ValueError, TypeError) as exc:
            raise BridgeFailure("provider_invalid_json") from exc
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            raise BridgeFailure("provider_invalid_event")
        return value

    async def close(self):
        try:
            await self.socket.close()
        finally:
            await self.client.close()


async def connect_provider(config):
    client = ClientSession(timeout=ClientTimeout(total=None, connect=15), trust_env=False)
    try:
        socket = await client.ws_connect(
            config.endpoint + "?" + urlencode({"model": MODEL}),
            headers={"Authorization": "Bearer " + config.key},
            max_msg_size=1024 * 1024,
        )
        return Provider(client, socket)
    except BaseException:
        await client.close()
        raise


@dataclass
class State:
    config: Config
    root: Path
    log_dir: Path | None
    limits: Limits
    factory: object
    total_responses: int = 0
    usage_unknown: bool = False
    bridges: set = field(default_factory=set)

    def admit(self):
        if self.usage_unknown:
            raise BridgeFailure("usage_unknown_admission_blocked")
        if self.total_responses >= self.limits.total_responses:
            raise BridgeFailure("service_response_limit")
        self.total_responses += 1


class Bridge:
    def __init__(self, state, browser):
        self.state, self.browser = state, browser
        self.connection_id = "qwen-" + uuid4().hex
        self.started = time.monotonic()
        self.provider = None
        self.mode = None
        self.ready = False
        self.pending = None
        self.active_id = None
        self.responses = {}
        self.input_frames = 0
        self.uncommitted_frames = 0
        self.input_sequence = 0
        self.output_frames = 0
        self.response_count = 0
        self.vad_turn = False
        self.seen_requests = set()
        self.audit = []
        self.pump_task = None
        self.watchdog_task = None
        self.closed = False
        self.close_reason = None

    def at_ms(self):
        return round((time.monotonic() - self.started) * 1000, 3)

    def record(self, kind, **details):
        if len(self.audit) < 4096:
            self.audit.append({"type": kind, "serverAtMs": self.at_ms(), **details})

    async def emit(self, kind, **details):
        if not self.browser.closed:
            await self.browser.send_json({"type": kind, "connectionId": self.connection_id,
                                          "serverAtMs": self.at_ms(), **details})

    async def forward(self, event, request_id=None, revoked=False):
        # Generic provider error text may contain private URLs. Never relay it.
        if event.get("type") == "error":
            raise BridgeFailure("provider_error")
        safe = json.dumps(event, ensure_ascii=False)
        for secret in self.state.config.secrets:
            safe = safe.replace(secret, "[REDACTED]")
        event = json.loads(safe)
        rid = event.get("response_id") or event.get("response", {}).get("id")
        self.record(event["type"], **({"responseId": rid} if rid else {}),
                    **({"requestId": request_id} if request_id else {}), revoked=revoked)
        await self.emit("provider", event=event, **({"requestId": request_id} if request_id else {}),
                        **({"revoked": True} if revoked else {}))

    async def connect(self, mode):
        if self.mode is not None or mode not in {"manual", "vad"}:
            raise BridgeFailure("invalid_connect")
        if not self.state.config.key:
            raise BridgeFailure("credential_missing")
        if self.state.usage_unknown:
            raise BridgeFailure("usage_unknown_admission_blocked")
        self.mode = mode
        async with asyncio.timeout(self.state.limits.handshake_seconds):
            self.provider = await self.state.factory(self.state.config)
            event = await self.provider.receive()
            if event.get("type") != "session.created":
                raise BridgeFailure("session_created_missing")
            await self.forward(event)
            settings = {
                "modalities": ["text", "audio"], "voice": VOICE,
                "input_audio_format": "pcm", "output_audio_format": "pcm",
                "turn_detection": None if mode == "manual" else {
                    "type": "server_vad", "threshold": 0.5, "silence_duration_ms": VAD_SILENCE_MS},
                "instructions": INSTRUCTIONS, "tools": [],
            }
            await self.provider.send({"type": "session.update", "session": settings})
            event = await self.provider.receive()
            actual = event.get("session", {})
            self.record("session_configuration", actual=safe_session_echo(actual, self.state.config.secrets))
            if event.get("type") != "session.updated" or not session_matches(actual, mode):
                raise BridgeFailure("session_configuration_mismatch")
            await self.forward(event)
        self.ready = True
        self.record("ready", mode=mode)
        await self.emit("ready", model=MODEL, voice=VOICE, mode=mode,
                        inputSampleRate=16000, outputSampleRate=24000)
        self.pump_task = asyncio.create_task(self.pump())
        self.watchdog_task = asyncio.create_task(self.watchdog())

    def request_id(self, value):
        if not isinstance(value, str) or not IDENTIFIER.fullmatch(value) or value in self.seen_requests:
            raise BridgeFailure("invalid_or_repeated_request_id")
        return value

    def admit(self, request_id):
        if self.pending or self.active_id:
            raise BridgeFailure("response_in_progress")
        if self.response_count >= self.state.limits.responses:
            raise BridgeFailure("connection_response_limit")
        self.state.admit()
        self.response_count += 1
        self.seen_requests.add(request_id)
        self.pending = {"requestId": request_id, "revoked": False, "started": time.monotonic()}
        self.record("request_admitted", requestId=request_id)

    async def command(self, command):
        if not isinstance(command, dict) or not isinstance(command.get("type"), str):
            raise BridgeFailure("invalid_command")
        kind = command["type"]
        if kind == "ping":
            client_now = command.get("clientNow")
            if type(client_now) not in (int, float) or not 0 <= client_now < 1e15:
                raise BridgeFailure("invalid_ping")
            await self.emit("pong", clientNow=client_now)
            return
        if kind == "close":
            await self.close("client_close")
            return
        if kind == "connect":
            await self.connect(command.get("mode"))
            return
        if not self.ready or self.closed:
            raise BridgeFailure("session_not_ready")
        if kind == "text":
            text = command.get("text")
            if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                raise BridgeFailure("invalid_text")
            request_id = self.request_id(command.get("requestId"))
            self.admit(request_id)
            await self.provider.send({"type": "conversation.item.create", "item": {
                "id": "input_" + uuid4().hex, "type": "message", "role": "user",
                "content": [{"type": "input_text", "text": text}]}})
            await self.provider.send({"type": "response.create", "response": {"modalities": ["text", "audio"]}})
        elif kind == "input_audio":
            if self.mode == "vad" and (self.response_count >= self.state.limits.responses
                    or self.state.total_responses >= self.state.limits.total_responses):
                raise BridgeFailure("response_limit_before_vad_input")
            if type(command.get("sequence")) is not int or command["sequence"] != self.input_sequence:
                raise BridgeFailure("input_sequence_mismatch")
            audio = command.get("audio")
            if not isinstance(audio, str) or len(audio) > 44000:
                raise BridgeFailure("invalid_input_pcm")
            try:
                pcm = base64.b64decode(audio, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise BridgeFailure("invalid_input_pcm") from exc
            if not pcm or len(pcm) % 2 or len(pcm) > 32000:
                raise BridgeFailure("invalid_input_pcm")
            if self.input_frames + len(pcm) // 2 > self.state.limits.input_seconds * 16000:
                raise BridgeFailure("input_audio_limit")
            self.input_frames += len(pcm) // 2
            self.uncommitted_frames += len(pcm) // 2
            self.input_sequence += 1
            await self.provider.send({"type": "input_audio_buffer.append", "audio": audio})
            self.record("input_audio", sequence=command["sequence"], frames=len(pcm) // 2)
            await self.emit("input_ack", sequence=command["sequence"], receivedFrames=self.input_frames)
        elif kind == "commit":
            if self.mode != "manual" or self.uncommitted_frames < 1600:
                raise BridgeFailure("manual_commit_requires_audio")
            request_id = self.request_id(command.get("requestId"))
            self.admit(request_id)
            self.uncommitted_frames = 0
            await self.provider.send({"type": "input_audio_buffer.commit"})
            await self.provider.send({"type": "response.create", "response": {"modalities": ["text", "audio"]}})
        elif kind == "cancel":
            target = self.responses.get(self.active_id) if self.active_id else self.pending
            rid, req = command.get("responseId"), command.get("requestId")
            if not target:
                # A completed response can still be playing locally. No remote cancel is needed.
                target = self.responses.get(rid) if rid else None
                if target and target.get("done") and (req is None or req == target["requestId"]):
                    await self.emit("cancel_ack", requestId=target["requestId"], responseId=rid, remoteNeeded=False)
                    return
                raise BridgeFailure("cancel_owner_unknown")
            if (rid is not None and rid != self.active_id) or (req is not None and req != target["requestId"]):
                raise BridgeFailure("cancel_owner_mismatch")
            if not target["revoked"]:
                target["revoked"] = True
                self.record("cancel_requested", requestId=target["requestId"], responseId=self.active_id)
                if self.active_id:
                    await self.provider.send({"type": "response.cancel"})
            await self.emit("cancel_ack", requestId=target["requestId"], responseId=self.active_id,
                            remoteNeeded=bool(self.active_id), pending=not bool(self.active_id))
        else:
            raise BridgeFailure("unsupported_command")

    async def provider_event(self, event):
        kind = event.get("type")
        if not isinstance(kind, str):
            raise BridgeFailure("provider_invalid_event")
        if kind == "error":
            raise BridgeFailure("provider_error")
        if kind == "response.created":
            rid = event.get("response", {}).get("id")
            if not isinstance(rid, str) or not rid or rid in self.responses or self.active_id:
                raise BridgeFailure("response_ownership_unknown")
            if not self.pending:
                if self.mode != "vad" or not self.vad_turn:
                    raise BridgeFailure("response_ownership_unknown")
                self.admit("vad-" + uuid4().hex)
            record = {**self.pending, "responseId": rid, "done": False, "audioFrames": 0,
                      "usage": None, "usageStatus": "pending"}
            self.responses[rid] = record
            self.pending = None
            self.active_id = rid
            self.vad_turn = False
            await self.forward(event, record["requestId"], record["revoked"])
            if record["revoked"]:
                await self.provider.send({"type": "response.cancel"})
            return
        if kind.startswith("response."):
            rid = event.get("response", {}).get("id") if kind == "response.done" else event.get("response_id")
            record = self.responses.get(rid)
            if not record:
                raise BridgeFailure("response_ownership_unknown")
            if kind == "response.audio.delta":
                try:
                    pcm = base64.b64decode(event.get("delta", ""), validate=True)
                except (TypeError, ValueError, binascii.Error) as exc:
                    raise BridgeFailure("invalid_output_pcm") from exc
                if not pcm or len(pcm) % 2:
                    raise BridgeFailure("invalid_output_pcm")
                frames = len(pcm) // 2
                self.output_frames += frames
                record["audioFrames"] += frames
                if self.output_frames > self.state.limits.output_seconds * 24000:
                    raise BridgeFailure("output_audio_limit")
            if record["done"]:
                # Known late data remains visibly revoked; it cannot acquire the new owner.
                if kind == "response.done":
                    raise BridgeFailure("duplicate_response_done")
                await self.forward(event, record["requestId"], True)
                return
            if rid != self.active_id:
                raise BridgeFailure("response_ownership_conflict")
            if kind == "response.done":
                response = event["response"]
                record["done"] = True
                record["status"] = response.get("status")
                usage = response.get("usage")
                known = isinstance(usage, dict) and all(
                    type(usage.get(key)) is int and 0 <= usage[key] <= 10_000_000
                    for key in ("input_tokens", "output_tokens", "total_tokens"))
                known = known and usage["input_tokens"] + usage["output_tokens"] == usage["total_tokens"]
                record["usage"] = usage if known else None
                record["usageStatus"] = "reported" if known else "unknown"
                self.record("usage", responseId=rid, requestId=record["requestId"],
                            usage=record["usage"], usageStatus=record["usageStatus"])
                self.active_id = None
                await self.forward(event, record["requestId"], record["revoked"])
                if not known:
                    self.state.usage_unknown = True
                    raise BridgeFailure("usage_unknown_admission_blocked")
                if record["status"] not in {"completed", "cancelled"}:
                    raise BridgeFailure("provider_response_failed")
                return
            await self.forward(event, record["requestId"], record["revoked"])
            return
        if kind == "input_audio_buffer.speech_started":
            if self.mode != "vad":
                raise BridgeFailure("unexpected_vad_event")
            self.vad_turn = True
            if self.active_id:
                self.responses[self.active_id]["revoked"] = True
        elif kind == "input_audio_buffer.speech_stopped" and event.get("reason") == "turn_invalid":
            self.vad_turn = False
        await self.forward(event)

    async def pump(self):
        try:
            while not self.closed:
                await self.provider_event(await self.provider.receive())
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            if isinstance(exc, BridgeFailure) and str(exc) in {
                "response_ownership_unknown", "response_ownership_conflict", "duplicate_response_done",
                "connection_response_limit", "service_response_limit", "output_audio_limit",
            }:
                # An unsolicited response or data beyond a settled response can
                # represent unknown work even when no local admission is pending.
                self.state.usage_unknown = True
            await self.fail(str(exc) if isinstance(exc, BridgeFailure) else "provider_connection_failed")

    async def watchdog(self):
        try:
            while not self.closed:
                await asyncio.sleep(0.25)
                if time.monotonic() - self.started > self.state.limits.lifetime_seconds:
                    raise BridgeFailure("connection_time_limit")
                record = self.responses.get(self.active_id) if self.active_id else self.pending
                if record and time.monotonic() - record["started"] > self.state.limits.response_seconds:
                    raise BridgeFailure("response_time_limit")
        except asyncio.CancelledError:
            pass
        except BridgeFailure as exc:
            await self.fail(str(exc))

    async def fail(self, reason):
        if self.closed:
            return
        self.record("error", code=reason)
        try:
            await self.emit("error", code=reason, fatal=True)
        finally:
            await self.close(reason)

    async def close(self, reason="client_disconnected"):
        if self.closed:
            return
        self.closed, self.ready, self.close_reason = True, False, reason
        if self.pending or any(not record["done"] for record in self.responses.values()):
            self.state.usage_unknown = True
            for record in self.responses.values():
                if not record["done"]:
                    record["usageStatus"] = "unknown"
        for task in (self.pump_task, self.watchdog_task):
            if task and task is not asyncio.current_task():
                task.cancel()
        if self.provider:
            try:
                await asyncio.wait_for(self.provider.close(), 3)
            except Exception:
                self.record("provider_close_failed")
                self.state.usage_unknown = True
        self.record("closed", reason=reason)
        if self.state.log_dir:
            data = {"connectionId": self.connection_id, "model": MODEL, "voice": VOICE,
                    "mode": self.mode, "inputFrames": self.input_frames, "outputFrames": self.output_frames,
                    "responseCount": self.response_count, "reason": reason,
                    "usageUnknown": self.state.usage_unknown, "events": self.audit,
                    "boundary": "Protocol events only; no audio, transcript, credentials or physical playback evidence."}
            try:
                await asyncio.to_thread(self.write_log, data)
            except OSError:
                # No raw exception/path is printed or sent to the browser.
                pass
        try:
            await self.emit("closed", reason=reason, usageUnknown=self.state.usage_unknown)
        finally:
            await self.browser.close()

    def write_log(self, data):
        self.state.log_dir.mkdir(parents=True, exist_ok=True)
        (self.state.log_dir / f"{self.connection_id}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def allowed_request(request, require_origin=False):
    address = request.transport.get_extra_info("sockname") if request.transport else None
    port = address[1] if address else None
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    if request.remote not in {"127.0.0.1", "::1"} or request.headers.get("Host") not in hosts:
        return False
    origin = request.headers.get("Origin")
    return origin in {"http://" + host for host in hosts} if require_origin or origin else True


async def websocket_handler(request):
    if not allowed_request(request, require_origin=True):
        raise web.HTTPForbidden(text="Invalid origin")
    state = request.app[APP_STATE]
    # One browser connection prevents a second tab from spending the shared budget.
    if state.bridges:
        raise web.HTTPConflict(text="A local experiment is already connected")
    socket = web.WebSocketResponse(max_msg_size=100_000, heartbeat=20)
    bridge = Bridge(state, socket)
    # Claim the single connection slot before the first await; concurrent upgrade
    # requests must not both observe an empty set while prepare() yields.
    state.bridges.add(bridge)
    try:
        await socket.prepare(request)
        # Bound even an upgraded socket that never sends connect. Cancellation
        # also unwinds an in-progress provider handshake before final cleanup.
        async with asyncio.timeout(state.limits.lifetime_seconds):
            async for message in socket:
                if message.type != WSMsgType.TEXT:
                    if message.type in {WSMsgType.ERROR, WSMsgType.BINARY}:
                        await bridge.fail("invalid_browser_message")
                    break
                try:
                    await bridge.command(json.loads(message.data))
                except Exception as exc:
                    await bridge.fail(str(exc) if isinstance(exc, BridgeFailure) else
                                      "connection_timeout" if isinstance(exc, TimeoutError) else "invalid_or_failed_command")
                    break
    except TimeoutError:
        await bridge.fail("connection_time_limit")
    finally:
        if socket.prepared:
            await bridge.close()
        state.bridges.discard(bridge)
    return socket


async def status_handler(request):
    if not allowed_request(request):
        raise web.HTTPForbidden(text="Invalid host")
    state = request.app[APP_STATE]
    return web.json_response({"experimental": True, "configured": bool(state.config.key), "model": MODEL,
                              "voice": VOICE, "totalResponses": state.total_responses,
                              "usageUnknownBlocked": state.usage_unknown,
                              "connected": bool(state.bridges), "limits": vars(state.limits)},
                             headers={"Cache-Control": "no-store"})


async def static_handler(request):
    if not allowed_request(request):
        raise web.HTTPForbidden(text="Invalid host")
    root = request.app[APP_STATE].root
    name = request.path
    if "\x00" in name or "\\" in name or any(part.startswith(".") for part in name.split("/")):
        raise web.HTTPForbidden(text="Path denied")
    if name == "/":
        raise web.HTTPFound("/qwen/")
    aliases = {"/sample.wav": "audio/chinese-probe.wav",
               "/data/chinese-probe.json": "outputs/chinese-probe.json",
               "/data/waveform.json": "outputs/waveform.json",
               "/preview/studio/motion-rig.js": "preview/studio/motion-rig.js"}
    mounts = [("/preview/core/", "preview/core"), ("/model/", "assets/Aemeath"),
              ("/node_modules/three/", "preview/node_modules/three"),
              ("/node_modules/@takahirox/three-mmd/", "preview/node_modules/@takahirox/three-mmd"),
              ("/node_modules/mmd-parser/", "preview/node_modules/mmd-parser")]
    if name in aliases:
        base = (root / aliases[name]).parent.resolve()
        target = (root / aliases[name]).resolve()
    else:
        prefix, directory = next(((p, d) for p, d in mounts if name.startswith(p)), ("/", "realtime"))
        base = (root / directory).resolve()
        relative = name[len(prefix):] + ("index.html" if name.endswith("/") else "")
        target = (base / relative).resolve()
    # Server implementation and test/credential files are never browser resources.
    if (not target.is_relative_to(base) or target == base or not target.is_file()
            or target.suffix.lower() not in {".html", ".js", ".mjs", ".css", ".json", ".wav",
                                               ".png", ".jpg", ".jpeg", ".bmp", ".pmx", ".tga"}):
        raise web.HTTPNotFound(text="Local resource unavailable")
    if target.suffix in {".js", ".mjs"}:
        content_type = "text/javascript"
    else:
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    body = await asyncio.to_thread(target.read_bytes)
    return web.Response(body=body, content_type=content_type, headers={
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"})


def create_app(config=None, *, root=FACE_ROOT, log_dir=None, limits=None, provider_factory=connect_provider):
    app = web.Application(client_max_size=100_000)
    app[APP_STATE] = State(config or Config(), Path(root), Path(log_dir) if log_dir else None,
                           limits or Limits(), provider_factory)
    app.router.add_get("/api/status", status_handler)
    app.router.add_get("/api/qwen", websocket_handler)
    app.router.add_get("/{path:.*}", static_handler)
    async def shutdown(application):
        for bridge in tuple(application[APP_STATE].bridges):
            await bridge.close("server_shutdown")
    app.on_shutdown.append(shutdown)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18769)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--max-responses", type=int, default=12,
                        help="Reduce this explicitly started batch's response limit (1-12).")
    parser.add_argument("--log-dir", type=Path, default=FACE_ROOT / "outputs/qwen-live-avatar-20261015/server")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    if not 1 <= args.max_responses <= 12:
        parser.error("max-responses must be between 1 and 12")
    try:
        config = load_config(args.env_file)
    except BridgeFailure as exc:
        parser.exit(2, str(exc) + "\n")
    app = create_app(config, log_dir=args.log_dir, limits=Limits(total_responses=args.max_responses))
    print(f"Experimental Qwen avatar: http://127.0.0.1:{args.port}/qwen/ (configured={bool(config.key)})", flush=True)
    web.run_app(app, host="127.0.0.1", port=args.port, print=None, access_log=None)


if __name__ == "__main__":
    main()
