"""Explicit same-budget recovery of a stopped character-centre experiment.

Validation and copying never start WAI, open a provider, rewrite the source, or
refund a reservation. The caller still owns process stop and the existing ledger.
"""
from __future__ import annotations

from collections import Counter
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import tempfile

EXPERIMENT = "continuous-character-center-20261025"
ISOLATION = "wai-qwen-voice-avatar-isolated-v1"
MARKER = ".wai-voice-avatar-batch.json"
LIMITS = {"listener": 18, "voice": 30, "action": 60, "background": 120}
BOUNDS = {"qwen": (245760, 16384), "background": (131072, 4096)}
TERMINAL_TURNS = {"completed", "cancelled", "failed"}
TERMINAL_EFFECTS = {"done", "cancelled", "forgotten", "skipped", "failed"}


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def _plain(path):
    path = Path(path).absolute()
    for item in (path, *path.parents):
        if item.exists() or item.is_symlink():
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("resume_path_contains_link")
    return path


def _digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _ledger_content_hash(ledger):
    # The only tolerated constructor change is conservative PCM-credit rounding.
    stable = dict(ledger)
    stable.pop("pcmBytes", None)
    return hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def inventory(root):
    root = _plain(root)
    result = {}
    for path in sorted(root.rglob("*")):
        _plain(path)
        if path.is_file() and path.name != MARKER and not path.name.endswith(".lock"):
            result[path.relative_to(root).as_posix()] = _digest(path)
    return result


def _count_map(value):
    if not isinstance(value, dict) or any(not isinstance(k, str) or type(v) is not int or v < 0 for k, v in value.items()):
        raise ValueError("resume_invalid_counts")
    return value


def _ledger_summary(ledger):
    if ledger.get("experimentId") != EXPERIMENT or ledger.get("blocked") is not False or ledger.get("frozenChannels") != {}:
        raise ValueError("resume_ledger_blocked_or_different_batch")
    limits = ledger.get("channelLimits")
    if (not isinstance(limits, dict) or set(limits) != set(LIMITS)
            or any(type(v) is not int or not 0 < v <= LIMITS[k] for k, v in limits.items())
            or ledger.get("responseLimit") != sum(limits.values())
            or type(ledger.get("turnLimit")) is not int or not 0 < ledger["turnLimit"] <= 12):
        raise ValueError("resume_budget_limit_changed")
    pcm_limit, pcm, reserved = (ledger.get(k) for k in ("pcmByteLimit", "pcmBytes", "pcmReservedBytes"))
    if (any(type(x) is not int or x < 0 for x in (pcm_limit, pcm, reserved))
            or not 0 < pcm_limit <= 480 * 32000 or pcm % 2 or reserved % 2
            or not pcm <= reserved <= pcm_limit):
        raise ValueError("resume_invalid_pcm_reservation")
    turns, rows = ledger.get("turns"), ledger.get("responses")
    if (not isinstance(turns, list) or not turns or any(not isinstance(x, str) or not x for x in turns)
            or len(set(turns)) != len(turns) or len(turns) >= ledger["turnLimit"] or not isinstance(rows, list)):
        raise ValueError("resume_requires_remaining_turns")
    counts, unknown, row_ids = Counter(), [], set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or row["id"] in row_ids or row.get("channel") not in LIMITS:
            raise ValueError("resume_invalid_provider_record")
        row_ids.add(row["id"])
        if row.get("state") == "unused":
            if row.get("responseId") is not None or row.get("terminalObserved") is True or row.get("usage") is not None:
                raise ValueError("resume_started_response_marked_unused")
            continue
        if (row.get("state") not in {"reported", "unknown"} or row.get("terminalObserved") is not True
                or row.get("status") not in {"completed", "cancelled", "failed", "incomplete"}
                or not isinstance(row.get("responseId"), str) or not row["responseId"]):
            raise ValueError("resume_requires_provider_terminal")
        bounds = row.get("maxTokens", {})
        expected = BOUNDS["background" if row["channel"] == "background" else "qwen"]
        if (bounds.get("input"), bounds.get("output")) != expected:
            raise ValueError("resume_maximum_reservation_changed")
        if row["state"] == "reported":
            usage = row.get("usage")
            if not isinstance(usage, dict) or any(type(usage.get(k)) is not int or usage[k] < 0 for k in ("total_tokens", "input_tokens", "output_tokens")):
                raise ValueError("resume_invalid_reported_usage")
        else:
            if ledger.get("unknownUsagePolicy") != "terminal_missing_usage_keeps_full_reservation":
                raise ValueError("resume_unknown_usage_policy_changed")
            unknown.append(row["id"])
        counts[row["channel"]] += 1
    if any(counts[k] > limits[k] for k in limits) or sum(counts.values()) >= ledger["responseLimit"]:
        raise ValueError("resume_requires_remaining_responses")
    if counts["listener"] >= limits["listener"] or counts["voice"] >= limits["voice"] or reserved >= pcm_limit:
        raise ValueError("resume_requires_remaining_voice_admission")
    return {"usedTurns": len(turns), "usedResponses": sum(counts.values()), "usedChannels": dict(counts),
            "unknownIds": unknown, "unknownMaximumReservedTokens": sum(sum(BOUNDS["background" if r["channel"] == "background" else "qwen"]) for r in rows if r.get("state") == "unknown"),
            "turnIds": turns, "limits": limits, "turnLimit": ledger["turnLimit"],
            "pcmBytes": pcm, "pcmReservedBytes": reserved, "pcmByteLimit": pcm_limit}


