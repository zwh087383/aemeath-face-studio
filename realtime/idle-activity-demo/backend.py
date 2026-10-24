"""Isolated demo adapter around the real WAI activity/artefact lifecycle.

The provider below really indexes a bundled local document. It is deliberately
not a model, web search, production memory, or the full WAI life runtime.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sys
import threading
import time
import uuid


class DemoBackend:
    def __init__(self, wai_root, output_root, *, rate=120, pace=.25):
        sys.path.insert(0, str(Path(wai_root).resolve()))
        from wai.proactive.activity_planner import ActivityPlanner
        from wai.proactive.life_threads import LifeThreads
        self.Planner, self.Life = ActivityPlanner, LifeThreads
        self.output_root = Path(output_root).resolve()
        self.rate, self.pace = rate, pace
        self.lock = threading.RLock()
        self.closed = False
        self.generation = 0
        self.revision = 0
        self.session_id = uuid.uuid4().hex
        self.events = []
        self.seen = {}
        self.engaged = False
        self.manual_pause = False
        self.run = None
        self.error = None
        self.completed_sections = []
        self.source = Path(__file__).with_name("material.txt")
        self.source_text = self.source.read_text(encoding="utf-8")
        self.sections = [s.strip() for s in self.source_text.split("\n\n") if s.strip()]
        self.source_hash = hashlib.sha256(self.source_text.encode()).hexdigest()
        self.artifact = None
        self.provider = "idle"
        self.virtual_base = datetime(2026, 10, 24, 8).timestamp()
        self.wall_base = time.monotonic()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def now(self):
        return self.virtual_base + (time.monotonic() - self.wall_base) * self.rate

    def emit(self, event, **values):
        self.revision += 1
        row = dict(event=event, revision=self.revision, generation=self.generation,
                   sessionId=self.session_id, at=time.time(), **values)
        self.events.append(row)
        self.events = self.events[-100:]
        if self.run:
            with (self.run / "events.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    def block(self):
        if not self.run:
            return None
        return next((b for b in self.planner.blocks() if b.block_id == self.block_id), None)

    def _start(self):
        if self.engaged:
            raise ValueError("交谈尚未结束，不能另开闲时活动。")
        block = self.block()
        if block and block.status in {"running", "paused", "planned"}:
            raise ValueError("当前活动尚未结束；请继续、取消或等待完成。")
        self.generation += 1
        self.run = self.output_root / (self.session_id + "-" + str(self.generation))
        self.run.mkdir(parents=True, exist_ok=False)
        self.engaged = self.manual_pause = False
        self.error = None
        self.artifact = None
        self.provider = "waiting"
        self.completed_sections = []
        self.life = self.Life(self.run / "life.json", clock=self.now)
        self.planner = self.Planner(self.run / "plan.json", clock=self.now)
        ref = "demo-document:" + self.source_hash
        self.evidence = [{"type": "document", "ref": ref}]
        thread = self.life.upsert("shared", "整理一份舞台动作说明",
                                 evidence=self.evidence, next_step="提取各段标题和字数",
                                 now=self.now())
        self.thread_id = thread["id"]
        blocks = self.planner.plan_day(
            day="2026-10-24", rhythm={"wake": "07:45", "bed": "23:00"},
            threads=[thread], seed="idle-activity-demo")
        first = min(blocks, key=lambda b: b.planned_start)
        self.block_id = first.block_id
        # Only the isolated planner clock is accelerated; native animation is 1x.
        self.virtual_base = first.planned_start + .01
        self.wall_base = time.monotonic()
        self.planner.due(self.now())
        self.next_section_at = time.monotonic() + self.pace
        self.emit("started", title=first.label, sourceHash=self.source_hash,
                  backend="WAI ActivityPlanner + LifeThreads", rate=self.rate)

    def command(self, request):
        with self.lock:
            action = request.get("action")
            if request.get("sessionId") != self.session_id:
                raise ValueError("旧页面会话，刷新状态后再操作。")
            if request.get("generation") != self.generation:
                raise ValueError("旧活动指令已过期。")
            key = request.get("commandId")
            if not isinstance(key, str) or not 1 <= len(key) <= 100:
                raise ValueError("缺少有效指令编号。")
            if key in self.seen:
                return self.snapshot()
            if action == "start":
                self._start()
            elif action in {"pause", "speech-start"}:
                if action == "speech-start":
                    self.engaged = True
                else:
                    self.manual_pause = True
                block = self.block()
                if block and block.status in {"running", "paused"}:
                    self.planner.on_user_present(self.now())
                self.emit(action, source=request.get("source", "button"))
            elif action == "speech-end":
                self.emit("speech-end")
                # Silence alone does not close a conversation.
            elif action in {"resume", "conversation-end"}:
                if action == "conversation-end":
                    self.engaged = False
                else:
                    self.manual_pause = False
                self.emit(action)
            elif action == "cancel":
                if self.run:
                    self.life.veto(self.thread_id, now=self.now())
                    self.planner.fail(self.block_id, "demo_cancelled", now=self.now())
                    self.provider = "cancelled"
                self.emit("cancelled")
            else:
                raise ValueError("未知操作。")
            self.seen[key] = True
            if len(self.seen) > 300:
                del self.seen[next(iter(self.seen))]
            return self.snapshot()

    def _tick(self):
        block = self.block()
        if not block or block.status in {"done", "failed", "dropped"}:
            return
        allowed = not self.engaged and not self.manual_pause
        before = block.status
        self.planner.due(self.now(), allow_start=allowed)
        block = self.block()
        if block.status != before:
            self.emit({"running": "resumed", "done": "completed",
                       "failed": "failed"}.get(block.status, block.status))
        if block.status == "done":
            self.life.close(self.thread_id, now=self.now())
            self.provider = "finished"
            return
        if block.status != "running" or not allowed:
            return
        if self.artifact:
            return
        if time.monotonic() < self.next_section_at:
            return
        self.provider = "processing"
        i = len(self.completed_sections)
        if i < len(self.sections):
            # Genuine local work, paced for observation, not measured AI latency.
            section = self.sections[i]
            self.completed_sections.append(dict(
                index=i + 1, title=section.splitlines()[0],
                characters=len(section), sha256=hashlib.sha256(section.encode()).hexdigest()))
            self.next_section_at = time.monotonic() + self.pace
            self.emit("section-processed", section=i + 1)
        if len(self.completed_sections) == len(self.sections):
            content = "\n".join(
                f"{x['index']}. {x['title']}（{x['characters']} 字符）"
                for x in self.completed_sections)
            self.artifact = self.life.advance(
                self.thread_id, operation_id=self.block_id, now=self.now(),
                context={"trusted_activity_type": "tidy", "evidence": self.evidence},
                model_call=lambda _prompt: {
                    "title": "舞台说明段落索引", "content": content,
                    "evidence_refs": [self.evidence[0]["ref"]],
                    "worth_sharing": False, "next_step": "", "activity_type": "tidy"})
            if not self.artifact:
                self.planner.fail(self.block_id, "artifact_not_accepted", now=self.now())
                self.provider = "failed"
                self.emit("failed", reason="WAI未接纳本地产物")
                return
            self.planner.set_artifact(self.block_id, self.artifact["id"], now=self.now())
            self.provider = "artifact-ready"
            self.emit("artifact-ready", artifactId=self.artifact["id"])
            (self.run / "local-work.json").write_text(
                json.dumps({"sourceHash": self.source_hash,
                            "sections": self.completed_sections,
                            "artifactId": self.artifact["id"]}, ensure_ascii=False, indent=2),
                encoding="utf-8")

    def _loop(self):
        while not self.closed:
            try:
                with self.lock:
                    self._tick()
            except Exception as error:
                with self.lock:
                    self.error = str(error)
                    if self.run:
                        self.planner.fail(self.block_id, "adapter_error", now=self.now())
                    self.emit("failed", reason=self.error)
            time.sleep(.1)

    def snapshot(self):
        with self.lock:
            block = self.block()
            now = self.now()
            remaining = max(0, (block.ends_at - now) / self.rate) if block and block.status == "running" else (
                block.remaining_seconds / self.rate if block else 0)
            last = None
            if self.run:
                from wai.proactive.intent_store import read_json_state
                last = read_json_state(self.planner.path, lambda: {}) .get("last_user_present")
            quiet_wait = max(0, (600 - (now - last)) / self.rate) if last is not None else 0
            return dict(
                sessionId=self.session_id, generation=self.generation, revision=self.revision,
                task=asdict(block) if block else None, activityType="tidy",
                engaged=self.engaged, manualPause=self.manual_pause,
                provider=self.provider, progress=len(self.completed_sections),
                total=len(self.sections), remainingSeconds=remaining,
                resumeWaitSeconds=quiet_wait, artifact=self.artifact, error=self.error,
                events=self.events[-35:], clockRate=self.rate,
                integration={"planner": "wai.proactive.activity_planner.ActivityPlanner",
                             "artifacts": "wai.proactive.life_threads.LifeThreads",
                             "provider": "local-document-indexer", "cloudCalls": 0,
                             "productionData": False},
                sourceHash=self.source_hash)

    def close(self):
        self.closed = True
        self.thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wai-root", required=True)
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args()
    backend = DemoBackend(args.wai_root, args.output_root)
    try:
        for line in sys.stdin:
            identity = None
            try:
                request = json.loads(line)
                identity = request["id"]
                result = backend.snapshot() if request.get("action") == "snapshot" else backend.command(request)
                response = {"id": identity, "ok": True, "result": result}
            except Exception as error:
                response = {"id": identity, "ok": False, "error": str(error)}
            print(json.dumps(response, ensure_ascii=False), flush=True)
    finally:
        backend.close()


if __name__ == "__main__":
    main()
