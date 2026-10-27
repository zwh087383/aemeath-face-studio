"""DeepSeek-only original/compact output comparison, at most 12 responses.

Does not execute tools, start WAI, generate speech or change the live provider.
"""
import argparse
import asyncio
import json
from pathlib import Path
from statistics import median
import time

import provider_probe as base
from compact_protocol import Codec


class FormatLedger(base.Ledger):
    def __init__(self, path):
        self.path = Path(path)
        if self.path.exists():
            raise ValueError("existing_batch_preserved")
        self.data = {"provider": "deepseek", "limit": 12, "perVariant": 6,
                     "rows": [], "blocked": False}
        base.save(self.path, self.data)

    def reserve(self, variant, case, repeat):
        rows = self.data["rows"]
        if (variant not in {"original", "compact"} or self.data["blocked"] or len(rows) >= 12
                or sum(row["variant"] == variant for row in rows) >= 6):
            raise ValueError("batch_admission_closed")
        row = {"variant": variant, "case": case, "repeat": repeat, "state": "reserved"}
        rows.append(row)
        base.save(self.path, self.data)
        return row


class CompactTrace(base.Trace):
    def __init__(self, payload, codec):
        super().__init__(payload)
        self.codec = codec

    def complete(self, name, raw):
        self.mark("firstCompleteTool")
        wire = {"name": name, "arguments": raw, "atMs": self.ms()}
        self.value.setdefault("wireCalls", []).append(wire)
        try:
            if name != "p":
                raise ValueError("unknown_compact_tool")
            commands = self.codec.decode(raw, self.payload)
            wire["valid"] = True
            for canonical_name, command in commands:
                if canonical_name == "perform_actions":
                    self.mark("firstValidBody")
                self.value["calls"].append({"name": canonical_name, "valid": True,
                    "command": command, "atMs": self.ms(), "wireTool": "p"})
        except (ValueError, TypeError):
            wire["valid"] = False
            self.value["calls"].append({"name": "p", "valid": False, "arguments": raw, "atMs": self.ms()})


def summarize(results):
    summary = {}
    for variant in ("original", "compact"):
        rows = [r for r in results if r["variant"] == variant]
        timing = {}
        for key in ("firstArgumentDelta", "firstCompleteTool", "firstValidBody", "streamDone"):
            values = [r["timingsMs"][key]-r["timingsMs"]["requestSent"] for r in rows if key in r["timingsMs"]]
            timing[key] = {"n": len(values), "median": median(values), "min": min(values), "max": max(values)} if values else {"n": 0}
        summary[variant] = {"n": len(rows), "timingsMs": timing,
            "outputTokens": {"median": median(r["usage"]["output_tokens"] for r in rows),
                             "total": sum(r["usage"]["output_tokens"] for r in rows)},
            "inputTokens": {"median": median(r["usage"]["input_tokens"] for r in rows)},
            "totalTokens": sum(r["usage"]["total_tokens"] for r in rows),
            "invalidCalls": sum(not call["valid"] for r in rows for call in r["calls"])}
    return summary


async def run(args):
    import aiohttp
    args.output.mkdir(parents=True, exist_ok=True)
    codec = Codec()
    cases = {key: codec.payload(value) for key, value in base.fixtures(args.baseline).items()}
    rules = {"original": base.protocol.RULES, "compact": codec.rules()}
    schemas = {"original": base.protocol.tools(), "compact": codec.tools()}
    config = base.configuration(args.env_file, "http://127.0.0.1:7890" if args.local_proxy else None)["deepseek"]
    ledger = FormatLedger(args.output / "ledger.json")
    schedule = []
    for repeat in range(2):
        for index, case in enumerate(cases):
            order = ("original", "compact") if (repeat+index)%2 == 0 else ("compact", "original")
            schedule.extend({"variant": v, "case": case, "repeat": repeat} for v in order)
    manifest = {"experimental": True, "scope": "format_only_planner_probe_no_execution", "provider": config["model"],
        "thinking": "disabled", "limit": 12, "perVariant": 6, "schedule": schedule,
        "cases": cases, "rules": rules, "schemas": schemas,
        "actionCodebookVersion": codec.version, "actionCodebook": list(enumerate(codec.ids)),
        "hashes": {"cases": {k:base.digest(v) for k,v in cases.items()},
            "rules": {k:base.digest(v) for k,v in rules.items()},
            "schemas": {k:base.digest(v) for k,v in schemas.items()}},
        "sourceHashes": {path.name: __import__('hashlib').sha256(path.read_bytes()).hexdigest() for path in
            [Path(__file__), base.HERE/'provider_probe.py', base.HERE/'compact_protocol.py', base.HERE/'protocol.py']},
        "fairnessLimits": "Exact same semantic and serialized payload in both arms, including numbered catalogue. Schema and encoding instructions necessarily differ; cache hits are measured."}
    base.save(args.output / "manifest.json", manifest)
    results = []
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=45, connect=15), trust_env=False) as http:
        async with http.get(config["url"].rstrip("/")+"/models", headers={"Authorization": "Bearer "+config["key"]}, proxy=config["proxy"]) as warm:
            await warm.read()
            if warm.status != 200:
                raise ValueError("transport_warmup_failed")
        for case in schedule:
            variant = case["variant"]
            payload = cases[case["case"]]
            trace = CompactTrace(payload, codec) if variant == "compact" else base.Trace(payload)
            row = ledger.reserve(variant, case["case"], case["repeat"])
            trace.start = time.perf_counter()
            try:
                await base.deepseek(http, config, payload, trace, rules=rules[variant], tool_schema=schemas[variant])
            except Exception as exc:
                trace.value["error"] = type(exc).__name__
            finally:
                ledger.settle(row, trace.value)
            result = {**case, "provider": config["model"], "payloadHash": base.digest(payload), **trace.value}
            base.save(args.output / f"{len(results)+1:02d}-{variant}-{case['case']}-r{case['repeat']+1}.json", result)
            results.append({k:v for k,v in result.items() if k != "events"})
            base.save(args.output / "results.json", results)
            print(json.dumps({**case, "timingsMs":trace.value["timingsMs"], "usage":trace.value.get("usage"),
                "calls":trace.value["calls"], "error":trace.value.get("error")}, ensure_ascii=False), flush=True)
            if ledger.data["blocked"] or trace.value.get("error"):
                return
    base.save(args.output / "summary.json", summarize(results))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--local-proxy", action="store_true")
    args = parser.parse_args()
    if not args.execute:
        parser.error("Explicit --execute required")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
