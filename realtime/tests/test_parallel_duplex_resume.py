"""Offline recovery checks with real SQLite/files, no runtime/provider startup."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
from types import SimpleNamespace

import pytest

FACE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(FACE.parents[1] / "WAI"))
spec = importlib.util.spec_from_file_location("parallel_resume_test", FACE / "realtime/parallel-duplex/resume.py")
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def put(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


@pytest.fixture
def batch(tmp_path):
    source, output = tmp_path / "source", tmp_path / "output"
    source.mkdir(); output.mkdir()
    put(source / r.MARKER, {"experiment": "wai-qwen-voice-avatar-isolated-v1", "batch_id": r.EXPERIMENT, "synthetic_only": True, "state": "running"})
    put(output / "server-state.json", {"batch": r.EXPERIMENT, "pid": 42})
    put(output / "ledger.json", {"experimentId": r.EXPERIMENT, "blocked": False, "turnLimit": 6, "responseLimit": 24, "turns": ["t1", "t2"], "responses": [{"state": "reported", "usage": {"total_tokens": 3, "input_tokens": 2, "output_tokens": 1}}, {"state": "unused"}]})
    texts = r.read(FACE / "realtime/parallel-duplex/inputs.json")["clips"]
    source.joinpath("visible_transcript.jsonl").write_text("\n".join(json.dumps({"op": "created", "message": {"role": "user", "content": texts[i]["text"], "metadata": {"request_id": f"t{i+1}"}}}) for i in range(2)), encoding="utf-8")
    put(source / "correction_events.json", {"new_fact": "无糖乌龙茶"})
    for name in ("pending_effects.sqlite3", "input_maintenance.sqlite3"):
        with sqlite3.connect(source / name) as db:
            db.execute("CREATE TABLE effects(state TEXT)")
            db.execute("INSERT INTO effects VALUES ('done')")
    return source, output


def test_restore_preserves_history_corrections_source_and_budget(batch, tmp_path):
    source, output = batch
    before = r.inventory(source)
    ledger = (output / "ledger.json").read_bytes()
    receipt = r.validate_source(source, output, process_alive=lambda _: False)
    assert receipt["completedFixtures"] == ["memory-drink", "correction"]
    target = tmp_path / "restored"; target.mkdir()
    put(target / r.MARKER, {"state": "prepared"})
    r.restore_snapshot(source, SimpleNamespace(data_dir=target), receipt)
    assert r.inventory(target) == before == r.inventory(source)
    assert (output / "ledger.json").read_bytes() == ledger
    assert r.read(target / r.MARKER)["state"] == "prepared"


@pytest.mark.parametrize("state", ["unknown", "reserved", "active"])
def test_uncertain_usage_cannot_resume(batch, state):
    source, output = batch
    data = r.read(output / "ledger.json"); data["responses"][0]["state"] = state; put(output / "ledger.json", data)
    with pytest.raises(ValueError, match="settled_usage"):
        r.validate_source(source, output, process_alive=lambda _: False)


def test_active_process_cannot_resume(batch):
    with pytest.raises(ValueError, match="stopped_process"):
        r.validate_source(*batch, process_alive=lambda _: True)


@pytest.mark.parametrize("usage", [None, {}, {"total_tokens": 3, "input_tokens": 2, "output_tokens": -1}])
def test_reported_label_does_not_replace_actual_usage(batch, usage):
    source, output = batch
    data = r.read(output / "ledger.json")
    data["responses"][0]["usage"] = usage
    put(output / "ledger.json", data)
    with pytest.raises(ValueError, match="reported_usage"):
        r.validate_source(source, output, process_alive=lambda _: False)


def test_exhausted_response_budget_cannot_resume(batch):
    source, output = batch
    data = r.read(output / "ledger.json")
    data["responses"] = [data["responses"][0]] * 24
    put(output / "ledger.json", data)
    with pytest.raises(ValueError, match="remaining_responses"):
        r.validate_source(source, output, process_alive=lambda _: False)


def test_different_history_cannot_resume(batch):
    source, output = batch
    data = r.read(output / "ledger.json"); data["turns"] = ["other"]; put(output / "ledger.json", data)
    with pytest.raises(ValueError, match="history_ledger"):
        r.validate_source(source, output, process_alive=lambda _: False)


def test_pending_maintenance_cannot_resume(batch):
    source, output = batch
    with sqlite3.connect(source / "input_maintenance.sqlite3") as db:
        db.execute("UPDATE effects SET state='running'")
    with pytest.raises(ValueError, match="background_not_settled"):
        r.validate_source(source, output, process_alive=lambda _: False)


def test_source_change_cannot_resume(batch, tmp_path):
    source, output = batch
    receipt = r.validate_source(source, output, process_alive=lambda _: False)
    put(source / "correction_events.json", {"new_fact": "changed"})
    target = tmp_path / "target"; target.mkdir(); put(target / r.MARKER, {})
    with pytest.raises(ValueError, match="source_changed"):
        r.restore_snapshot(source, SimpleNamespace(data_dir=target), receipt)