def _history(source, turn_ids):
    users, messages, deliveries = {}, {}, {}
    for line in (source / "visible_transcript.jsonl").read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        if entry.get("op") == "created":
            message = entry.get("message", {})
            identity = message.get("message_id")
            if not identity or identity in messages:
                raise ValueError("resume_duplicate_visible_message")
            messages[identity] = message
            delivery_id = message.get("delivery_id")
            if delivery_id:
                if not isinstance(delivery_id, str) or delivery_id in deliveries:
                    raise ValueError("resume_duplicate_visible_delivery")
                deliveries[delivery_id] = message
            if message.get("role") == "user":
                request = message.get("metadata", {}).get("request_id")
                if not request or request in users:
                    raise ValueError("resume_duplicate_or_unowned_user_input")
                users[request] = message
        elif entry.get("op") in {"acked", "cancelled"}:
            message = deliveries.get(entry.get("delivery_id"))
            if not message or message.get("delivery_state") != "pending_ack":
                raise ValueError("resume_invalid_delivery_transition")
            if entry["op"] == "cancelled":
                # Match VisibleTurnLedger.cancel_delivery: only a known pending
                # delivery may be cancelled. Never promote interrupted output
                # to delivered or turn a delivered reply into a cancellation.
                if (not isinstance(entry.get("reason"), str) or not entry["reason"]
                        or message.get("role") not in {"assistant", "system"}
                        or message.get("turn_id") not in {m.get("turn_id") for m in users.values()}):
                    raise ValueError("resume_invalid_delivery_cancellation")
                message["delivery_state"] = "cancelled"
            else:
                message["delivery_state"] = "delivered"
        elif entry.get("op") != "settlement_step":
            raise ValueError("resume_unknown_transcript_operation")
    if set(users) != set(turn_ids) or len({m.get("turn_id") for m in users.values()}) != len(users):
        raise ValueError("resume_history_ledger_mismatch")
    return dict(Counter(message.get("delivery_state") for message in deliveries.values()))


