"""Bounded, paired planner-only probe. No voice, runtime writes or tool execution.

Imports are offline. --execute explicitly authorizes a new, non-resumable batch.
Rules, tool schemas and the serialized user payload are identical across providers.
"""
from __future__ import annotations
import argparse
import asyncio
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
LIMIT = 12


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


protocol = load("provider_probe_protocol", HERE / "protocol.py")
view = load("provider_probe_view", HERE / "planner_input.py")


def digest(value):
    return hashlib.sha256(view.encoded(value).encode()).hexdigest()


def save(path, value):
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    temp.replace(path)


class Ledger:
    def __init__(self, path):
        self.path = Path(path)
        # Existing batches cannot be silently retried, resumed or reset.
        if self.path.exists():
            raise ValueError("existing_batch_preserved")
        self.data = {"limit": LIMIT, "perProvider": 6, "rows": [], "blocked": False}
        save(self.path, self.data)

    def reserve(self, provider, case, repeat):
        rows = self.data["rows"]
        if self.data["blocked"] or len(rows) >= LIMIT or sum(r["provider"] == provider for r in rows) >= 6:
            raise ValueError("batch_admission_closed")
        row = {"provider": provider, "case": case, "repeat": repeat, "state": "reserved"}
        rows.append(row)
        save(self.path, self.data)
        return row

    def settle(self, row, result):
        usage = result.get("usage")
        valid = isinstance(usage, dict) and all(type(usage.get(k)) is int and usage[k] >= 0
                    for k in ("input_tokens", "output_tokens", "total_tokens"))
        row.update(state="reported" if valid and result.get("terminal") else "unknown", usage=usage)
        if row["state"] == "unknown":
            self.data["blocked"] = True
        save(self.path, self.data)


def fixtures(baseline):
    """Freeze observed state as explicit offline test inputs, not a live session."""
    session = json.loads(next(baseline.glob("duplex-*.json")).read_text(encoding="utf-8"))
    client = json.loads((baseline / "client-live-5e4c9584e38d4c57a4096600695063dd.json").read_text(encoding="utf-8"))
    emotion = next(e["state"] for e in session["events"] if e["type"] == "character_math")
    actor = next(e["result"]["actor"] for e in session["events"] if e["type"] == "character_execution_feedback")
    state = {k: deepcopy(emotion.get(k)) for k in ("emotion", "effectiveEnergy", "stateError")}
    state.update(actor=deepcopy(actor), authority="mathematical_read_only")
    base = {"character_state": state, "future_reply_available": False,
        **view.context_view([], ""), "available_actions": view.compact_catalog(protocol.load_catalog()),
        "current_plan": [], "execution_feedback": [],
        "execution_policy": "model selects; actual body conditions checked locally; no per-turn action cap"}
    normal = deepcopy(base)
    normal.update(current_user_text=client["trials"][1]["text"],
        delivered_context=[{"role": "user", "content": client["trials"][0]["text"]}],
        dialogue_state={"delivered": False, "cancelled": False, "playback": {}},
        source_scope="user", evidence_refs=["user:probe-memory"], turn_id="probe-memory",
        media_anchor={"kind": "immediate"})
    reading = json.loads((baseline / "reading-cases.json").read_text(encoding="utf-8"))["reading-complete"]
    observed = next(e for e in reading["events"] if e["status"] == "running")
    activity = deepcopy(base)
    activity.update(source_scope="activity", evidence_refs=["activity:reading-complete:3"],
        activity_id="reading-complete", activity=view.activity_view(observed),
        media_anchor={"kind": "immediate"})
    finished = deepcopy(normal)
    feedback = next(e["result"] for e in session["events"] if e["type"] == "character_execution_feedback"
        and e["result"]["action"] == "gesture:wave" and e["result"]["status"] == "completed")
    finished.update(evidence_refs=["execution:probe-wave-completed"], execution_feedback=[deepcopy(feedback)])
    return {"memory_question": normal, "reading_start": activity, "wave_completed": finished}


