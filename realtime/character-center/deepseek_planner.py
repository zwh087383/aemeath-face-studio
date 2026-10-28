"""Original-tool DeepSeek adapter for the protected character planner pipeline.

Cancellation retires local delivery immediately but drains the paid HTTP response
to its terminal usage. No tool receipt creates a second model response.
"""
import asyncio
from contextlib import suppress
from dataclasses import dataclass, field
import importlib.util
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
from uuid import uuid4

spec = importlib.util.spec_from_file_location("deepseek_original_tools", Path(__file__).with_name("protocol.py"))
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)
from tools.voice_avatar.duplex_transport import ProtocolError

ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
MAX_REQUEST_BYTES = 128 * 1024
PROTOCOL_TOKEN_MARGIN = 8192
MAX_OUTPUT_TOKENS = 2048


def request_token_bound(size):
    if type(size) is not int or not 0 < size <= MAX_REQUEST_BYTES:
        raise ProtocolError("deepseek_request_size_bound")
    return {"input": size + PROTOCOL_TOKEN_MARGIN, "output": MAX_OUTPUT_TOKENS,
            "source": f"deepseek_compact_utf8_request_{size}_plus_protocol_{PROTOCOL_TOKEN_MARGIN}_explicit_output_{MAX_OUTPUT_TOKENS}"}