def _queues(source):
    result = {}
    # SQLite can create SHM files even for a read-only connection. Inspect exact
    # private copies (including WAL/SHM), never the original stopped runtime.
    with tempfile.TemporaryDirectory(prefix="character-center-resume-check-") as directory:
        scratch = Path(directory)
        for label, name in (("reply_effects", "pending_effects.sqlite3"), ("input_maintenance", "input_maintenance.sqlite3")):
            if not (source / name).is_file():
                raise ValueError("resume_queue_database_missing")
            for suffix in ("", "-wal", "-shm"):
                original = source / (name + suffix)
                if original.exists():
                    _plain(original)
                    shutil.copy2(original, scratch / original.name)
            with closing(sqlite3.connect((scratch / name).as_uri() + "?mode=ro", uri=True)) as db:
                if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise ValueError("resume_database_corrupt")
                counts = dict(db.execute("SELECT state,count(*) FROM effects GROUP BY state"))
            if any(state not in TERMINAL_EFFECTS and count for state, count in counts.items()):
                raise ValueError("resume_background_not_settled")
            result[label] = counts
    return result


def _same_path(a, b):
    return os.path.normcase(str(Path(a).absolute())) == os.path.normcase(str(Path(b).absolute()))


def _terminal_runtime(evidence):
    runtime = evidence.get("runtime", {})
    counts = _count_map(runtime.get("turns"))
    if (evidence.get("experiment") != ISOLATION or evidence.get("batch_id") != EXPERIMENT
            or evidence.get("synthetic_only") is not True or runtime.get("active_acks") != 0
            or any(k not in TERMINAL_TURNS and n for k, n in counts.items())
            or any(_count_map(evidence.get("observer", {}).get("active", {})).values())):
        raise ValueError("resume_runtime_not_settled")
    return counts


