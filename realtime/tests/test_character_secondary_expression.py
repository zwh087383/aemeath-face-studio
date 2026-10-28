"""Pure protocol validation: no service, provider, cloud or playback calls."""
import importlib.util
import json
from pathlib import Path

import pytest


SPEC = importlib.util.spec_from_file_location(
    "character_secondary_protocol", Path(__file__).parents[1] / "character-center" / "protocol.py")
protocol = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(protocol)


def expression(**changes):
    return {"mode": "attitude", "kind": "concern", "strength": .7,
            "evidenceRef": "user:one", **changes}


def test_original_single_attitude_shape_is_preserved():
    value = expression()
    assert protocol.parse_expression(json.dumps(value)) == value


def test_two_stances_share_the_single_server_checked_evidence():
    value = expression(secondary={"kind": "warm", "strength": .3})
    assert protocol.parse_expression(json.dumps(value)) == value
    schema = protocol.tools([{"id": "gesture:wave"}])[0]["function"]["parameters"]
    assert schema["required"] == ["mode", "kind", "strength", "evidenceRef"]
    assert schema["properties"]["secondary"]["additionalProperties"] is False


@pytest.mark.parametrize("secondary", [
    None, [], {}, {"kind": "warm"}, {"kind": "concern", "strength": .3},
    {"kind": "anger", "strength": .3}, {"kind": "warm", "strength": True},
    {"kind": "warm", "strength": -.1}, {"kind": "warm", "strength": 1.1},
    {"kind": "warm", "strength": .3, "evidenceRef": "invented"},
    {"kind": "warm", "strength": .3, "recipeId": "arbitrary"},
    {"kind": "warm", "strength": .3, "emotion": {"V": 1}},
])
def test_invalid_or_authority_expanding_secondary_is_rejected(secondary):
    with pytest.raises(ValueError):
        protocol.parse_expression(json.dumps(expression(secondary=secondary)))


@pytest.mark.parametrize("mode", ["reaction", "clear"])
def test_reaction_and_clear_do_not_gain_a_persistent_secondary(mode):
    with pytest.raises(ValueError, match="invalid_secondary_attitude"):
        protocol.parse_expression(json.dumps(expression(mode=mode, secondary={"kind": "warm", "strength": .3})))


def test_duplicate_nested_fields_and_nonfinite_strength_remain_rejected():
    for raw in [
        '{"mode":"attitude","kind":"concern","strength":0.5,"evidenceRef":"u","secondary":{"kind":"warm","kind":"sad","strength":0.3}}',
        json.dumps(expression(secondary={"kind": "warm", "strength": float("nan")})),
    ]:
        with pytest.raises(ValueError):
            protocol.parse_expression(raw)
