"""One durable, channel-bounded ledger for this isolated experimental batch.

No imports load credentials. Missing usage with an observed terminal retains the
full documented maximum. A missing terminal freezes the affected channel.
"""
from __future__ import annotations

import asyncio
from functools import wraps
import json
from pathlib import Path
import threading
import time
from uuid import uuid4

from tools.voice_avatar.duplex_transport import (
    DurableBudget, ProtocolError, finish_io, save_json, valid_usage,
)

EXPERIMENT = "continuous-character-center-20261025"
LIMITS = {"listener": 18, "voice": 30, "action": 60, "background": 120}
# Official model limits, checked 2026-10-25; not a timeout-derived token estimate.
QWEN_BOUND = {"input": 245760, "output": 16384,
              "source": "https://help.aliyun.com/zh/model-studio/qwen-audio-3-1-realtime-plus"}


def locked(function):
    @wraps(function)
    def call(self, *args, **kwargs):
        with self._lock:
            return function(self, *args, **kwargs)
    return call


class CenterBudget(DurableBudget):
    experiment_id = EXPERIMENT

    def __init__(self, path, *, max_turns=12, limits=None, pcm_seconds=480, stop_on_unknown=False):
        self._lock = threading.RLock()
        self._async_lock = asyncio.Lock()
        self.path = Path(path)
        selected = dict(LIMITS if limits is None else limits)
        if set(selected) != set(LIMITS) or any(type(v) is not int or not 0 < v <= LIMITS[k] for k, v in selected.items()):
            raise ValueError("invalid_channel_limits")
        if not 1 <= max_turns <= 12 or not 0 < pcm_seconds <= 480:
            raise ValueError("invalid_batch_limits")
        self.data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {
            "version": 3, "experimentId": EXPERIMENT, "turnLimit": max_turns,
            "responseLimit": sum(selected.values()), "channelLimits": selected,
            "turns": [], "responses": [], "blocked": False, "reasons": [],
            "frozenChannels": {}, "pcmBytes": 0, "pcmReservedBytes": 0, "pcmByteLimit": int(pcm_seconds * 16000 * 2),
            "unknownUsagePolicy": "terminal_missing_usage_keeps_full_reservation",
            "officialQwenBound": QWEN_BOUND,
        }
        if self.data.get("experimentId") != EXPERIMENT:
            raise ValueError("different_experiment_ledger")
        self.data["turnLimit"] = min(max_turns, self.data["turnLimit"])
        self.data["channelLimits"] = {k: min(v, self.data["channelLimits"][k]) for k, v in selected.items()}
        self.data["responseLimit"] = sum(self.data["channelLimits"].values())
        self.data["pcmByteLimit"] = min(self.data["pcmByteLimit"], int(pcm_seconds * 32000))
        if stop_on_unknown:
            self.data["stopOnUnknown"] = True
        # A crash cannot refund a partially sent durable one-second PCM credit.
        self.data["pcmBytes"] = max(self.data["pcmBytes"], self.data.get("pcmReservedBytes", 0))
        for row in self.data["responses"]:
            if row["state"] in {"reserved", "active"}:
                row["state"] = "unknown"
                self.data["frozenChannels"][row["channel"]] = "unfinished_reservation_on_restart"
        if self.data.get("stopOnUnknown") and any(row["state"] == "unknown" for row in self.data["responses"]):
            self.data["blocked"] = True
        self.flush()

    @staticmethod
    def channel(role):
        if role == "listener":
            return "listener"
        if role in {"action_planner", "activity_planner", "semantic", "action"}:
            return "action"
        if role == "background":
            return "background"
        if role in {"reply", "direct", "full", "direct_reply", "full_reply", "voice", "proactive"}:
            return "voice"
        raise ProtocolError("unknown_budget_role")

    @locked
    def available(self, role):
        channel = self.channel(role)
        count = sum(r["channel"] == channel and r["state"] != "unused" for r in self.data["responses"])
        return not self.data["blocked"] and channel not in self.data["frozenChannels"] and count < self.data["channelLimits"][channel]

    @locked
    def reserve(self, role, connection_id, owner, token_bound=None):
        channel = self.channel(role)
        if not self.available(role):
            raise ProtocolError("channel_admission_blocked:" + channel)
        bound = dict(QWEN_BOUND) if channel != "background" else {"input": 131072, "output": 4096, "source": "bounded_utf8_payload_and_explicit_max_tokens"}
        if token_bound is not None:
            if (channel != "action" or set(token_bound) != {"input", "output", "source"}
                    or any(type(token_bound[k]) is not int or not 0 < token_bound[k] <= 1048576 for k in ("input", "output"))
                    or not isinstance(token_bound["source"], str) or len(token_bound["source"]) > 240):
                raise ProtocolError("invalid_action_token_bound")
            bound = dict(token_bound)
        row = {"id": uuid4().hex, "role": role, "channel": channel, "connectionId": connection_id,
               "owner": str(owner), "state": "reserved", "responseId": None, "usage": None,
               "reservedAt": time.time(), "maxTokens": bound, "terminalObserved": False}
        self.data["responses"].append(row)
        self.flush()
        return row

    @locked
    def reserve_optional_planner(self, connection_id, owner):
        return self.reserve("action_planner", connection_id, owner) if self.available("action_planner") else None

    @locked
    def settle(self, row, response):
        if row["responseId"] != response.get("id"):
            self.block("terminal_owner_conflict", row)
            raise ProtocolError("terminal_owner_conflict")
        if row["state"] not in {"reserved", "active"}:
            if row.get("status") == response.get("status") and row.get("usage") == response.get("usage"):
                return
            self.block("terminal_changed", row)
            raise ProtocolError("terminal_changed")
        status = response.get("status")
        if status not in {"completed", "cancelled", "failed", "incomplete"}:
            self.block("unconfirmed_terminal", row)
            return
        row.update(status=status, usage=response.get("usage"), terminalObserved=True, settledAt=time.time())
        row["state"] = "reported" if valid_usage(row["usage"]) else "unknown"
        # Unknown reservations are never refunded. Only a verified terminal and
        # the retained maximum allow later calls within the original cap.
        if row["state"] == "unknown":
            row["unknownReason"] = "terminal_usage_missing_or_invalid"
            if self.data.get("stopOnUnknown"):
                self.data["blocked"] = True
                self.data["reasons"].append("terminal_usage_missing_or_invalid")
        self.flush()

    @locked
    def block(self, reason, reservation=None):
        if reservation is None:
            self.data["blocked"] = True
        else:
            reservation["state"] = "unknown"
            reservation["unknownReason"] = reason
            self.data["frozenChannels"][reservation["channel"]] = reason
        if reason not in self.data["reasons"]:
            self.data["reasons"].append(reason)
        if self.data.get("stopOnUnknown"):
            self.data["blocked"] = True
        self.flush()

    @locked
    def account_pcm(self, byte_count):
        if type(byte_count) is not int or byte_count < 0 or byte_count % 2:
            raise ProtocolError("invalid_pcm_count")
        if self.data["pcmBytes"] + byte_count > self.data["pcmByteLimit"]:
            self.data["frozenChannels"]["listener"] = "pcm_limit"
            self.flush()
            raise ProtocolError("pcm_limit")
        self.data["pcmBytes"] += byte_count
        if self.data["pcmBytes"] > self.data.get("pcmReservedBytes", 0):
            self.data["pcmReservedBytes"] = min(self.data["pcmByteLimit"], ((self.data["pcmBytes"] + 31999) // 32000) * 32000)
            self.flush()

    @locked
    def admit_turn(self, turn_id):
        if turn_id in self.data["turns"]:
            raise ProtocolError("duplicate_turn")
        return super().admit_turn(turn_id)

    @locked
    def created(self, row, response_id):
        return super().created(row, response_id)

    @locked
    def assign_owner(self, row, owner):
        return super().assign_owner(row, owner)

    @locked
    def unused(self, row):
        return super().unused(row)

    @locked
    def flush(self):
        save_json(self.path, self.data)

    async def acall(self, method, *args):
        async with self._async_lock:
            try:
                return await finish_io(getattr(self, method), *args)
            except ProtocolError:
                raise
            except BaseException:
                self.data["blocked"] = True
                self.data["reasons"].append("durable_operation_failed")
                await finish_io(self.flush)
                raise

    @locked
    def snapshot(self):
        result = super().snapshot()
        result.update(channels={k: {"used": sum(r["channel"] == k and r["state"] != "unused" for r in self.data["responses"]),
                                    "limit": limit, "frozen": self.data["frozenChannels"].get(k)}
                                for k, limit in self.data["channelLimits"].items()},
                      pcmSeconds=self.data["pcmBytes"] / 32000,
                      pcmLimitSeconds=self.data["pcmByteLimit"] / 32000,
                      unknownReservedTokens=sum(r["maxTokens"]["input"] + r["maxTokens"]["output"]
                                               for r in self.data["responses"] if r["state"] == "unknown"))
        return result