def validate_call(name, raw, payload):
    if name == "perform_actions":
        return protocol.parse_actions(raw)
    if name == "set_expression":
        result = protocol.parse_expression(raw)
        if result["evidenceRef"] not in payload["evidence_refs"]:
            raise ValueError("unprovided_expression_evidence")
        return result
    raise ValueError("unknown_tool")


class Trace:
    def __init__(self, payload):
        self.payload = payload
        self.start = time.perf_counter()
        self.value = {"timingsMs": {}, "calls": [], "events": [], "terminal": False}

    def ms(self):
        return round((time.perf_counter() - self.start) * 1000, 3)

    def mark(self, name):
        self.value["timingsMs"].setdefault(name, self.ms())

    def complete(self, name, raw):
        self.mark("firstCompleteTool")
        try:
            parsed = validate_call(name, raw, self.payload)
            if name == "perform_actions":
                self.mark("firstValidBody")
            self.value["calls"].append({"name": name, "valid": True, "command": parsed, "atMs": self.ms()})
        except (ValueError, TypeError):
            self.value["calls"].append({"name": name, "valid": False, "arguments": raw, "atMs": self.ms()})


async def deepseek(http, config, payload, trace, *, rules=None, tool_schema=None):
    body = {"model": config["model"], "messages": [
        {"role": "system", "content": protocol.RULES if rules is None else rules}, {"role": "user", "content": view.encoded(payload)}],
        "tools": protocol.tools() if tool_schema is None else tool_schema, "thinking": {"type": "disabled"},
        "stream": True, "stream_options": {"include_usage": True}, "max_tokens": 2048}
    buffers = {}
    trace.mark("requestSent")
    async with http.post(config["url"].rstrip("/") + "/chat/completions", json=body,
            headers={"Authorization": "Bearer " + config["key"]}, proxy=config["proxy"]) as response:
        trace.value["httpStatus"] = response.status
        trace.mark("headers")
        if response.status != 200:
            raise ValueError("provider_http_error")
        async for line in response.content:
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                trace.value["terminal"] = True
                trace.mark("streamDone")
                break
            event = json.loads(data)
            trace.mark("firstStreamChunk")
            trace.value["responseModel"] = event.get("model")
            trace.value["responseId"] = event.get("id")
            usage = event.get("usage")
            if usage:
                trace.value["usage"] = {"input_tokens": usage.get("prompt_tokens"),
                    "output_tokens": usage.get("completion_tokens"), "total_tokens": usage.get("total_tokens"),
                    "prompt_cache_hit_tokens": usage.get("prompt_cache_hit_tokens"),
                    "prompt_cache_miss_tokens": usage.get("prompt_cache_miss_tokens")}
            for choice in event.get("choices", []):
                delta = choice.get("delta", {})
                if delta.get("content"):
                    trace.value["unexpectedText"] = trace.value.get("unexpectedText", "") + delta["content"]
                for call in delta.get("tool_calls", []):
                    trace.mark("firstToolItem")
                    item = buffers.setdefault(call["index"], {"name": "", "arguments": ""})
                    function = call.get("function", {})
                    item["name"] += function.get("name") or ""
                    addition = function.get("arguments") or ""
                    item["arguments"] += addition
                    if len(item["arguments"]) > protocol.MAX_PACKET:
                        raise ValueError("argument_packet_limit")
                    if addition:
                        trace.mark("firstArgumentDelta")
                        # Diagnostic only; partial JSON is NEVER executed.
                        try:
                            validate_call(item["name"], item["arguments"], payload)
                            if item["name"] == "perform_actions":
                                trace.mark("firstParsableBody")
                        except (ValueError, TypeError):
                            pass
                if choice.get("finish_reason"):
                    trace.mark("finishReason")
                    trace.value["finishReason"] = choice["finish_reason"]
                    for item in buffers.values():
                        trace.complete(item["name"], item["arguments"])
            trace.value["events"].append({"atMs": trace.ms(), "event": event})


