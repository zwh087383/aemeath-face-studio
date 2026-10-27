"""No cloud: compact packets must preserve original execution semantics."""
import importlib.util
import json
from pathlib import Path
import sys
import pytest

HERE = Path(__file__).parents[1] / "character-center"
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("compact_test", HERE / "compact_protocol.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def context(codec):
    return {"action_codebook_version": codec.version, "evidence_refs": ["user:one", "execution:two"]}


def test_full_expression_and_multi_step_plan_keep_semantics():
    codec = m.Codec()
    wave = codec.ids.index("gesture:wave")
    read = codec.ids.index("activity:read_seated")
    raw = {"f": [1, m.KINDS.index("concern"), 0.735, 1], "a": [[wave], [read, 1, 2]],
           "o": 2, "r": 2, "g": "读完后保持坐姿"}
    face, body = codec.decode(json.dumps(raw), context(codec))
    assert face == ("set_expression", {"mode":"reaction", "kind":"concern", "strength":0.735, "evidenceRef":"execution:two"})
    assert body == ("perform_actions", {"operation":"replace", "review":"wait", "goal":"读完后保持坐姿",
        "actions":[{"action":"gesture:wave", "anchor":"immediate", "delay_ms":0},
                   {"action":"activity:read_seated", "anchor":"voice", "late":"reconsider", "delay_ms":0}]})


@pytest.mark.parametrize("operation", range(4))
@pytest.mark.parametrize("review", range(3))
def test_all_operations_and_review_choices_survive(operation, review):
    codec = m.Codec()
    _, body = codec.decode(json.dumps({"o":operation,"r":review}), context(codec))[0]
    assert body["operation"] == m.OPERATIONS[operation]
    assert body["review"] == m.REVIEWS[review]


def test_defaults_do_not_introduce_new_wait_policy_or_limits():
    codec = m.Codec()
    rows = [[i] for i in range(83)] * 2
    _, body = codec.decode(json.dumps({"a": rows}), context(codec))[0]
    assert body["operation"] == "append"
    assert "review" not in body
    assert len(body["actions"]) == 166
    assert all(row["anchor"] == "immediate" for row in body["actions"])


def test_face_only_does_not_change_body_and_clear_body_does_not_change_face():
    codec = m.Codec()
    assert [name for name,_ in codec.decode('{"f":[0,0,0.5]}', context(codec))] == ["set_expression"]
    assert codec.decode('{"o":3}', context(codec)) == [("perform_actions", {"operation":"clear", "actions":[]})]


@pytest.mark.parametrize("raw", [
    '{"a":[[-1]]}', '{"a":[[83]]}', '{"a":[[true]]}', '{"a":[[1,2]]}',
    '{"a":[[1,0,3]]}', '{"f":[0,0,0.5,2]}', '{"f":[1,0,0.5]}',
    '{"f":[0,0,NaN]}', '{"f":[0,0,true]}', '{"f":[0,0,1.1]}',
    '{"o":0,"a":[[1]]}', '{"a":[[1]],"g":12}', '{"o":0,"o":1}', '{}',
    '{"a":[[1]],"bone":99}', '{"a":[[1]],"r":true}',
])
def test_malformed_or_unprovided_indices_are_rejected_atomically(raw):
    codec = m.Codec()
    with pytest.raises((ValueError, TypeError)):
        codec.decode(raw, context(codec))


def test_codebook_version_and_order_are_bound_to_request():
    codec = m.Codec()
    value = context(codec)
    value["action_codebook_version"] = "old"
    with pytest.raises(ValueError, match="stale"):
        codec.decode('{"a":[[1]]}', value)
    import planner_input
    payload = {"available_actions": planner_input.compact_catalog(codec.catalog)}
    original = json.loads(json.dumps(payload))
    numbered = codec.payload(payload)
    assert payload == original
    assert numbered["available_actions"]["actions"][7][1:] == original["available_actions"]["actions"][7]
    payload["available_actions"]["actions"].reverse()
    with pytest.raises(ValueError, match="order"):
        codec.payload(payload)


def test_format_budget_is_independent_and_unknown_stops_both_arms(tmp_path):
    import format_probe
    ledger = format_probe.FormatLedger(tmp_path / "ledger.json")
    row = ledger.reserve("compact", "one", 0)
    ledger.settle(row, {"terminal":True})
    with pytest.raises(ValueError, match="admission"):
        ledger.reserve("original", "two", 0)
    with pytest.raises(ValueError, match="preserved"):
        format_probe.FormatLedger(ledger.path)
