"""A bounded latest-work queue, independent of audio and browser rendering."""
import asyncio
from dataclasses import dataclass, field
from copy import deepcopy
from uuid import uuid4


@dataclass
class SemanticRequest:
    source_key: str
    source_scope: str
    source_version: str
    source_epoch: int
    semantic_revision: int
    payload: dict
    priority: int
    request_id: str = field(default_factory=lambda: "semantic-" + uuid4().hex)
    cancel_requested: asyncio.Event = field(default_factory=asyncio.Event)
    invalidated: bool = False
    task: object = None


class SemanticQueue:
    """At most two provider tasks: one foreground slot, one cancelling drain.

    Pure append coalesces pending content, without repeatedly cancelling work.
    An urgent replacement invalidates old output immediately. If the drain slot
    is occupied it waits before sending another cancel or opening a third task.
    """
    def __init__(self, execute, *, on_event=None):
        self.execute = execute
        self.on_event = on_event
        self.active = self.draining = self.pending = None
        self.source_epochs = {}
        self.revision = 0
        self.committed = 0
        self.closed = False
        self.failures = []

    def event(self, kind, job=None, **fields):
        if self.on_event:
            self.on_event(kind, {"requestId": job.request_id if job else None, **fields})

    def valid(self, job):
        return (not self.closed and not job.invalidated and not job.cancel_requested.is_set()
                and self.source_epochs.get(job.source_key, 0) == job.source_epoch
                and job.semantic_revision >= self.committed)

    def commit(self, job):
        if not self.valid(job):
            return False
        self.committed = max(self.committed, job.semantic_revision)
        return True

    def submit(self, source_key, source_scope, source_version, payload, *, priority=1, replace=False):
        if self.closed:
            return None
        if replace:
            self.invalidate(source_key, "source_replaced", pump=False)
        self.revision += 1
        job = SemanticRequest(source_key, source_scope, str(source_version),
            self.source_epochs.get(source_key, 0), self.revision, deepcopy(payload), priority)
        if self.pending and self.pending.priority > priority:
            self.event("semantic_coalesced", job, reason="foreground_pending")
            return None
        if self.pending:
            self.pending.invalidated = True
            self.event("semantic_coalesced", self.pending, reason="newer_pending_context")
        self.pending = job
        if self.active and (priority > self.active.priority or replace):
            self.active.invalidated = True
        self._pump()
        return job

    def invalidate(self, source_key=None, reason="source_revoked", *, pump=True):
        if source_key is not None:
            self.source_epochs[source_key] = self.source_epochs.get(source_key, 0) + 1
        for job in (self.active, self.draining, self.pending):
            if job and (source_key is None or job.source_key == source_key):
                job.invalidated = True
                self.event("semantic_invalidated", job, reason=reason)
        if self.pending and self.pending.invalidated:
            self.pending = None
        if pump:
            self._pump()

    def _pump(self):
        if self.active and self.active.invalidated and self.draining is None:
            self.draining, self.active = self.active, None
            self.draining.cancel_requested.set()
            self.event("semantic_cancel_requested", self.draining)
        if self.closed or self.active or not self.pending:
            return
        job, self.pending = self.pending, None
        self.active = job
        job.task = asyncio.create_task(self._run(job))

    async def _run(self, job):
        try:
            await self.execute(job)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.failures.append(type(exc).__name__)
            self.event("semantic_task_failed", job, code=type(exc).__name__)
        finally:
            if self.active is job:
                self.active = None
            if self.draining is job:
                self.draining = None
            self._pump()

    async def close(self, timeout=12):
        self.closed = True
        if self.pending:
            self.pending.invalidated = True
        self.pending = None
        jobs = [job for job in (self.active, self.draining) if job]
        for job in jobs:
            job.invalidated = True
            job.cancel_requested.set()
        tasks = [job.task for job in jobs if job.task]
        if tasks:
            _, unfinished = await asyncio.wait(tasks, timeout=timeout)
            return list(unfinished)
        return []

    def snapshot(self):
        def info(job):
            return None if job is None else {"requestId": job.request_id, "source": job.source_key,
                "scope": job.source_scope, "revision": job.semantic_revision,
                "invalidated": job.invalidated, "cancelRequested": job.cancel_requested.is_set()}
        return {"active": info(self.active), "draining": info(self.draining),
                "pending": info(self.pending), "revision": self.revision, "committed": self.committed}