async def qwen(http, config, payload, trace, reserve):
    # Same connection implementation and configuration as the existing planner.
    backend = load("provider_probe_backend", HERE / "backend.py")
    async def factory():
        endpoint = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
        if config.get("workspace"):
            endpoint = f"wss://{config['workspace']}.workspace.beijing.maas.aliyuncs.com/api-ws/v1/realtime"
        return await http.ws_connect(endpoint + "?model=" + backend.base.MODEL,
            headers={"Authorization": "Bearer " + config["key"]}, proxy=config["proxy"], max_msg_size=2*1024*1024)
    connection = backend.CharacterPlannerConnection(factory=factory)
    try:
        setup = time.perf_counter()
        echo = await connection.open()
        trace.value["connectionSetupMs"] = round((time.perf_counter() - setup)*1000, 3)
        context = time.perf_counter()
        await connection.add_context([{"role": "user", "content": view.encoded(payload)}], batch=True)
        trace.value["contextAckMs"] = round((time.perf_counter() - context)*1000, 3)
        reserve()
        trace.start = time.perf_counter()
        trace.value["responseModel"] = echo["model"]
        trace.mark("requestSent")
        await connection.send({"type": "response.create", "response": {"modalities": ["text"]}})
        items = {}
        response_id = None
        while True:
            event = await connection.receive(timeout=30)
            kind = event["type"]
            trace.value["events"].append({"atMs": trace.ms(), "event": event})
            if kind == "response.created":
                response_id = event["response"]["id"]
                trace.value["responseId"] = response_id
                trace.mark("firstStreamChunk")
            elif kind.startswith("response.") and event.get("response_id", event.get("response", {}).get("id")) != response_id:
                raise ValueError("response_owner_mismatch")
            if kind == "response.output_item.added":
                item = event["item"]
                if item.get("type") == "function_call":
                    items[item["id"]] = item
                    trace.mark("firstToolItem")
            elif kind == "response.function_call_arguments.delta":
                trace.mark("firstArgumentDelta")
            elif kind == "response.function_call_arguments.done":
                name = event.get("name") or items.get(event.get("item_id"), {}).get("name")
                trace.complete(name, event.get("arguments"))
            elif kind == "response.done":
                trace.mark("streamDone")
                trace.value.update(terminal=True, usage=event["response"].get("usage"), finishReason=event["response"].get("status"))
                break
    finally:
        await connection.close()


