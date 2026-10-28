"""Local cross-language contract checks; no provider, keys or cloud usage."""
import importlib.util
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parents[1] / "character-center"
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location("library_protocol_test", HERE / "protocol.py")
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)


def command(row):
    return {"operation": "append", "actions": [row]}


def test_browser_and_backend_accept_exactly_the_same_expanded_permission_packets():
    packets = []
    for definition in protocol.load_catalog():
        row = {"action": definition["id"], "anchor": "immediate"}
        if definition["executor"] == "control":
            row["activity_token"] = "activity:5:read_seated"
        packets.append(command(row))
        contract = definition.get("performanceContract", {})
        for variant in contract.get("variant_set", []):
            packets.append(command({**row, "performance": {"variant_set": [variant]}}))
        for micro in contract.get("micro_set", []):
            packets.append(command({**row, "performance": {"micro_set": [micro]}}))
        if contract.get("total_seconds"):
            minimum = definition.get("durationContract", {}).get("minimumSeconds", definition.get("duration", 1))
            packets.append(command({**row, "performance": {"total_seconds": [minimum + 1, minimum + 20]}}))
    valid_count = len(packets)
    wave = {"action": "gesture:wave", "anchor": "immediate"}
    bad_rows = [
        {**wave, "action": ["gesture:wave"]}, {**wave, "anchor": ["immediate"]},
        {**wave, "late": None}, {**wave, "late": ["skip"]},
        {**wave, "delay_ms": None}, {**wave, "delay_ms": True}, {**wave, "delay_ms": 2 ** 53},
        {**wave, "performance": None}, {**wave, "performance": {"total_seconds": 9}},
        {**wave, "performance": {"variant_set": []}},
        {**wave, "performance": {"variant_set": ["exact", "exact"]}},
        {**wave, "performance": {"micro_set": ["invented"]}},
        {**wave, "activity_token": "unrelated"},
    ]
    control = {"action": "control:pause_activity", "anchor": "immediate"}
    bad_rows.extend([{**control, "activity_token": value} for value in [None, "", True, "x" * 161]])
    packets.extend(command(row) for row in bad_rows)
    packets.append({"operation": "replace", "actions": [{**control, "activity_token": "actual"}]})
    script = """
import {validateCharacterCommands} from './realtime/character-center/catalog.mjs';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
console.log(JSON.stringify(JSON.parse(raw).map(packet=>{
 try{return {ok:true,value:validateCharacterCommands(packet)}}catch{return {ok:false}}
})));
"""
    browser = json.loads(subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT,
        input=json.dumps(packets), text=True, encoding="utf-8", capture_output=True, check=True).stdout)
    backend = []
    for packet in packets:
        try:
            backend.append({"ok": True, "value": protocol.parse_actions(json.dumps(packet))})
        except (ValueError, TypeError):
            backend.append({"ok": False})
    assert backend == browser
    assert all(item["ok"] for item in backend[:valid_count])
    assert all(not item["ok"] for item in backend[valid_count:])
