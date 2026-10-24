"""Measure local exported clips without changing assets or admitting runtime use.

Source coordinates remain Unreal centimeters/native axes. Low-motion intervals and
phase seams are review candidates, not foot contacts or verified interrupt exits.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import inspect
import json
import math
import re
import zlib
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = "aemeath-preparation/v1"
MEASUREMENT_REVISION = "source-kinematics-20261023-v1"
PRIMARY = {
    "root": ["Root", "Bip001"],
    "torso": ["Bip001Pelvis", "Bip001Spine", "Bip001Spine1", "Bip001Spine2"],
    "head": ["Bip001Neck", "Bip001Head"],
    "leftArm": ["Bip001LClavicle", "Bip001LUpperArm", "Bip001LForearm", "Bip001LHand"],
    "rightArm": ["Bip001RClavicle", "Bip001RUpperArm", "Bip001RForearm", "Bip001RHand"],
    "leftLeg": ["Bip001LThigh", "Bip001LCalf", "Bip001LFoot", "Bip001LToe0"],
    "rightLeg": ["Bip001RThigh", "Bip001RCalf", "Bip001RFoot", "Bip001RToe0"],
}
CORE = set(sum(PRIMARY.values(), []))
COMBAT = re.compile(r"(?:^|[/_\-])(attack\d*|skill\d*|burst\d*|death|dead|execute|combat|dodge)(?:[/_\-.]|$)", re.I)


def read_json(path: Path):
    raw = path.read_bytes()
    if path.suffix == ".gz":
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8-sig"))


def qmul(a, b):
    xyz = a[..., 3:4] * b[..., :3] + b[..., 3:4] * a[..., :3] + np.cross(a[..., :3], b[..., :3])
    w = a[..., 3] * b[..., 3] - np.sum(a[..., :3] * b[..., :3], axis=-1)
    return np.concatenate((xyz, w[..., None]), axis=-1)


def qconj(q):
    return q * np.array([-1., -1., -1., 1.])


def qrotate(q, p):
    v = q[..., :3]
    return p + 2 * np.cross(v, np.cross(v, p) + q[..., 3:4] * p)


def qangle(a, b):
    dots = np.abs(np.sum(a * b, axis=-1))
    return 2 * np.arccos(np.clip(dots, -1, 1)) * 180 / math.pi


def angular_velocity(previous, current, dt):
    delta = qmul(current, qconj(previous))
    delta = np.where(delta[..., 3:4] < 0, -delta, delta)
    norm = np.linalg.norm(delta[..., :3], axis=-1)
    angle = 2 * np.arctan2(norm, np.maximum(0, delta[..., 3]))
    factor = np.divide(angle, norm, out=np.full_like(norm, 2.), where=norm > 1e-12)
    return delta[..., :3] * factor[..., None] / dt * 180 / math.pi


def safe_relative(base: Path, relative: str) -> Path:
    path = (base / relative).resolve()
    if not path.is_relative_to(base.resolve()):
        raise ValueError("Source path leaves export directory")
    return path


def phase_identity(row):
    source = row.get("sourceAsset", row["id"])
    base = Path(source).stem
    found = re.search(r"_(start|end|loop\d*)$", base, re.I)
    phase = found.group(1).lower() if found else "single"
    group_base = base[:found.start()] if found else base
    family_path = str(Path(source).parent / group_base).replace("\\", "/")
    return family_path, phase, base


def intervals(mask, dt, minimum=.1, limit=6):
    result, start = [], None
    for i, flag in enumerate(list(mask) + [False]):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            end = i - 1
            if (end - start) * dt >= minimum - 1e-8:
                result.append({"startSeconds": round(start * dt, 5), "endSeconds": round(end * dt, 5)})
            start = None
    return sorted(result, key=lambda x: x["endSeconds"] - x["startSeconds"], reverse=True)[:limit]


def validate_clip(clip):
    bones, frames = clip.get("bones"), clip.get("frames")
    if not isinstance(bones, list) or not bones or not isinstance(frames, list) or not frames:
        raise ValueError("Missing bones or frames")
    if len(frames) != clip.get("frameCount") or any(len(f) != len(bones) for f in frames):
        raise ValueError("Frame/bone counts disagree")
    names = [b["name"] for b in bones]
    if len(names) != len(set(names)):
        raise ValueError("Duplicate bone names")
    parents = [b["parent"] for b in bones]
    for i, parent in enumerate(parents):
        if not isinstance(parent, int) or parent < -1 or parent >= i:
            raise ValueError("Parents must precede children")
    duration = float(clip.get("duration", 0))
    if not math.isfinite(duration) or duration < 0 or (len(frames) > 1 and duration <= 0):
        raise ValueError("Invalid clip duration")
    p = np.array([[b["p"] for b in frame] for frame in frames], dtype=np.float64)
    q = np.array([[b["q"] for b in frame] for frame in frames], dtype=np.float64)
    s = np.array([[b.get("s", [1, 1, 1]) for b in frame] for frame in frames], dtype=np.float64)
    if p.shape != (len(frames), len(bones), 3) or q.shape != (len(frames), len(bones), 4) or s.shape != p.shape:
        raise ValueError("Invalid transform shape")
    if not all(np.isfinite(a).all() for a in (p, q, s)):
        raise ValueError("Nonfinite source transform")
    norms = np.linalg.norm(q, axis=-1)
    if np.any(norms < 1e-8):
        raise ValueError("Zero quaternion")
    q /= norms[..., None]
    return names, parents, duration, p, q, s, float(np.max(np.abs(norms - 1)))


def measure_clip(clip):
    names, parents, duration, p, q, s, norm_error = validate_clip(clip)
    count, bone_count = p.shape[:2]
    dt = duration / (count - 1) if count > 1 else None
    index = {name: i for i, name in enumerate(names)}
    core_indices = [i for i, name in enumerate(names) if name in CORE]
    selected = core_indices or list(range(bone_count))
    # Compose ancestors only; full matrices are unnecessary for these landmarks.
    needed = set(selected)
    for i in list(needed):
        parent = parents[i]
        while parent >= 0:
            needed.add(parent)
            parent = parents[parent]
    wp, wq, ws = {}, {}, {}
    for i in sorted(needed):
        parent = parents[i]
        if parent < 0:
            wp[i], wq[i], ws[i] = p[:, i], q[:, i], s[:, i]
        else:
            wp[i] = wp[parent] + qrotate(wq[parent], p[:, i] * ws[parent])
            wq[i] = qmul(wq[parent], q[:, i])
            ws[i] = ws[parent] * s[:, i]
    local_excursion = np.max(qangle(q, q[0:1]), axis=0)
    local_translation = np.max(np.linalg.norm(p - p[0:1], axis=-1), axis=0)
    world_speeds = {i: np.linalg.norm(np.diff(wp[i], axis=0), axis=-1) / dt if dt else np.array([]) for i in selected}
    angular = angular_velocity(q[:-1], q[1:], dt) if dt else np.empty((0, bone_count, 3))
    angular_speeds = np.linalg.norm(angular, axis=-1)
    parts = {}
    for part, bone_names in PRIMARY.items():
        ids = [index[n] for n in bone_names if n in index]
        if ids:
            parts[part] = {
                "bones": [names[i] for i in ids],
                "maxLocalRotationFromStartDeg": round(float(np.max(local_excursion[ids])), 6),
                "maxWorldDisplacementFromStartCm": round(max(float(np.linalg.norm(wp[i] - wp[i][0], axis=-1).max()) for i in ids), 6),
                "maxLocalAngularSpeedDegPerSec": round(float(np.max(angular_speeds[:, ids])) if dt else 0., 6),
            }
    feet = {}
    for side in ("L", "R"):
        name = f"Bip001{side}Foot"
        if name in index:
            i = index[name]
            speed = world_speeds[i]
            heights = wp[i][:, 2]  # Source Unreal up axis, not target/ground height.
            threshold = float(heights.min()) + 2.
            low = (speed <= 3.) & (heights[1:] <= threshold) if dt else np.array([])
            feet[side] = {
                "sourceBone": name,
                "heightSpanCm": round(float(np.ptp(heights)), 6),
                "maxSpeedCmPerSec": round(float(speed.max()) if speed.size else 0., 6),
                "lowMotionNearClipMinimumCandidates": intervals(np.r_[False, low], dt) if dt else [],
                "contactConfirmed": False,
                "note": "源脚低速且接近本片段最低高度，仅供检查，不证明触地、支撑或物理平衡。",
            }
    root_i = index.get("Root", selected[0])
    root_positions = wp[root_i]
    pose_speed = angular_speeds[:, selected].max(axis=1) if dt else np.array([])
    quiet = intervals(np.r_[False, pose_speed <= 15.], dt) if dt else []
    end = {}
    for i in selected:
        end[names[i]] = {
            "firstP": wp[i][0].tolist(), "lastP": wp[i][-1].tolist(),
            "firstQ": q[0, i].tolist(), "lastQ": q[-1, i].tolist(),
            "firstV": ((wp[i][1] - wp[i][0]) / dt).tolist() if dt else None,
            "lastV": ((wp[i][-1] - wp[i][-2]) / dt).tolist() if dt else None,
            "firstW": angular[0, i].tolist() if dt else None,
            "lastW": angular[-1, i].tolist() if dt else None,
        }
    result = {
        "sourceFrames": count, "sourceBones": bone_count, "durationSeconds": duration,
        "sampleIntervalSeconds": dt, "finite": True, "quaternionNormErrorBeforeNormalization": norm_error,
        "scaleRange": [float(s.min()), float(s.max())], "parts": parts,
        "movingBonesAboveHalfDegree": int(np.count_nonzero(local_excursion > .5)),
        "translatedBonesAboveHalfCm": int(np.count_nonzero(local_translation > .5)),
        "rootTravelCm": round(float(np.linalg.norm(np.diff(root_positions, axis=0), axis=-1).sum()), 6),
        "rootEndDisplacementCm": round(float(np.linalg.norm(root_positions[-1] - root_positions[0])), 6),
        "rootEndRotationDeg": round(float(qangle(q[0, root_i], q[-1, root_i])), 6),
        "loopPositionGapMaxCm": round(float(np.max(np.linalg.norm(p[-1] - p[0], axis=-1))), 6),
        "loopRotationGapMaxDeg": round(float(np.max(qangle(q[0], q[-1]))), 6),
        "lowAngularMotionReviewIntervals": quiet, "feet": feet,
        "units": clip.get("units", "source units unknown"),
        "singlePose": count == 1,
    }
    return result, end


def algorithm_fingerprint():
    functions = [qmul, qconj, qrotate, qangle, angular_velocity, intervals, validate_clip, measure_clip]
    body = "\n".join(inspect.getsource(function) for function in functions)
    body += json.dumps(PRIMARY, sort_keys=True)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def seam_cost(left, right):
    common = sorted(set(left) & set(right))
    if not common:
        return {"measurable": False, "reason": "No common measured landmarks"}
    costs = []
    for name in common:
        a, b = left[name], right[name]
        costs.append({
            "bone": name,
            "positionGapCm": float(np.linalg.norm(np.array(a["lastP"]) - b["firstP"])),
            "rotationGapDeg": float(qangle(np.array(a["lastQ"]), np.array(b["firstQ"]))),
            "linearVelocityGapCmPerSec": float(np.linalg.norm(np.array(a["lastV"]) - b["firstV"])) if a["lastV"] is not None and b["firstV"] is not None else None,
            "angularVelocityGapDegPerSec": float(np.linalg.norm(np.array(a["lastW"]) - b["firstW"])) if a["lastW"] is not None and b["firstW"] is not None else None,
        })
    maxima = {key: max((c[key] for c in costs if c[key] is not None), default=None) for key in costs[0] if key != "bone"}
    return {"measurable": True, "landmarks": len(common), **maxima,
            "worstRotationBone": max(costs, key=lambda c: c["rotationGapDeg"])["bone"],
            "automaticTransitionApproved": False}


def apply_usage(row, rules):
    matches = []
    for rule in rules:
        match = rule.get("match", {})
        if match.get("nameRegex") and not re.search(match["nameRegex"], row.get("name", "")):
            continue
        if match.get("sourceRegex") and not re.search(match["sourceRegex"], row.get("sourceAsset", "")):
            continue
        if not match:
            continue
        matches.append(rule)
    matches.sort(key=lambda r: r.get("priority", 0), reverse=True)
    if not matches:
        return {"purpose": "用途待确认", "trigger": "仅手动审阅，不由文件名直接触发",
                "preconditions": ["当前模型实际进入和退出验收"], "prohibited": ["未经检查自动调用"],
                "entry": "未登记可执行入口", "exit": "未登记可执行出口", "cancel": "缺少当前模型取消路线证据"}, []
    rule = matches[0]
    usage = {key: rule.get(key) for key in ("purpose", "trigger", "preconditions", "prohibited", "entry", "exit", "cancel")}
    usage["semanticEvidence"] = rule.get("semanticEvidence", "规则建议，尚需画面确认")
    return usage, [r["id"] for r in matches]


def build_catalog(manifest_path: Path, rules_path: Path | None = None, cache_dir: Path | None = None):
    manifest = read_json(manifest_path)
    root = manifest_path.parent
    rules = read_json(rules_path).get("rules", []) if rules_path and rules_path.exists() else []
    algorithm_hash = algorithm_fingerprint()
    items, endpoints, groups = [], {}, defaultdict(list)
    for number, row in enumerate(manifest.get("clips", []), 1):
        kind = row.get("resourceKind", "unknown")
        family, phase, basename = phase_identity(row)
        usage, rule_ids = apply_usage(row, rules) if kind == "body" else ({
            "purpose": {"ribbon": "身体的配套衣发", "look": "注视方向姿态", "prop-animation": "道具自身动画"}.get(kind, "资源用途待确认"),
            "trigger": "跟随已验证的主体或场景，不独立当交流手势", "preconditions": ["对应身体/道具与绑定已核对"],
            "prohibited": ["与同一部位的完整姿态重复叠加", "未验证组合自动调用"],
            "entry": "需与主体同进度接入", "exit": "需与主体同进度退出", "cancel": "服从主体或场景撤销并保留可信状态"}, [])
        item = {"id": row["id"], "kind": f"native-{kind}", "name": row.get("name", basename),
                "category": row.get("category", "待整理"), "sourceRef": row.get("sourceAsset"),
                "sourceDataRef": row.get("file"), "phase": phase, "family": family,
                "durationSeconds": row.get("duration"), "loopHint": bool(row.get("loop")),
                "sourceSkeleton": row.get("sourceSkeleton"), "sourceAdditiveType": row.get("sourceAdditiveType"),
                "usage": usage, "usageRuleIds": rule_ids, "measurements": {}, "evidence": [],
                "blockers": ["未完成当前模型的自动接入、退出与打断验收"],
                "preparationStatus": "pending", "automaticEligible": False}
        if row.get("status") != "ready" or not row.get("file"):
            item["preparationStatus"] = "blocked"
            item["blockers"].append("资源仅归档，缺可测播放轨迹")
        elif COMBAT.search(row.get("sourceAsset", "")):
            item["preparationStatus"] = "excluded"
            item["blockers"].append("命中战斗资源排除规则")
        else:
            try:
                file = safe_relative(root, row["file"])
                raw = file.read_bytes()
                source_hash = hashlib.sha256(raw).hexdigest()
                cache_file = cache_dir / f"{row['id']}.json" if cache_dir else None
                cached = None
                if cache_file and re.fullmatch(r"[a-zA-Z0-9_-]+", row["id"]):
                    try:
                        candidate = read_json(cache_file)
                        if (candidate.get("sourceSha256") == source_hash
                                and candidate.get("measurementRevision") == MEASUREMENT_REVISION
                                and candidate.get("algorithmSha256") == algorithm_hash):
                            cached = candidate
                    except (ValueError, OSError, EOFError):
                        pass
                if cached:
                    measured, endpoint = cached["measurements"], cached["endpoints"]
                    baked = cached["bakedAdditiveToFullPose"]
                else:
                    clip = read_json(file)
                    measured, endpoint = measure_clip(clip)
                    baked = bool(clip.get("additiveBakedToFullPose"))
                    if cache_file and re.fullmatch(r"[a-zA-Z0-9_-]+", row["id"]):
                        cache_file.parent.mkdir(parents=True, exist_ok=True)
                        cache_file.write_text(json.dumps({"sourceSha256": source_hash, "measurementRevision": MEASUREMENT_REVISION,
                            "algorithmSha256": algorithm_hash,
                            "measurements": measured, "endpoints": endpoint, "bakedAdditiveToFullPose": baked}, ensure_ascii=False, allow_nan=False), encoding="utf-8")
                item["measurements"] = measured
                item["durationSeconds"] = measured["durationSeconds"]
                item["sourceSha256"] = source_hash
                item["bakedAdditiveToFullPose"] = baked
                item["evidence"].append({"level": "all-source-frames-measured", "sourceSha256": item["sourceSha256"],
                                         "note": "源轨迹全帧数值测量；不是目标蒙皮、碰撞、接触或自然度验收"})
                item["preparationStatus"] = "measured_review_pending"
                if kind == "body":
                    endpoints[row["id"]] = endpoint
                    groups[family].append(item)
                    if not rule_ids:
                        item["blockers"].append("尚无用途规则匹配")
                elif kind == "ribbon" and row.get("sourceAdditiveType") != "AAT_None":
                    item["blockers"].append("源additive须按导出实际完整姿态解释，不可重复叠加")
            except (ValueError, KeyError, OSError, EOFError, zlib.error, TypeError, IndexError, json.JSONDecodeError) as error:
                item["preparationStatus"] = "blocked"
                item["blockers"].append(f"测量失败：{error}")
        items.append(item)
        if number % 25 == 0:
            print(f"Native measured {number}/{len(manifest['clips'])}", flush=True)
    # Candidate body/ribbon pairing, deliberately below runtime admission.
    ribbons = defaultdict(list)
    for row in items:
        if row["kind"] == "native-ribbon" and row["preparationStatus"] == "measured_review_pending":
            key = Path(row["sourceRef"]).stem.lower()
            key = re.sub(r"^rib[_-]?", "", key)
            ribbons[key].append(row)
    for row in items:
        if row["kind"] != "native-body":
            continue
        base = Path(row["sourceRef"]).stem.lower()
        possible = ribbons.get(base, [])
        row["clothCandidates"] = [{"id": r["id"], "sameSkeleton": r["sourceSkeleton"] == row["sourceSkeleton"],
                                   "durationGapSeconds": abs((r["durationSeconds"] or 0) - (row["durationSeconds"] or 0)),
                                   "pairingEvidence": "basename only; check skeleton, duration, phase and actual skin", "approved": False} for r in possible]
    families, seams = [], []
    for family, members in sorted(groups.items()):
        phase_map = defaultdict(list)
        for row in members:
            phase_map[row["phase"]].append(row)
        candidates = []
        for left in members:
            targets = []
            if left["phase"] == "start":
                targets = [r for r in members if r["phase"].startswith("loop")]
                if not targets:
                    targets = phase_map.get("end", [])
            elif left["phase"].startswith("loop"):
                targets = [r for r in members if r["phase"].startswith("loop") or r["phase"] == "end"]
            for right in targets:
                seam = {"from": left["id"], "to": right["id"], "evidence": "source endpoint/finite-difference velocity only",
                        **seam_cost(endpoints[left["id"]], endpoints[right["id"]])}
                seams.append(seam)
                candidates.append({"from": left["id"], "to": right["id"]})
        phases = sorted(phase_map)
        has_named_phase = any(p != "single" for p in phases)
        families.append({"family": family, "memberIds": [r["id"] for r in members], "phases": phases,
                         "missingNamedStart": has_named_phase and "start" not in phase_map,
                         "missingNamedEnd": has_named_phase and "end" not in phase_map,
                         "phaseSeamCandidates": candidates, "automaticEligible": False,
                         "note": "名称提供分组；接缝测量不批准循环任意时刻跳到收势。"})
    summary = {"clipsInManifest": len(manifest.get("clips", [])), "items": len(items),
               "byKind": dict(Counter(r["kind"] for r in items)),
               "byStatus": dict(Counter(r["preparationStatus"] for r in items)),
               "sourceFramesMeasured": sum(r["measurements"].get("sourceFrames", 0) for r in items),
               "sourceTransformsMeasured": sum(r["measurements"].get("sourceFrames", 0) * r["measurements"].get("sourceBones", 0) for r in items),
               "bodyFamilies": len(families), "phaseSeamsMeasured": len(seams),
               "bodyFamiliesMissingNamedEnd": sum(f["missingNamedEnd"] for f in families),
               "automaticEligible": 0}
    return {"schema": SCHEMA, "kind": "native", "measurementRevision": MEASUREMENT_REVISION,
            "algorithmSha256": algorithm_hash, "measurementScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "usageRulesSha256": hashlib.sha256(rules_path.read_bytes()).hexdigest() if rules_path and rules_path.exists() else None,
            "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            "summary": summary, "screeningParameters": {"footSpeedCmPerSec": 3., "heightAboveClipMinimumCm": 2.,
                "reviewLowAngularSpeedDegPerSec": 15., "minimumIntervalSeconds": .1,
                "note": "候选筛查初值；不是触地、支撑、出口或自然度通过标准"},
            "items": items, "families": families, "seams": seams,
            "limitations": ["未修改/启用正式人物调度", "源骨架测量不等于PMX实模验收", "未验证动作语义和任意时刻中断",
                            "低脚速与最低高度不证明地面接触", "未恢复完整物理平衡或衣发碰撞"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "outputs/native-complete-20261022/manifest.json")
    parser.add_argument("--rules", type=Path, default=ROOT / "preparation/native-usage-rules.json")
    parser.add_argument("--output", type=Path, default=ROOT / "outputs/action-preparation-20261023/native.json")
    parser.add_argument("--cache-dir", type=Path, default=ROOT / "outputs/action-preparation-20261023/measurements")
    args = parser.parse_args()
    result = build_catalog(args.manifest, args.rules, args.cache_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps(result["summary"], ensure_ascii=False))
    if any(r["preparationStatus"] == "blocked" and "测量失败" in " ".join(r["blockers"]) for r in result["items"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
