"""Account actual WAI SDK calls inside the isolated process only."""
from __future__ import annotations

from functools import wraps
from contextlib import contextmanager
from contextvars import ContextVar
import json
from uuid import uuid4

from tools.voice_avatar.duplex_transport import ProtocolError

_scope = ContextVar("character_center_accounting_scope", default=None)

@contextmanager
def accounting_scope(identity):
    token = _scope.set(identity)
    try:
        yield
    finally:
        _scope.reset(token)


def normalized_usage(value):
    if hasattr(value, "model_dump"):
        value = value.model_dump()
    if not isinstance(value, dict):
        return None
    return {"input_tokens": value.get("prompt_tokens"), "output_tokens": value.get("completion_tokens"),
            "total_tokens": value.get("total_tokens")}


def install_accounting(budget):
    """Must run after isolated configure and before bootstrap_runtime.

    This observes real SDK results, never supplies a fake model answer. The only
    request changes are explicit output/input caps and streaming usage reporting.
    """
    from wai.models import llm_client
    target = llm_client._PromptLoggingCompletions
    original = target.create
    if getattr(original, "_character_accounted", False):
        raise RuntimeError("accounting_already_installed")

    class CountedStream:
        def __init__(self, stream, row):
            self.stream, self.row, self.usage, self.terminal = stream, row, None, False
        def __getattr__(self, key):
            return getattr(self.stream, key)
        def __iter__(self):
            try:
                for chunk in self.stream:
                    value = getattr(chunk, "usage", None)
                    if value is not None:
                        self.usage = normalized_usage(value)
                    choices = getattr(chunk, "choices", []) or []
                    if any(getattr(c, "finish_reason", None) is not None for c in choices):
                        self.terminal = True
                    yield chunk
                if self.terminal:
                    budget.settle(self.row, {"id": self.row["responseId"], "status": "completed", "usage": self.usage})
                else:
                    budget.block("background_stream_without_terminal", self.row)
            except BaseException:
                if self.row["state"] in {"reserved", "active"}:
                    budget.block("background_stream_failed", self.row)
                raise
        def close(self):
            try:
                self.stream.close()
            finally:
                if self.row["state"] in {"reserved", "active"}:
                    budget.block("background_stream_closed_before_terminal", self.row)
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.close()

    @wraps(original)
    def counted(self, *args, **kwargs):
        # Character count is not treated as tokens. A UTF-8 request byte ceiling
        # is retained as a conservative input bound including wrapper overhead.
        if len(json.dumps({"args": args, "kwargs": kwargs}, ensure_ascii=False, default=str).encode("utf-8")) > 120000:
            raise ProtocolError("background_input_limit")
        kwargs["max_tokens"] = min(4096, int(kwargs.get("max_tokens") or 4096))
        if kwargs["max_tokens"] <= 0:
            raise ProtocolError("background_output_limit")
        if kwargs.get("stream"):
            kwargs["stream_options"] = {**kwargs.get("stream_options", {}), "include_usage": True}
        row = budget.reserve("background", "wai-sdk-" + uuid4().hex, _scope.get() or kwargs.get("_prompt_task", "background"))
        identity = "sdk-" + uuid4().hex
        budget.created(row, identity)
        try:
            result = original(self, *args, **kwargs)
        except BaseException:
            budget.block("background_request_terminal_unknown", row)
            raise
        if kwargs.get("stream"):
            return CountedStream(result, row)
        budget.settle(row, {"id": identity, "status": "completed", "usage": normalized_usage(getattr(result, "usage", None))})
        return result
    counted._character_accounted = True
    target.create = counted
    return lambda: setattr(target, "create", original)
