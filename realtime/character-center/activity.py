"""Real WAI reading work with an explicitly scaled, isolated activity clock policy.

The wall clock, model calls, animation and memory dates are never fast-forwarded.
This module schedules business fixtures, not character motions.
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import time

from wai.proactive.activity_planner import ActivityPlanner, ActivityBlock, _empty
from wai.proactive.activity_sources import material_anchor
from wai.proactive.intent_store import atomic_json_update, read_json_state
from tools.voice_avatar.duplex_transport import save_json

CASES = {
    "reading-complete": "正常完成",
    "reading-inflight": "请求中被叫住",
    "reading-artifact": "成果生成后被叫住",
    "reading-revoke": "来源撤回",
    "reading-failure": "抓取故障后如实终止",
}
SOURCE_URL = "https://science.nasa.gov/moon/facts/"


class ExperimentalPlanner(ActivityPlanner):
    """Same durable states and artifact gate; only waiting intervals are scaled."""
    scale = 30
    minimum_seconds = 120

    def seed(self, case_id, thread_id, now):
        block = ActivityBlock("center:" + case_id, "reading", thread_id, now, 30,
                              label="阅读月球公开资料：" + CASES[case_id])
        def update(state):
            day = state["days"].setdefault("character-center", {
                "blocks": [], "wake_at": now, "sleep_at": now + 86400,
                "rituals": [], "hourly": [0] * 24, "cap": 5, "target": 0,
            })
            if any(b["block_id"] == block.block_id for b in day["blocks"]):
                raise ValueError("case_already_attempted")
            if any(b["status"] in {"running", "paused"} for b in day["blocks"]):
                raise ValueError("activity_still_active")
            day["blocks"].append(asdict(block))
            return block
        return atomic_json_update(self.path, _empty, update)

    def due(self, now=None, *, allow_start=True):
        now = self.clock() if now is None else now
        def update(state):
            events = []
            last_user = state.get("last_user_present")
            quiet = last_user is None or now - last_user >= 600 / self.scale
            for day in state["days"].values():
                for item in day["blocks"]:
                    if item["status"] == "planned" and now >= day["sleep_at"]:
                        item.update(status="dropped", reason="sleep_window_passed")
                    elif item["status"] == "planned" and allow_start and quiet and item["planned_start"] <= now:
                        duration = max(self.minimum_seconds, item["planned_minutes"] * 60 / self.scale)
                        if now + duration > day["sleep_at"]:
                            item.update(status="dropped", reason="insufficient_awake_time")
                            continue
                        if any(b["status"] in {"running", "paused"} for b in day["blocks"]):
                            continue
                        if any(b["started_at"] and now - b["started_at"] < 5400 / self.scale for b in day["blocks"]):
                            continue
                        item.update(status="running", started_at=now, ends_at=now + duration)
                        events.append(ActivityBlock(**{**item, "action": "start"}))
                    elif item["status"] == "paused" and allow_start and quiet and now < day["sleep_at"]:
                        item.update(status="running", ends_at=min(day["sleep_at"], now + item["remaining_seconds"]))
                        events.append(ActivityBlock(**{**item, "action": "resume"}))
                    elif item["status"] in {"running", "paused"} and (
                        now >= day["sleep_at"] or item["status"] == "running" and now >= item["ends_at"]
                    ):
                        if item["artifact_id"]:
                            item.update(status="done")
                            events.append(ActivityBlock(**{**item, "action": "finish"}))
                        else:
                            item.update(status="failed", reason="no_persisted_artifact")
                            events.append(ActivityBlock(**{**item, "action": "failed"}))
            return events
        return atomic_json_update(self.path, _empty, update)


class ReadingActivities:
    def __init__(self, main, output, publish, *, allow_existing_proxy=False, budget=None):
        self.main, self.output, self.publish = main, Path(output), publish
        self.kernel = main.heartbeat_engine.v2
        self.life = self.kernel.life
        if self.life is None:
            raise RuntimeError("real_WAI_life_threads_disabled")
        self.original_planner = self.life.planner
        self.life.planner = ExperimentalPlanner(self.original_planner.path, clock=self.life.clock,
                                               timezone_name=str(self.life.zone))
        self.planner = self.life.planner
        self.original_search = self.kernel.owner.v2_public_search
        self.kernel.owner.v2_public_search = self._read_selected_public_source
        self.path = self.output / "reading-cases.json"
        self.records = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
        self.session = None
        self.current_id = None
        self.task = self.work = None
        self.work_inflight = False
        self.closed = False
        self.revision = 0
        self.last_fingerprint = None
        self.foreground = False
        self.lock = asyncio.Lock()
        self.event_lock = asyncio.Lock()
        self.notify_lock = asyncio.Lock()
        self.user_speaking = False
        self.waiting_turn = False
        self.active_turn = None
        self.allow_existing_proxy = allow_existing_proxy
        self.budget = budget

    def _fixed_public_page(self):
        try:
            return self.kernel.read_shared_link(SOURCE_URL)
        except ValueError as exc:
            if str(exc) != "non-public destination" or not self.allow_existing_proxy:
                raise
        # This host's DNS can expose the local proxy's fake-IP range. The formal
        # WAI URL guard is left intact. This experiment may fetch ONLY this fixed
        # public HTTPS URL through the already-running proxy, with verified TLS,
        # no redirects, and a byte ceiling. It accepts no model/user target URL.
        import requests
        from wai.web.activity_web import WebActivityProvider
        deadline = time.monotonic() + 20
        with requests.Session() as transport:
            transport.trust_env = False
            with transport.get(SOURCE_URL, proxies={"https": "http://127.0.0.1:7890"},
                               timeout=8, allow_redirects=False, stream=True) as response:
                if response.status_code != 200 or "text/html" not in response.headers.get("Content-Type", ""):
                    raise ValueError("fixed_public_page_failed")
                chunks, size = [], 0
                for chunk in response.iter_content(32768):
                    if time.monotonic() >= deadline:
                        raise TimeoutError("fixed_public_page_total_deadline")
                    size += len(chunk)
                    if size > 600000:
                        raise ValueError("fixed_public_page_too_large")
                    chunks.append(chunk)
                html = b"".join(chunks).decode(response.encoding or "utf-8", errors="replace")
        title, text = WebActivityProvider()._extract_readable_text(html)
        return {"url": SOURCE_URL, "title": title, "text": text, "extraction_status": "ok",
                "fetched_at": time.time(), "transport": "fixed_public_https_via_existing_local_proxy"}

    def _read_selected_public_source(self, query, *, read_pages=False):
        if not self.current_id or "月球" not in query:
            return self.original_search(query, read_pages=read_pages)
        row = self.records[self.current_id]
        if self.current_id == "reading-failure":
            raise RuntimeError("explicit_test_fetch_failure_before_network")
        page = self._fixed_public_page()
        text = str(page.get("text") or "")
        if not text or page.get("extraction_status") != "ok":
            raise RuntimeError("source_body_not_available")
        row["source"] = {"url": page["url"], "fetchedAt": page["fetched_at"],
                         "sha256": hashlib.sha256(text.encode()).hexdigest(), "characters": len(text),
                         "transport": page.get("transport", "WAI_public_page_reader")}
        # Match V2Tools.search_public(read_pages=True): _readable_sources first
        # requires a non-empty source body, then verifies its matching extract.
        # Both fields contain the actual selected-page body, not invented search.
        return {"status": "success", "source": "explicit_public_reading_fixture",
                "sources": [{"url": page["url"], "title": page.get("title", ""),
                             "content": text, "content_origin": "public_page", "fetched_at": page["fetched_at"]}],
                "page_extracts": [{"url": page["url"], "extraction_status": "ok",
                                   "title": page.get("title", ""),
                                   "fetched_at": page["fetched_at"], "content_blocks": [{"text": text}]}]}

    async def attach(self, session):
        self.session = session
        if self.task is None:
            self.task = asyncio.create_task(self._loop())
        await self._notify(force=True)

    async def start(self, case_id):
        if case_id not in CASES:
            raise ValueError("unknown_reading_case")
        async with self.lock:
            if case_id in self.records:
                raise ValueError("case_already_attempted")
            if self.current_id and self.snapshot().get("status") in {"planned", "running", "paused"}:
                raise ValueError("activity_still_active")
            if self.work and not self.work.done():
                raise ValueError("previous_actual_work_still_running")
            if self.life.sleep_state()["is_sleeping"]:
                raise ValueError("WAI_is_sleeping_no_clock_override")
            if self.current_id:
                # A caller may observe planner.done and start the next case
                # before the .5-second display loop saves that terminal event.
                # Preserve the actual previous terminal before switching IDs.
                previous = await asyncio.to_thread(self.snapshot)
                record = self.records[self.current_id]
                if previous.get("status") in {"done", "failed", "dropped"} and (
                        not record["events"] or record["events"][-1].get("status") != previous["status"]):
                    record["events"].append({"at": time.time(), **previous, "transitionReceipt": True})
                    await self._save()
            now = time.time()
            def seed():
                existing = [t for t in self.life.life.list_threads() if t.get("kind") == "because_of_you"]
                if any(not t["id"].startswith("center-thread:") for t in existing):
                    raise ValueError("unrelated_real_life_thread_active")
                source_id = "center-source:" + case_id
                self.kernel.world.apply_ops([{"op": "upsert", "item": {
                    "id": source_id, "kind": "event", "title": "实验公开阅读材料：月球事实",
                    # Each authorized experimental case has its own source
                    # lifetime. UserWorld otherwise merges equal title topics
                    # under the first ID, including its later revocation state.
                    "topic_key": "character-center-reading:" + case_id,
                    "public_topic": "月球事实", "privacy": "public", "allow_external": True,
                    "explicit": True, "source_turn_id": source_id, "evidence": SOURCE_URL,
                }}], now=now)
                source = self.kernel.world.get(source_id)
                if not source or source.get("status") != "open":
                    raise RuntimeError("public_source_not_persisted")
                for old in existing:
                    prior_blocks = [b for b in self.planner.blocks() if b.thread_id == old["id"]]
                    completed = any(b.status == "done" and b.artifact_id
                                    and self.life.life.artifact(b.artifact_id) for b in prior_blocks)
                    # End only this experiment's previous case. A failed or
                    # withdrawn case is vetoed, never laundered into completion.
                    self.life.life.close(old["id"], status="completed" if completed else "vetoed", now=now)
                thread = self.life.life.upsert("because_of_you", "阅读月球事实，记下一个有趣发现",
                    thread_id="center-thread:" + case_id, evidence=[material_anchor(source, external=True)],
                    next_step="读取指定公开正文，留下有来源的简短阅读笔记", now=now, source_provenance_version=1)
                thread_id = thread["id"] if isinstance(thread, dict) else "center-thread:" + case_id
                return source_id, self.planner.seed(case_id, thread_id, now)
            source_id, block = await asyncio.to_thread(seed)
            self.current_id = case_id
            self.records[case_id] = {"id": case_id, "label": CASES[case_id], "sourceId": source_id,
                "blockId": block.block_id, "startedAt": now, "events": [], "version": 1,
                "speciality": "real_WAI_reading; explicitly selected public URL; waits scaled 30x with 120s minimum; no action script"}
            await self._save()
        await self._notify(force=True)
        return self.snapshot()

    def snapshot(self):
        if not self.current_id:
            return {"activityId": None, "status": "none", "source": "real_WAI", "version": self.revision}
        record = self.records[self.current_id]
        block = next((b for b in self.planner.blocks() if b.block_id == record["blockId"]), None)
        artifact = self.life.life.artifact(block.artifact_id) if block and block.artifact_id else None
        model_running = bool(self.budget and any(r.get("channel") == "background" and r.get("state") == "active"
            and r.get("reservedAt", 0) >= record["startedAt"] and "life_step" in str(r.get("owner", ""))
            for r in self.budget.data["responses"]))
        return {"id": record["id"], "activityId": record["id"], "version": record["version"], "kind": "reading", "label": record["label"],
                "status": block.status if block else "missing", "block": asdict(block) if block else None,
                "actualWorkRunning": self.work_inflight, "foreground": self.foreground,
                "actualModelRequestRunning": model_running,
                "artifactId": artifact.get("id") if artifact else None, "artifactSummary": artifact.get("summary", "") if artifact else "",
                "source": "real_WAI", "durationPolicy": {"scale": 30, "minimumSeconds": 120},
                "sourceReceipt": record.get("source"), "sourceVersion": record["version"]}

    async def on_event(self, event):
        async with self.event_lock:
            kind, identity = event.get("type"), event.get("turnId")
            if kind == "speech_started":
                self.user_speaking = self.waiting_turn = True
            elif kind == "speech_stopped":
                self.user_speaking = False
                if not event.get("valid"):
                    self.waiting_turn = False
            elif kind == "turn_started":
                self.active_turn = identity
                self.waiting_turn = False
            elif kind in {"settled", "revoked", "turn_error"}:
                if identity == self.active_turn:
                    self.active_turn = None
            elif kind == "closed":
                self.active_turn = None
                self.user_speaking = self.waiting_turn = False
            self.foreground = self.user_speaking or self.waiting_turn or self.active_turn is not None
            # An old reply's revocation never clears the newer user's input.
            await asyncio.to_thread(self.planner.on_user_present)
            await self._notify()

    async def revoke(self):
        async with self.lock:
            if not self.current_id:
                raise ValueError("no_activity")
            row = self.records[self.current_id]
            row["version"] += 1
            def change():
                self.kernel.world.apply_ops([{"op": "cancel", "id": row["sourceId"]}])
                self.life._retire_invalid_threads(time.time())
                self.planner.fail(row["blockId"], "source_revoked")
            await asyncio.to_thread(change)
            await self._save()
        await self._notify(force=True)
        return self.snapshot()

    async def valid(self, identity, version):
        def inspect():
            current = self.snapshot()
            if (identity != self.current_id or str(version) != str(current.get("version"))
                    or current.get("status") not in {"running", "done"} or self.foreground):
                return False
            from wai.proactive.activity_sources import ActivitySources
            thread = next((t for t in self.life.life.list_threads(active_only=False)
                           if t["id"] == current["block"]["thread_id"]), None)
            return bool(thread and ActivitySources(self.kernel.world).evidence_current(thread.get("evidence", [])))
        return await asyncio.to_thread(inspect)

    async def voice_context(self):
        from activity_context import capture
        return await asyncio.to_thread(capture, self)

    async def voice_context_valid(self, token):
        from activity_context import current
        return await asyncio.to_thread(current, self, token)

    async def _save(self):
        await asyncio.to_thread(save_json, self.path, self.records)

    async def _notify(self, force=False):
        async with self.notify_lock:
            return await self._notify_locked(force)

    async def _notify_locked(self, force=False):
        snapshot = await asyncio.to_thread(self.snapshot)
        fingerprint = json.dumps({k: snapshot.get(k) for k in (
            "activityId", "status", "actualWorkRunning", "artifactId", "foreground")}, sort_keys=True)
        if not force and fingerprint == self.last_fingerprint:
            return
        self.last_fingerprint = fingerprint
        self.revision += 1
        snapshot["revision"] = self.revision
        if self.current_id:
            self.records[self.current_id]["version"] += 1
            snapshot["version"] = self.records[self.current_id]["version"]
            snapshot["sourceVersion"] = snapshot["version"]
            self.records[self.current_id]["events"].append({"at": time.time(), **snapshot})
            await self._save()
        await self.publish({"type": "activity_state", **snapshot})
        if self.session and not self.session.closed and snapshot.get("activityId") and snapshot.get("status") != "planned":
            await self.session.plan_activity(snapshot)

    async def _execute(self, block):
        self.work_inflight = True
        try:
            def run():
                now = time.time()
                from provider_accounting import accounting_scope
                with accounting_scope("life_step:" + block.block_id):
                    self.life._run_block(block, self.life._public_items(now), now)
            await asyncio.to_thread(run)
        except Exception as exc:
            await asyncio.to_thread(self.planner.fail, block.block_id, "work_failed:" + type(exc).__name__)
        finally:
            self.work_inflight = False
            # Completion is based on real durable artifact, not the task's Python return.
            await self._notify(force=True)

    async def _loop(self):
        while not self.closed:
            try:
                await asyncio.to_thread(self.life._retire_invalid_threads, time.time())
                events = await asyncio.to_thread(self.planner.due, allow_start=not self.foreground)
                for block in events:
                    if block.action == "start" and (self.work is None or self.work.done()):
                        self.work = asyncio.create_task(self._execute(block))
                    if block.action == "finish":
                        def finish():
                            now = time.time()
                            self.life._queue_completed(now)
                            self.life._drain_artifacts(self.life._public_items(now), 0, now)
                        await asyncio.to_thread(finish)
                await self._notify()
            except Exception as exc:
                await self.publish({"type": "activity_error", "code": type(exc).__name__})
            await asyncio.sleep(.5)

    async def close(self):
        self.closed = True
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        if self.work:
            await asyncio.gather(self.work, return_exceptions=True)
        self.life.planner = self.original_planner
        self.kernel.owner.v2_public_search = self.original_search
