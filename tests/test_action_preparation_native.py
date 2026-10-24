import copy
import importlib.util
import json
import math
from pathlib import Path
import tempfile
import unittest

import numpy as np

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/action-preparation/prepare_native.py"
SPEC = importlib.util.spec_from_file_location("prepare_native", MODULE_PATH)
native = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(native)


def clip(root_end=None, root_q=None):
    root = {"p": [0, 0, 0], "q": [0, 0, 0, 1], "s": [1, 1, 1]}
    foot = {"p": [1, 0, 0], "q": [0, 0, 0, 1], "s": [1, 1, 1]}
    frames = [[copy.deepcopy(root), copy.deepcopy(foot)] for _ in range(3)]
    for i in range(3):
        if root_end:
            frames[i][0]["p"] = [n * i / 2 for n in root_end]
        if root_q:
            frames[i][0]["q"] = root_q[i]
    return {"bones": [{"name": "Root", "parent": -1}, {"name": "Bip001LFoot", "parent": 0}],
            "frames": frames, "frameCount": 3, "duration": 1, "units": "Unreal centimeters"}


class NativePreparationTests(unittest.TestCase):
    def test_quaternion_sign_changes_do_not_create_motion(self):
        data = clip(root_q=[[0, 0, 0, 1], [0, 0, 0, -1], [0, 0, 0, 1]])
        measured, _ = native.measure_clip(data)
        self.assertEqual(measured["parts"]["root"]["maxLocalAngularSpeedDegPerSec"], 0)
        self.assertEqual(measured["movingBonesAboveHalfDegree"], 0)

    def test_root_motion_counts_in_world_foot_speed(self):
        measured, _ = native.measure_clip(clip(root_end=[10, 0, 0]))
        self.assertEqual(measured["rootTravelCm"], 10)
        self.assertEqual(measured["feet"]["L"]["maxSpeedCmPerSec"], 10)
        self.assertEqual(measured["feet"]["L"]["lowMotionNearClipMinimumCandidates"], [])
        self.assertFalse(measured["feet"]["L"]["contactConfirmed"])

    def test_parent_rotation_moves_child_world_position(self):
        quaternions = [[0, 0, math.sin(a / 2), math.cos(a / 2)] for a in [0, math.pi / 4, math.pi / 2]]
        measured, end = native.measure_clip(clip(root_q=quaternions))
        self.assertAlmostEqual(measured["parts"]["leftLeg"]["maxWorldDisplacementFromStartCm"], math.sqrt(2), places=5)
        np.testing.assert_allclose(end["Bip001LFoot"]["lastP"], [0, 1, 0], atol=1e-12)

    def test_invalid_quaternion_and_hierarchy_are_rejected(self):
        zero = clip()
        zero["frames"][1][1]["q"] = [0, 0, 0, 0]
        with self.assertRaisesRegex(ValueError, "Zero quaternion"):
            native.measure_clip(zero)
        cyclic = clip()
        cyclic["bones"][0]["parent"] = 1
        with self.assertRaisesRegex(ValueError, "Parents"):
            native.measure_clip(cyclic)

    def test_parent_scale_and_root_units_are_not_ignored(self):
        data = clip(root_end=[2, 0, 0])
        for frame in data["frames"]:
            frame[0]["s"] = [2, 2, 2]
        measured, end = native.measure_clip(data)
        self.assertEqual(measured["rootEndDisplacementCm"], 2)
        np.testing.assert_allclose(end["Bip001LFoot"]["firstP"], [2, 0, 0])
        np.testing.assert_allclose(end["Bip001LFoot"]["lastP"], [4, 0, 0])

    def test_phase_groups_keep_source_directory_identity(self):
        left = {"id": "a", "sourceAsset": "NPC/Aimisi/Sit_Loop2.uasset"}
        right = {"id": "b", "sourceAsset": "Dialog/Aimisi/Sit_Loop2.uasset"}
        self.assertEqual(native.phase_identity(left)[1], "loop2")
        self.assertNotEqual(native.phase_identity(left)[0], native.phase_identity(right)[0])

    def test_source_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "leaves"):
                native.safe_relative(Path(temporary), "../outside.json")

    def test_measurement_failure_does_not_admit_or_hide_other_clips(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            valid = clip()
            invalid = clip()
            invalid["frames"][0][0]["p"] = [float("nan"), 0, 0]
            (root / "valid.json").write_text(json.dumps(valid), encoding="utf8")
            (root / "invalid.json").write_text(json.dumps(invalid), encoding="utf8")
            rows = [dict(id=id_, resourceKind="body", status="ready", sourceAsset=f"Dialog/{id_}.uasset", name=id_, file=file)
                    for id_, file in [("Good_Start", "valid.json"), ("Good_End", "valid.json"), ("Bad", "invalid.json")]]
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"clips": rows}), encoding="utf8")
            prepared = native.build_catalog(manifest)
            self.assertEqual(prepared["summary"]["byStatus"], {"measured_review_pending": 2, "blocked": 1})
            self.assertEqual(prepared["summary"]["phaseSeamsMeasured"], 1)
            self.assertFalse(any(x["automaticEligible"] for x in prepared["items"]))
            self.assertFalse(prepared["seams"][0]["automaticTransitionApproved"])
            self.assertTrue(prepared["items"][0]["sourceSha256"])

    def test_velocity_gap_distinguishes_identical_boundary_poses(self):
        _, end = native.measure_clip(clip(root_end=[1, 0, 0]))
        stopped = copy.deepcopy(end)
        for state in stopped.values():
            state["firstP"] = state["lastP"]
            state["firstV"] = [0, 0, 0]
        result = native.seam_cost(end, stopped)
        self.assertEqual(result["positionGapCm"], 0)
        self.assertEqual(result["linearVelocityGapCmPerSec"], 1)

    def test_start_only_family_does_not_invent_an_end(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "start.json").write_text(json.dumps(clip()), encoding="utf8")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"clips": [dict(id="start", name="Take_Start", resourceKind="body", status="ready", file="start.json", sourceAsset="Dialog/Take_Start.uasset")]}), encoding="utf8")
            result = native.build_catalog(manifest)
            self.assertEqual(result["families"][0]["phases"], ["start"])
            self.assertTrue(result["families"][0]["missingNamedEnd"])
            self.assertEqual(result["seams"], [])

    def test_corrupt_deflate_remains_a_failure_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "bad.json.gz").write_bytes(b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff\x06")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"clips": [dict(id="bad", name="bad", resourceKind="body", status="ready", file="bad.json.gz", sourceAsset="Dialog/Bad.uasset")]}), encoding="utf8")
            result = native.build_catalog(manifest)
            self.assertEqual(result["items"][0]["preparationStatus"], "blocked")
            self.assertIn("测量失败", result["items"][0]["blockers"][-1])

    def test_cache_is_invalidated_when_source_bytes_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, manifest = root / "clip.json", root / "manifest.json"
            source.write_text(json.dumps(clip(root_end=[1, 0, 0])), encoding="utf8")
            manifest.write_text(json.dumps({"clips": [dict(id="a", name="a", resourceKind="body", status="ready", file="clip.json", sourceAsset="Dialog/A.uasset")]}), encoding="utf8")
            first = native.build_catalog(manifest, cache_dir=root / "cache")
            source.write_text(json.dumps(clip(root_end=[9, 0, 0])), encoding="utf8")
            second = native.build_catalog(manifest, cache_dir=root / "cache")
            self.assertNotEqual(first["items"][0]["sourceSha256"], second["items"][0]["sourceSha256"])
            self.assertEqual(second["items"][0]["measurements"]["rootTravelCm"], 9)


if __name__ == "__main__":
    unittest.main()