def _parent_receipt(path, child_source, output, current_turn_ids, process_alive, seen=None):
    """Prove an earlier restored prefix from its untouched source and receipts.

    The shared ledger is intentionally live across restarts, so its historical
    hash is not compared to today's ledger. Original evidence/status/manifest,
    source bytes and the complete visible input prefix must still match.
    """
    path, child_source, output = _plain(path), _plain(child_source), _plain(output)
    seen = set() if seen is None else set(seen)
    if not path.is_file() or not path.is_relative_to(output) or str(path) in seen:
        raise ValueError("resume_invalid_parent_chain")
    seen.add(str(path))
    value = read(path)
    if (value.get("experimentId") != EXPERIMENT or not _same_path(value.get("restoredDirectory", ""), child_source)
            or not _same_path(value.get("outputDirectory", ""), output) or value.get("seedSyntheticMemories") is not False
            or value.get("historyAcknowledgedByRecovery") is not False or value.get("oldLedgerRetained") is not True):
        raise ValueError("resume_parent_binding_mismatch")
    old_source = _plain(value.get("sourceDirectory", ""))
    if old_source == child_source or old_source.is_relative_to(child_source) or child_source.is_relative_to(old_source):
        raise ValueError("resume_invalid_parent_chain")
    prior_ids = value.get("turnIds")
    if (not isinstance(prior_ids, list) or not prior_ids or len(set(prior_ids)) != len(prior_ids)
            or value.get("usedTurns") != len(prior_ids) or current_turn_ids[:len(prior_ids)] != prior_ids):
        raise ValueError("resume_parent_turn_prefix_mismatch")
    controls, hashes = value.get("controls", {}), value.get("controlHashes", {})
    if not all(name in controls and name in hashes for name in ("state", "evidence", "status", "manifest", "ledger")):
        raise ValueError("resume_parent_proof_missing")
    for name, digest in hashes.items():
        if name == "ledger":
            if not _same_path(controls[name], output / "ledger.json"):
                raise ValueError("resume_parent_ledger_mismatch")
            continue
        artifact = _plain(controls.get(name, ""))
        if not artifact.is_file() or not artifact.is_relative_to(output) or _digest(artifact) != digest:
            raise ValueError("resume_parent_proof_changed")
    state, manifest = read(controls["state"]), read(controls["manifest"])
    if (type(value.get("previousPid")) is not int or value["previousPid"] <= 0
            or state.get("pid") != value["previousPid"] or state.get("cloud") is not True
            or process_alive(value["previousPid"]) is not False):
        raise ValueError("resume_parent_process_not_stopped")
    marker = read(old_source / MARKER)
    if (marker.get("experiment") != ISOLATION or marker.get("batch_id") != EXPERIMENT or marker.get("synthetic_only") is not True
            or marker.get("state") != "running" or _digest(old_source / MARKER) != value.get("markerSha256")
            or inventory(old_source) != value.get("files") or manifest.get("experimental") is not True
            or not _same_path(manifest.get("dataDirectory", ""), old_source)):
        raise ValueError("resume_parent_source_changed")
    deliveries = _history(old_source, prior_ids)
    evidence, status = read(controls["evidence"]), read(controls["status"])
    process_counts = _terminal_runtime(evidence)
    if (evidence.get("queues") != _queues(old_source) or evidence["runtime"].get("deliveries", {}) != deliveries
            or status.get("experimentId") != EXPERIMENT or status.get("connected") is not False
            or status.get("budget", {}).get("reserved") != 0 or status["budget"].get("turns") != len(prior_ids)
            or status["budget"].get("responses") != value.get("usedResponses")):
        raise ValueError("resume_parent_evidence_mismatch")
    previous = value.get("priorReceipt")
    inherited = Counter()
    if previous is not None:
        if (not isinstance(previous, dict) or _digest(_plain(previous.get("path", ""))) != previous.get("sha256")):
            raise ValueError("resume_parent_chain_hash_mismatch")
        ancestor = _parent_receipt(previous["path"], old_source, output, prior_ids, process_alive, seen)
        inherited.update(ancestor["runtimeTurns"])
        if sum(process_counts.values()) != len(prior_ids) - len(ancestor["turnIds"]):
            raise ValueError("resume_parent_process_turn_mismatch")
    elif sum(process_counts.values()) != len(prior_ids):
        raise ValueError("resume_parent_terminal_proof_missing")
    cumulative = inherited + Counter(process_counts)
    if dict(cumulative) != value.get("runtimeTurns"):
        raise ValueError("resume_parent_terminal_counts_mismatch")
    old_transcript = (old_source / "visible_transcript.jsonl").read_bytes()
    if not (child_source / "visible_transcript.jsonl").read_bytes().startswith(old_transcript):
        raise ValueError("resume_parent_visible_prefix_changed")
    return {"path": str(path), "sha256": _digest(path), "turnIds": prior_ids, "runtimeTurns": dict(cumulative)}