def configuration(env_file, proxy):
    # Read only explicit provider entries; never print credential values/paths.
    values = {}
    for line in env_file.read_text(encoding="utf-8-sig").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("\"'")
    key = values.get("DEEPSEEK_API_KEY")
    if not key and values.get("DEEPSEEK_API_KEY_PATH"):
        key = Path(values["DEEPSEEK_API_KEY_PATH"]).read_text(encoding="utf-8-sig").strip()
    ds = {"model": values.get("AMIS_TEXT_MODEL", "deepseek-flash"),
        "url": values.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"), "key": key, "proxy": proxy}
    if urlsplit(ds["url"]).hostname != "api.deepseek.com" or not key or not values.get("DASHSCOPE_API_KEY"):
        raise ValueError("expected_provider_configuration_unavailable")
    return {"deepseek": ds, "qwen": {"key": values["DASHSCOPE_API_KEY"],
        "workspace": values.get("DASHSCOPE_WORKSPACE_ID"), "proxy": proxy}}


def summarize(results):
    from statistics import median
    summary = {}
    for provider in ("deepseek", "qwen"):
        rows = [r for r in results if r["provider"] == provider]
        summary[provider] = {"n": len(rows), "validCalls": sum(x["valid"] for r in rows for x in r["calls"]),
            "invalidCalls": sum(not x["valid"] for r in rows for x in r["calls"]), "timingsMs": {}}
        for metric in ("firstArgumentDelta", "firstCompleteTool", "firstValidBody", "streamDone"):
            values = [r["timingsMs"][metric]-r["timingsMs"]["requestSent"] for r in rows if metric in r["timingsMs"]]
            summary[provider]["timingsMs"][metric] = {"n":len(values), "median":median(values), "min":min(values), "max":max(values)} if values else {"n":0}
    return summary


async def run(args):
    import aiohttp
    args.output.mkdir(parents=True, exist_ok=True)
    ledger = Ledger(args.output / "ledger.json")
    cases = fixtures(args.baseline)
    config = configuration(args.env_file, "http://127.0.0.1:7890" if args.local_proxy else None)
    manifest = {"experimental": True, "sourceBaseline": "c50f0b8", "scope": "planner_only_frozen_observed_inputs",
        "rules": protocol.RULES, "tools": protocol.tools(), "cases": cases,
        "hashes": {"rules": digest(protocol.RULES), "tools": digest(protocol.tools()),
            "payloads": {k:digest(v) for k,v in cases.items()}},
        "rulesUnmodified": True, "toolSchemasUnmodified": True, "deepseekModel": config["deepseek"]["model"],
        "deepseekThinking": "disabled", "limit": LIMIT, "perProvider": 6,
        "transport": "existing_local_proxy" if args.local_proxy else "direct",
        "warmup": "DeepSeek GET models without generation; Qwen fresh configured WS before request timer",
        "fairnessLimits": "Same semantic inputs; different provider APIs, tokenizer, caches and native settings. Not browser/end-to-end latency."}
    save(args.output / "manifest.json", manifest)
    results = []
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=45, connect=15), trust_env=False) as http:
        # Warm TLS without buying an extra model response.
        ds = config["deepseek"]
        async with http.get(ds["url"].rstrip("/") + "/models", headers={"Authorization": "Bearer " + ds["key"]}, proxy=ds["proxy"]) as warm:
            await warm.read()
            if warm.status != 200:
                raise ValueError("deepseek_transport_warmup_failed")
        for repeat in range(2):
            for index, (case, payload) in enumerate(cases.items()):
                order = ("deepseek", "qwen") if (repeat+index)%2 == 0 else ("qwen", "deepseek")
                for provider in order:
                    trace = Trace(payload)
                    row = None
                    def reserve():
                        nonlocal row
                        row = ledger.reserve(provider, case, repeat)
                    try:
                        if provider == "deepseek":
                            reserve()
                            trace.start = time.perf_counter()
                            await deepseek(http, config[provider], payload, trace)
                        else:
                            await qwen(http, config[provider], payload, trace, reserve)
                    except Exception as exc:
                        trace.value["error"] = type(exc).__name__  # No credential-bearing exception strings.
                    finally:
                        if row is not None:
                            ledger.settle(row, trace.value)
                    result = {"provider": provider, "case": case, "repeat": repeat,
                        "payloadHash": digest(payload), **trace.value}
                    save(args.output / f"{len(results)+1:02d}-{provider}-{case}-r{repeat+1}.json", result)
                    results.append({k:v for k,v in result.items() if k != "events"})
                    save(args.output / "results.json", results)
                    print(json.dumps({"provider": provider, "case": case, "repeat": repeat+1,
                        "timingsMs": trace.value["timingsMs"], "error": trace.value.get("error"),
                        "calls": trace.value["calls"]}, ensure_ascii=False), flush=True)
                    if ledger.data["blocked"] or trace.value.get("error"):
                        return
    save(args.output / "summary.json", summarize(results))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--wai-root", type=Path, required=True)
    parser.add_argument("--local-proxy", action="store_true")
    args = parser.parse_args()
    if not args.execute:
        parser.error("Explicit --execute required; import and tests never call cloud")
    sys.path.insert(0, str(args.wai_root))
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