@dataclass(frozen=True)
class DeepSeekConfig:
    key: str = field(repr=False)
    model: str = "deepseek-flash"
    url: str = "https://api.deepseek.com"
    proxy: str | None = None

    @classmethod
    def from_file(cls, path, *, proxy=None):
        values = {}
        for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip("\"'")
        key = values.get("DEEPSEEK_API_KEY")
        if not key and values.get("DEEPSEEK_API_KEY_PATH"):
            key = Path(values["DEEPSEEK_API_KEY_PATH"]).read_text(encoding="utf-8-sig").strip()
        url = values.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
        parsed = urlsplit(url)
        if (not key or parsed.scheme != "https" or parsed.hostname != "api.deepseek.com"
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("deepseek_configuration_invalid")
        return cls(key, values.get("AMIS_TEXT_MODEL", "deepseek-flash"), url, proxy)


class DeepSeekPlannerConnection:
    provider = "deepseek"
    # Until context is frozen this is the explicit maximum. The pipeline calls
    # add_context before reserving, so each new reservation uses its exact byte
    # upper bound plus the same protocol allowance. Existing ledgers are untouched.
    token_bound = request_token_bound(MAX_REQUEST_BYTES)

    def __init__(self, *, config, catalog=None, factory=None, http_factory=None):
        # factory is the Qwen voice socket factory; deliberately not consumed here.
        self.config = config
        self.catalog = protocol.load_catalog(catalog)
        self.http_factory = http_factory
        self.id = "deepseek-planner-" + uuid4().hex
        self.events = asyncio.Queue()
        self.configured = self.claimed = self.cancelled = False
        self.client = self.task = None
        self.body = None
        self.request_bytes = None
        self.request_size_bytes = 0
        self.receipts = []

    async def open(self, **_):
        if self.client is not None:
            raise ProtocolError("planner_connection_already_open")
        if self.http_factory:
            self.client = self.http_factory()
        else:
            import aiohttp
            self.client = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=35, connect=10), trust_env=False)
        async with self.client.get(self.config.url + "/models", headers={"Authorization": "Bearer " + self.config.key},
                                   proxy=self.config.proxy) as response:
            await response.read()
            if response.status != 200:
                raise ProtocolError("deepseek_prewarm_failed")
        self.configured = True
        return {"model": self.config.model, "provider": self.provider, "modalities": ["text"],
                "thinking": "disabled", "tools": [t["function"]["name"] for t in protocol.tools(self.catalog)]}

    async def add_context(self, messages, *, batch=False):
        if not self.configured or self.claimed or self.body is not None:
            raise ProtocolError("deepseek_context_state_invalid")
        if not messages or any(m.get("role") != "user" or not isinstance(m.get("content"), str) for m in messages):
            raise ProtocolError("deepseek_context_invalid")
        body = {"model": self.config.model, "messages": [{"role":"system", "content":protocol.RULES}, *messages],
            "tools": protocol.tools(self.catalog), "thinking": {"type":"disabled"},
            "stream": True, "stream_options": {"include_usage": True}, "max_tokens": MAX_OUTPUT_TOKENS}
        # Serialize once and send these exact bytes. aiohttp's default json=
        # encoding escapes Chinese text and previously differed from the size
        # check. No action, condition, history field or tool schema is omitted.
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_REQUEST_BYTES:
            raise ProtocolError("deepseek_request_size_bound")
        self.body, self.request_bytes, self.request_size_bytes = body, encoded, len(encoded)
        self.token_bound = request_token_bound(self.request_size_bytes)

    async def send(self, event):
        kind = event.get("type")
        if kind == "response.cancel":
            self.cancelled = True
            return  # Local delivery is already retired; keep draining real usage.
        if kind == "conversation.item.create" and event.get("item", {}).get("type") == "function_call_output":
            self.receipts.append(event["item"]["call_id"])
            return  # Notification acknowledgement is not another HTTP generation.
        if kind != "response.create" or self.body is None or self.request_bytes is None or self.task is not None:
            raise ProtocolError("deepseek_request_state_invalid")
        self.claimed = True
        self.task = asyncio.create_task(self._stream())

    async def receive(self, timeout=30):
        event = await asyncio.wait_for(self.events.get(), timeout)
        observer = getattr(self, "observed", None)
        if observer:
            observer(event)
        if event["type"] == "error":
            raise ProtocolError("deepseek_stream_failed")
        return event

    async def _stream(self):
        response_id, usage, finish = None, None, None
        calls, created, complete = {}, False, False
        def emit(kind, **value):
            self.events.put_nowait({"type":kind, "response_id":response_id, **value})
        try:
            async with self.client.post(self.config.url + "/chat/completions", data=self.request_bytes,
                    headers={"Authorization":"Bearer " + self.config.key, "Content-Type":"application/json; charset=utf-8"}, proxy=self.config.proxy) as response:
                if response.status != 200:
                    raise ProtocolError("deepseek_http_failed")
                async for line in response.content:
                    if not line.startswith(b"data:"):
                        continue
                    data = line[5:].strip()
                    if data == b"[DONE]":
                        if not created or not finish:
                            raise ProtocolError("deepseek_terminal_invalid")
                        status = ("cancelled" if self.cancelled else "incomplete" if finish == "length"
                                  else "completed" if finish in {"stop", "tool_calls"} else "failed")
                        emit("response.done", response={"id":response_id,"status":status,"usage":usage})
                        return
                    value = json.loads(data)
                    incoming_id = value.get("id")
                    if not created:
                        if not isinstance(incoming_id, str) or not ID.fullmatch(incoming_id):
                            raise ProtocolError("deepseek_response_id_invalid")
                        response_id, created = incoming_id, True
                        emit("response.created", response={"id":response_id, "model":self.config.model})
                    elif incoming_id and incoming_id != response_id:
                        raise ProtocolError("deepseek_response_owner_conflict")
                    if value.get("usage"):
                        raw = value["usage"]
                        usage = {"input_tokens":raw.get("prompt_tokens"), "output_tokens":raw.get("completion_tokens"),
                            "total_tokens":raw.get("total_tokens"), "prompt_cache_hit_tokens":raw.get("prompt_cache_hit_tokens"),
                            "prompt_cache_miss_tokens":raw.get("prompt_cache_miss_tokens")}
                    for choice in value.get("choices", []):
                        if choice.get("index", 0) != 0:
                            raise ProtocolError("deepseek_multiple_choices")
                        delta = choice.get("delta", {})
                        if delta.get("content"):
                            emit("response.output_text.delta", delta=delta["content"])
                        for part in delta.get("tool_calls", []):
                            index = part.get("index")
                            if type(index) is not int or index < 0:
                                raise ProtocolError("deepseek_tool_index_invalid")
                            item = calls.setdefault(index, {"name":"", "arguments":"", "added":False})
                            function = part.get("function", {})
                            item["name"] += function.get("name") or ""
                            if part.get("id"):
                                item["call_id"] = part["id"]
                            argument_delta = function.get("arguments") or ""
                            item["arguments"] += argument_delta
                            if len(item["arguments"]) > protocol.MAX_PACKET:
                                raise ProtocolError("deepseek_tool_size_bound")
                            item_id = "ds_item_" + str(index)
                            if not item["added"]:
                                item["added"] = True
                                emit("response.output_item.added", item={"type":"function_call", "id":item_id,
                                    "name":item["name"], "call_id":item.get("call_id")})
                            if argument_delta:
                                emit("response.function_call_arguments.delta", item_id=item_id, delta=argument_delta)
                        if choice.get("finish_reason"):
                            finish = choice["finish_reason"]
                            if complete:
                                raise ProtocolError("deepseek_duplicate_finish")
                            complete = True
                            for index, item in calls.items():
                                emit("response.function_call_arguments.done", item_id="ds_item_"+str(index),
                                    call_id=item.get("call_id"), name=item["name"], arguments=item["arguments"])
                raise ProtocolError("deepseek_stream_missing_done")
        except asyncio.CancelledError:
            raise
        except Exception:
            emit("error", code="deepseek_stream_failed")

    async def close(self):
        if self.task and not self.task.done():
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task
        if self.client:
            await self.client.close()
