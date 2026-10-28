"""Local planner projection and cross-language protocol checks; no providers."""
import importlib.util
from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).parents[2]
HERE = ROOT / "realtime" / "character-center"


def load(name):
    spec = importlib.util.spec_from_file_location("library_planner_" + name, HERE / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


protocol, planner = load("protocol"), load("planner_input")


def test_compact_projection_keeps_all_permissions_and_variant_prerequisites_without_geometry():
    rows = protocol.load_catalog()
    before = json.loads(json.dumps(rows))
    view = planner.compact_catalog(rows)
    assert [row[0] for row in view["actions"]] == [row["id"] for row in rows]
    columns = view["columns"]
    for full, compact in zip(rows, view["actions"]):
        row = dict(zip(columns, compact))
        assert view["conditions"][row["requires"]] == full.get("requires", {})
        variants = view["variant_sets"][row["variants"]]
        assert set(variants) == set(full.get("variants", {}))
        permission = dict(view["performance_permissions"][row["performance_permission"]])
        if permission.get("variant_set") == "listed_variants":
            permission["variant_set"] = list(variants)
        assert permission == full.get("performanceContract", {})
        for name, variant in full.get("variants", {}).items():
            if "requires" in variant:
                assert view["conditions"][variants[name]["requires"]] == variant["requires"]
            if "meaning" in variant:
                assert variants[name]["meaning"] == variant["meaning"]
        duration = dict(view["duration_contracts"][row["duration_contract"]])
        duration.setdefault("sourceSeconds", row["seconds"])
        duration.setdefault("minimumSeconds", row["seconds"])
        duration.setdefault("returnSeconds", 0)
        for key in ("mode", "sourceSeconds", "minimumSeconds", "entrySeconds", "startSeconds", "endSeconds",
                    "loopSeconds", "returnSeconds", "settleSeconds", "continuation", "conditionalPreparation"):
            if key in full.get("durationContract", {}):
                assert duration[key] == full["durationContract"][key]
    text = planner.encoded(view)
    assert "sourceAsset" not in text and "clipSha256" not in text and "geometry" not in text
    assert len(text) < len(planner.encoded(rows)) * .35
    assert len(view["performance_permissions"]) < len(rows)
    assert rows == before


def test_model_sees_the_real_control_tokens_and_support_preserving_conditions():
    view = planner.compact_catalog(protocol.load_catalog())
    rows = {row[0]: dict(zip(view["columns"], row)) for row in view["actions"]}
    nod = rows["action:nod"]
    default = view["conditions"][nod["requires"]]
    supported = view["variant_sets"][nod["variants"]]["support-preserving"]
    assert default["support"] == "standing"
    assert view["conditions"][supported["requires"]] == {"support": ["standing", "seated"], "freeHands": []}
    assert "append" in view["semantics"]["control"] and "resumeToken" in view["semantics"]["control"]
    assert "原速起势" in view["semantics"]["duration"]
    assert "最终收稳settleSeconds" in view["semantics"]["duration"]
    actor = planner.actor_view({"activityToken": "activity:2:read", "resumeToken": None,
                               "capabilities": ["chin-surface-calibrated"], "bones": {"private": [1, 2, 3]}})
    assert actor["activityToken"] == "activity:2:read" and actor["resumeToken"] is None
    assert actor["capabilities"] == ["chin-surface-calibrated"] and "bones" not in actor


def test_model_receives_measured_prop_state_and_conditional_book_preparation():
    source = {"props": {"book": {"visible": True, "attachment": "both", "openness": .8,
              "worldTransform": {"position": [1, 2, 3], "quaternion": [0, 0, 0, 1]}},
              "hidden": {"visible": False, "position": [99, 99, 99]}}}
    before = deepcopy(source)
    actor = planner.actor_view(source)
    assert actor["objects"]["book"]["position"] == [1, 2, 3]
    assert actor["objects"]["book"]["openness"] == .8
    assert "hidden" not in actor["objects"]
    actor["objects"]["book"]["position"][0] = 8
    assert source == before
    view = planner.compact_catalog(protocol.load_catalog())
    rows = {row[0]: dict(zip(view["columns"], row)) for row in view["actions"]}
    for name in ("put_book_standing", "put_book_seated"):
        contract = view["duration_contracts"][rows["activity:" + name]["duration_contract"]]
        assert contract["conditionalPreparation"]["seconds"] == 1.4
        assert contract["conditionalPreparation"]["when"]["bookOpennessGreaterThan"] == .05


def test_rule_and_tool_schema_explain_permission_without_changing_original_output_tools():
    tools = protocol.tools()
    assert [tool["function"]["name"] for tool in tools] == ["set_expression", "perform_actions"]
    schema = tools[1]["function"]["parameters"]
    properties = schema["properties"]["actions"]["items"]["properties"]
    assert properties["activity_token"]["minLength"] == 1
    assert properties["activity_token"]["maxLength"] == 160
    assert properties["performance"]["properties"]["variant_set"]["minItems"] == 1
    assert properties["performance"]["properties"]["variant_set"]["uniqueItems"] is True
    assert "必须operation=append" in protocol.RULES
    assert "不自动恢复" in protocol.RULES and "不擅自延长" in protocol.RULES
    assert "每轮动作数量、顺序、重复、不做由你决定" in protocol.RULES


def action_command(action, **fields):
    return {"operation": "append", "actions": [{"action": action, "anchor": "immediate", **fields}]}


def test_python_and_javascript_accept_the_same_complete_catalogue_permissions_and_strict_controls():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node runtime required for cross-language validation")
    rows = protocol.load_catalog()
    cases = []
    for row in rows:
        fields = {"activity_token": "activity:7:read"} if row.get("executor") == "control" else {}
        cases.append((row["id"] + ":default", action_command(row["id"], **fields), True))
        for variant in row.get("performanceContract", {}).get("variant_set", []):
            cases.append((row["id"] + ":variant:" + variant,
                          action_command(row["id"], **fields, performance={"variant_set": [variant]}), True))
        for micro in row.get("performanceContract", {}).get("micro_set", []):
            cases.append((row["id"] + ":micro:" + micro,
                          action_command(row["id"], **fields, performance={"micro_set": [micro]}), True))
        if row.get("performanceContract", {}).get("total_seconds"):
            minimum = row["durationContract"]["minimumSeconds"]
            cases.append((row["id"] + ":duration", action_command(row["id"], performance={"total_seconds": [minimum, minimum + 3]}), True))
    invalid = [
        ("null-delay", action_command("gesture:wave", delay_ms=None)),
        ("null-late", action_command("gesture:wave", late=None)),
        ("bool-delay", action_command("gesture:wave", delay_ms=True)),
        ("unknown-variant", action_command("gesture:wave", performance={"variant_set": ["invented"]})),
        ("duplicate-variant", action_command("action:nod", performance={"variant_set": ["exact", "exact"]})),
        ("empty-variant", action_command("action:nod", performance={"variant_set": []})),
        ("unauthorized-duration", action_command("gesture:wave", performance={"total_seconds": 30})),
        ("null-performance", action_command("activity:read_seated", performance=None)),
        ("missing-control-token", action_command("control:pause_activity")),
        ("long-control-token", action_command("control:pause_activity", activity_token="x" * 161)),
        ("null-control-token", action_command("control:pause_activity", activity_token=None)),
        ("token-on-body", action_command("gesture:wave", activity_token="activity:7:read")),
        ("replace-control", {**action_command("control:pause_activity", activity_token="activity:7:read"), "operation": "replace"}),
    ]
    cases.extend((name, value, False) for name, value in invalid)
    program = """
      import fs from 'node:fs';
      import {validateCharacterCommands} from './realtime/character-center/catalog.mjs';
      const input=JSON.parse(fs.readFileSync(0,'utf8'));
      console.log(JSON.stringify(input.map(value=>{
        try{return {accepted:true,value:validateCharacterCommands(value)}}catch(error){return {accepted:false}}
      })));
    """
    process = subprocess.run([node, "--input-type=module", "-e", program], cwd=ROOT,
                             input=json.dumps([value for _, value, _ in cases]), text=True,
                             encoding="utf-8", capture_output=True, check=True, timeout=20)
    javascript = json.loads(process.stdout)
    for (name, value, accepted), js in zip(cases, javascript, strict=True):
        try:
            py = {"accepted": True, "value": protocol.parse_actions(json.dumps(value), rows)}
        except (ValueError, TypeError):
            py = {"accepted": False}
        assert py["accepted"] == accepted, name
        assert js == py, name