def validate_source(source, output, *, process_alive, state_path, evidence_path, status_path, manifest_path=None, prior_receipt_path=None):
    """Read-only proof that the original batch can continue with its old ledger."""
    source, output = _plain(source), _plain(output)
    if not source.is_dir() or not output.is_dir():
        raise ValueError("resume_source_missing")
    controls = {"state": _plain(state_path), "evidence": _plain(evidence_path), "status": _plain(status_path), "ledger": output / "ledger.json"}
    if any(not p.is_file() or not p.is_relative_to(output) for p in controls.values()):
        raise ValueError("resume_receipts_outside_output")
    marker = read(source / MARKER)
    if (marker.get("experiment") != ISOLATION or marker.get("batch_id") != EXPERIMENT
            or marker.get("synthetic_only") is not True or marker.get("state") != "running"):
        raise ValueError("resume_requires_matching_isolated_batch")
    state = read(controls["state"])
    pid = state.get("pid")
    if type(pid) is not int or pid <= 0 or state.get("cloud") is not True or process_alive(pid) is not False:
        raise ValueError("resume_requires_stopped_process")
    if manifest_path is None:
        matches = [p for p in output.glob("source-manifest-*.json") if os.path.normcase(str(Path(read(p).get("dataDirectory", "")).absolute())) == os.path.normcase(str(source))]
        if not matches:
            raise ValueError("resume_source_manifest_missing")
        manifest_path = max(matches, key=lambda p: p.stat().st_mtime_ns)
    manifest_path = _plain(manifest_path)
    if not manifest_path.is_file() or not manifest_path.is_relative_to(output):
        raise ValueError("resume_manifest_outside_output")
    manifest = read(manifest_path)
    if (manifest.get("experimental") is not True
            or os.path.normcase(str(Path(manifest.get("dataDirectory", "")).absolute())) != os.path.normcase(str(source))
            or not isinstance(manifest.get("sourceHashes"), dict) or not manifest["sourceHashes"]):
        raise ValueError("resume_source_manifest_mismatch")
    controls["manifest"] = manifest_path
    if prior_receipt_path is None:
        candidates = [p for p in output.glob("resume-receipt*.json") if _same_path(read(p).get("restoredDirectory", ""), source)]
        if len(candidates) > 1:
            raise ValueError("resume_ambiguous_parent_receipt")
        if candidates:
            prior_receipt_path = candidates[0]
    if prior_receipt_path is not None:
        controls["priorReceipt"] = _plain(prior_receipt_path)
    control_hashes = {name: _digest(path) for name, path in controls.items()}
    source_files, marker_hash = inventory(source), _digest(source / MARKER)
    ledger = read(controls["ledger"])
    summary = _ledger_summary(ledger)
    deliveries = _history(source, summary["turnIds"])
    queues = _queues(source)
    evidence, status = read(controls["evidence"]), read(controls["status"])
    runtime = evidence.get("runtime", {})
    process_counts = _terminal_runtime(evidence)
    prior = _parent_receipt(prior_receipt_path, source, output, summary["turnIds"], process_alive) if prior_receipt_path is not None else None
    inherited = Counter(prior["runtimeTurns"] if prior else {})
    if sum(process_counts.values()) != summary["usedTurns"] - (len(prior["turnIds"]) if prior else 0):
        raise ValueError("resume_runtime_not_settled")
    counts = dict(inherited + Counter(process_counts))
    if evidence.get("queues") != queues or runtime.get("deliveries", {}) != deliveries:
        raise ValueError("resume_durable_evidence_mismatch")
    budget = status.get("budget", {})
    if (status.get("experimentId") != EXPERIMENT or status.get("connected") is not False
            or status.get("cloudEnabled") is not True or budget.get("blocked") is not False
            or budget.get("reserved") != 0 or budget.get("turns") != summary["usedTurns"]
            or budget.get("responses") != summary["usedResponses"] or budget.get("unknown") != len(summary["unknownIds"])
            or budget.get("turnLimit") != summary["turnLimit"] or budget.get("responseLimit") != ledger["responseLimit"]):
        raise ValueError("resume_status_ledger_mismatch")
    if process_alive(pid) is not False or inventory(source) != source_files or _digest(source / MARKER) != marker_hash or any(_digest(controls[k]) != value for k, value in control_hashes.items()):
        raise ValueError("resume_source_changed_during_validation")
    return {"experimentId": EXPERIMENT, "sourceDirectory": str(source), "outputDirectory": str(output),
            "previousPid": pid, "markerSha256": marker_hash, "files": source_files,
            "controls": {k: str(v) for k, v in controls.items()}, "controlHashes": control_hashes,
            "ledgerSha256": control_hashes["ledger"], "ledgerContentSha256": _ledger_content_hash(ledger), "queues": queues, "runtimeTurns": counts,
            "processRuntimeTurns": process_counts, "priorReceipt": {k: prior[k] for k in ("path", "sha256")} if prior else None,
            "deliveriesPreserved": deliveries, "pendingAckPreserved": deliveries.get("pending_ack", 0), **summary}


