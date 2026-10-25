"""Explicit stopped-experiment snapshot recovery; never resets a usage ledger."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import sqlite3

EXPERIMENT = "parallel-duplex-director-20261024"
MARKER = ".wai-voice-avatar-batch.json"


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def inventory(root):
    from tools.voice_avatar.bootstrap import _assert_plain_path
    result = {}
    for path in sorted(root.rglob("*")):
        _assert_plain_path(path)
        if path.is_file() and path.name != MARKER and not path.name.endswith(".lock"):
            result[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def validate_source(source, output, *, process_alive):
    """Fail before copying if ownership, accounting or queue settlement is unclear."""
    from tools.voice_avatar.bootstrap import _assert_plain_path
    source, output = Path(source).absolute(), Path(output).absolute()
    _assert_plain_path(source)
    _assert_plain_path(output)
    marker, ledger, state = read(source / MARKER), read(output / "ledger.json"), read(output / "server-state.json")
    if (marker.get("experiment") != "wai-qwen-voice-avatar-isolated-v1"
            or marker.get("batch_id") != EXPERIMENT or marker.get("synthetic_only") is not True
            or marker.get("state") != "running" or state.get("batch") != EXPERIMENT
            or ledger.get("experimentId") != EXPERIMENT):
        raise ValueError("resume_requires_matching_isolated_batch")
    pid = state.get("pid")
    if type(pid) is not int or pid <= 0 or process_alive(pid):
        raise ValueError("resume_requires_stopped_process")
    responses = ledger.get("responses")
    if (ledger.get("blocked") is not False or ledger.get("turnLimit") != 6 or ledger.get("responseLimit") != 24
            or not isinstance(responses, list)
            or any(not isinstance(row, dict) or row.get("state") not in {"reported", "unused"}
                   for row in responses)):
        raise ValueError("resume_requires_settled_usage")
    for row in responses:
        if row["state"] == "reported":
            usage = row.get("usage")
            if (not isinstance(usage, dict)
                    or any(type(usage.get(key)) is not int or usage[key] < 0
                           for key in ("total_tokens", "input_tokens", "output_tokens"))):
                raise ValueError("resume_requires_reported_usage")
    if sum(row["state"] != "unused" for row in responses) >= ledger["responseLimit"]:
        raise ValueError("resume_requires_remaining_responses")
    ids = ledger["turns"]
    if not ids or len(ids) >= 6 or len(set(ids)) != len(ids):
        raise ValueError("resume_requires_remaining_turns")
    # Bind this output/ledger to the actual persisted input history, not just a batch label.
    messages = [read_line["message"] for line in (source / "visible_transcript.jsonl").read_text(encoding="utf-8").splitlines()
                if (read_line := json.loads(line)).get("op") == "created"]
    users = {m.get("metadata", {}).get("request_id"): m for m in messages if m.get("role") == "user"}
    if set(users) != set(ids):
        raise ValueError("resume_history_ledger_mismatch")
    fixture_file = Path(__file__).with_name("inputs.json")
    fixtures = read(fixture_file)
    normalized = lambda text: "".join(c for c in text if c.isalnum())
    by_text = {normalized(c["text"]): c["id"] for c in fixtures["clips"]}
    completed = [by_text.get(normalized(users[i]["content"])) for i in ids]
    if completed != fixtures["sequence"][:len(ids)]:
        raise ValueError("resume_requires_verified_fixture_prefix")
    # Existing pending jobs must not be silently rerun as part of a restart.
    for name in ("pending_effects.sqlite3", "input_maintenance.sqlite3"):
        path = source / name
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("resume_database_corrupt")
            if db.execute("SELECT COUNT(*) FROM effects WHERE state NOT IN ('done','cancelled','forgotten')").fetchone()[0]:
                raise ValueError("resume_background_not_settled")
    return {"completedFixtures": completed, "usedTurns": len(ids),
            "usedResponses": sum(r["state"] != "unused" for r in ledger["responses"]),
            "ledgerSha256": hashlib.sha256((output / "ledger.json").read_bytes()).hexdigest(),
            "previousPid": pid, "files": inventory(source)}


def restore_snapshot(source, config, receipt):
    source, target = Path(source), config.data_dir
    if source.resolve() == target.resolve() or set(p.name for p in target.iterdir()) != {MARKER}:
        raise ValueError("resume_requires_new_snapshot_directory")
    if inventory(source) != receipt["files"]:
        raise ValueError("resume_source_changed")
    for name in receipt["files"]:
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, destination)
    if inventory(source) != receipt["files"] or inventory(target) != receipt["files"]:
        raise ValueError("resume_copy_verification_failed")
    return receipt
