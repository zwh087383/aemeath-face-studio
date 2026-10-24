"""Real WAI stores in temporary directories. No cloud provider or production data."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("idle_demo_backend", ROOT / "realtime/idle-activity-demo/backend.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.demo = module.DemoBackend(ROOT.parents[1] / "WAI", self.temp.name, pace=0)
        self.demo.close()
        self.serial = 0

    def tearDown(self):
        self.demo.close()
        self.temp.cleanup()

    def command(self, action, **extra):
        self.serial += 1
        return self.demo.command(dict(sessionId=self.demo.session_id, generation=self.demo.generation,
                                      commandId=str(self.serial), action=action, **extra))

    def start_clock(self):
        self.command("start")
        self.at = self.demo.now()
        self.demo.now = lambda: self.at

    def test_pause_preserves_real_progress_resume_obeys_existing_600_seconds(self):
        self.start_clock()
        for _ in range(3):
            self.demo._tick()
        self.assertEqual(3, self.demo.snapshot()["progress"])
        self.command("pause")
        for _ in range(6):
            self.demo._tick()
        self.assertEqual(3, self.demo.snapshot()["progress"])
        self.command("resume")
        self.at += 599
        self.demo._tick()
        self.assertEqual("paused", self.demo.block().status)
        self.at += 2
        self.demo._tick()
        self.assertEqual("running", self.demo.block().status)
        self.assertEqual(4, self.demo.snapshot()["progress"])

    def test_speech_silence_does_not_resume_before_explicit_conversation_end(self):
        self.start_clock()
        self.command("speech-start")
        self.command("speech-end")
        self.at += 610
        self.demo._tick()
        self.assertEqual("paused", self.demo.block().status)
        self.assertEqual(0, self.demo.snapshot()["progress"])
        self.command("conversation-end")
        self.demo._tick()
        self.assertEqual("running", self.demo.block().status)

    def test_real_artifact_is_saved_once_before_plan_completes(self):
        self.start_clock()
        for _ in range(len(self.demo.sections) + 5):
            self.demo._tick()
        state = self.demo.snapshot()
        self.assertEqual("running", state["task"]["status"])
        self.assertEqual("artifact-ready", state["provider"])
        self.assertEqual(1, len(self.demo.life.artifacts()))
        self.assertIn(self.demo.sections[0].splitlines()[0], state["artifact"]["content"])
        self.assertTrue((self.demo.run / "local-work.json").is_file())
        self.at = self.demo.block().ends_at + 1
        self.demo._tick()
        self.assertEqual("done", self.demo.block().status)
        self.assertEqual(1, len(self.demo.life.artifacts()))

    def test_cancel_rejects_late_generation_and_never_publishes_old_work(self):
        self.start_clock()
        self.demo._tick()
        old = self.demo.generation
        self.command("cancel")
        for _ in range(30):
            self.demo._tick()
        self.assertEqual(0, len(self.demo.life.artifacts()))
        self.command("start")
        with self.assertRaisesRegex(ValueError, "过期"):
            self.demo.command(dict(action="cancel", sessionId=self.demo.session_id,
                                   generation=old, commandId="late"))
        self.assertEqual("running", self.demo.block().status)

    def test_duplicate_input_keeps_one_event_and_manual_pause_survives_conversation(self):
        self.start_clock()
        self.command("pause")
        request = dict(action="speech-start", sessionId=self.demo.session_id,
                       generation=self.demo.generation, commandId="same")
        self.demo.command(request)
        revision = self.demo.revision
        self.demo.command(request)
        self.assertEqual(revision, self.demo.revision)
        self.command("conversation-end")
        self.at += 620
        self.demo._tick()
        self.assertEqual("paused", self.demo.block().status)
        self.assertTrue(self.demo.manual_pause)

    def test_foreign_session_is_rejected_without_mutation(self):
        revision = self.demo.revision
        with self.assertRaisesRegex(ValueError, "旧页面"):
            self.demo.command(dict(action="start",sessionId="other",generation=0,commandId="x"))
        self.assertEqual(revision, self.demo.revision)

    def test_new_idle_activity_cannot_clear_an_open_conversation(self):
        self.command("speech-start")
        with self.assertRaisesRegex(ValueError, "交谈尚未结束"):
            self.command("start")
        self.assertTrue(self.demo.engaged)
        self.assertIsNone(self.demo.block())


if __name__ == "__main__":
    unittest.main(verbosity=2)
