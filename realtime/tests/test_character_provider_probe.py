"""No network: bounded billing and shared output validation for the provider probe."""
import importlib.util
import json
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location("probe_test", Path(__file__).parents[1] / "character-center/provider_probe.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def test_unknown_usage_stops_all_new_admission_and_old_batch_is_never_reset(tmp_path):
    path = tmp_path / "ledger.json"
    ledger = m.Ledger(path)
    row = ledger.reserve("deepseek", "one", 0)
    ledger.settle(row, {"terminal": True})
    with pytest.raises(ValueError, match="admission"):
        ledger.reserve("qwen", "two", 0)
    before = path.read_bytes()
    with pytest.raises(ValueError, match="preserved"):
        m.Ledger(path)
    assert path.read_bytes() == before
    assert json.loads(before)["rows"][0]["state"] == "unknown"


def test_six_per_provider_and_twelve_total_no_automatic_continuation(tmp_path):
    ledger = m.Ledger(tmp_path / "ledger.json")
    for provider in ("deepseek", "qwen"):
        for index in range(6):
            row = ledger.reserve(provider, "fixed", index)
            ledger.settle(row, {"terminal": True, "usage": {"input_tokens": 4, "output_tokens": 1, "total_tokens": 5}})
        with pytest.raises(ValueError):
            ledger.reserve(provider, "excess", 0)
    assert len(ledger.data["rows"]) == 12
    assert not ledger.data["blocked"]


def test_valid_usage_without_terminal_cannot_release_batch(tmp_path):
    ledger = m.Ledger(tmp_path / "ledger.json")
    row = ledger.reserve("deepseek", "fixed", 0)
    ledger.settle(row, {"usage": {"input_tokens": 4, "output_tokens": 1, "total_tokens": 5}})
    assert ledger.data["blocked"]


def test_complete_tools_use_existing_schema_and_evidence_checks():
    trace = m.Trace({"evidence_refs": ["user:test"]})
    trace.complete("perform_actions", '{"operation":"keep","actions":[],"review":"wait"}')
    assert trace.value["calls"][0]["valid"]
    assert "firstValidBody" in trace.value["timingsMs"]
    trace.complete("set_expression", '{"mode":"attitude","kind":"warm","strength":0.5,"evidenceRef":"invented"}')
    trace.complete("perform_actions", '{"operation":"append","actions":[{"action":"illegal","anchor":"immediate"}]}')
    assert [x["valid"] for x in trace.value["calls"]] == [True, False, False]
    assert len(m.protocol.load_catalog()) == 83