def _verify_stopped(receipt, process_alive):
    if receipt.get("experimentId") != EXPERIMENT or process_alive(receipt["previousPid"]) is not False:
        raise ValueError("resume_requires_stopped_process")
    source = _plain(receipt["sourceDirectory"])
    if inventory(source) != receipt["files"] or _digest(source / MARKER) != receipt["markerSha256"]:
        raise ValueError("resume_source_changed")
    if receipt.get("priorReceipt"):
        prior = receipt["priorReceipt"]
        if _digest(_plain(prior["path"])) != prior["sha256"]:
            raise ValueError("resume_parent_chain_hash_mismatch")
        _parent_receipt(prior["path"], source, receipt["outputDirectory"], receipt["turnIds"], process_alive)


def restore_snapshot(source, config, receipt, *, process_alive):
    """Copy state into configure's new marker-only directory, preserving bytes."""
    source, target = _plain(source), _plain(config.data_dir)
    if (str(source) != receipt.get("sourceDirectory") or config.batch_id != EXPERIMENT
            or source == target or source.is_relative_to(target) or target.is_relative_to(source)
            or set(p.name for p in target.iterdir()) != {MARKER}):
        raise ValueError("resume_requires_new_snapshot_directory")
    marker = read(target / MARKER)
    if marker.get("experiment") != ISOLATION or marker.get("batch_id") != EXPERIMENT or marker.get("synthetic_only") is not True or marker.get("state") != "prepared":
        raise ValueError("resume_requires_new_prepared_marker")
    _verify_stopped(receipt, process_alive)
    if any(_digest(_plain(receipt["controls"][name])) != value for name, value in receipt["controlHashes"].items()):
        raise ValueError("resume_accounting_or_receipt_changed")
    for name in receipt["files"]:
        destination = target / name
        _plain(destination)
        if not destination.absolute().is_relative_to(target) or ".." in Path(name).parts:
            raise ValueError("resume_invalid_inventory_path")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with (source / name).open("rb") as src, destination.open("xb") as dst:
            shutil.copyfileobj(src, dst)
    _verify_stopped(receipt, process_alive)
    if inventory(target) != receipt["files"] or any(_digest(_plain(receipt["controls"][name])) != value for name, value in receipt["controlHashes"].items()):
        raise ValueError("resume_copy_verification_failed")
    return {**receipt, "restoredDirectory": str(target), "seedSyntheticMemories": False,
            "historyAcknowledgedByRecovery": False, "oldLedgerRetained": True}


def bootstrap_resumed(config, receipt, *, process_alive, bootstrap=None):
    """Optional caller entrypoint. No invocation happens at module import."""
    target = _plain(config.data_dir)
    _verify_stopped(receipt, process_alive)
    if config.batch_id != EXPERIMENT or str(target) != receipt.get("restoredDirectory") or inventory(target) != receipt["files"]:
        raise ValueError("resume_target_changed_before_bootstrap")
    if read(target / MARKER).get("state") != "prepared":
        raise ValueError("resume_target_already_used")
    # CenterBudget may conservatively round pcmBytes up to an existing reserved
    # credit. Revalidate bounds/records rather than rewriting or refunding it here.
    ledger = read(receipt["controls"]["ledger"])
    current = _ledger_summary(ledger)
    if (_ledger_content_hash(ledger) != receipt["ledgerContentSha256"]
            or any(current[key] != receipt[key] for key in ("turnIds", "usedResponses", "usedChannels", "unknownIds", "unknownMaximumReservedTokens", "limits", "turnLimit", "pcmReservedBytes", "pcmByteLimit"))
            or not receipt["pcmBytes"] <= current["pcmBytes"] <= receipt["pcmReservedBytes"]):
        raise ValueError("resume_ledger_changed_before_bootstrap")
    if bootstrap is None:
        from tools.voice_avatar.bootstrap import bootstrap_runtime
        bootstrap = bootstrap_runtime
    return bootstrap(config, seed=False)
