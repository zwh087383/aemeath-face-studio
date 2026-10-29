"""Add observation to the existing tested campaign driver, without action commands."""
import hashlib
import json
import argparse
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "outputs/action-preservation-live-20261028"
parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, default=OUT)
parser.add_argument("--active-barge", action="store_true")
parser.add_argument("--interrupt-supplement", action="store_true")
parser.add_argument("--postvoice-barge", action="store_true")
args = parser.parse_args()
OUT = args.output.resolve()
if (OUT / "run-browser.generated.js").exists():
    raise RuntimeError("existing_driver_evidence_never_overwrite")
driver = (ROOT / "realtime/character-campaign/run-browser.js").read_text(encoding="utf-8-sig")
probe = (HERE / "probe.js").read_text(encoding="utf-8-sig")
replacements = {
    "  const api=window.characterCenter,": probe + "\n  await installLiveProbe();\n  const api=window.characterCenter,",
    "   await sleep(3500);result.phase='finishing';": "   result.phase='observe_autonomous_continuation';await publish();await sleep(15000);result.phase='finishing';",
    "   await post('/api/campaign/observations',result);await publish();": "   result.liveProbe=window.liveProbe.finish();\n   await post('/api/campaign/observations',result);await publish();",
    "const {samples,bodyEvents,...rest}=result;": "const {samples,bodyEvents,liveProbe,...rest}=result;",
}
for old, new in replacements.items():
    assert driver.count(old) == 1, "source_driver_contract_changed"
    driver = driver.replace(old, new)
if args.interrupt_supplement:
    assert args.active_barge, "supplement_requires_active_action_observation"
    old = "const spec=await(await fetch('/api/campaign/case')).json();"
    assert driver.count(old) == 1, "fixture_selection_contract_changed"
    driver = driver.replace(old, "const originalSpec=await(await fetch('/api/campaign/case')).json();"
        "if(originalSpec.id!=='short-03')throw Error('wrong_supplement_case');"
        "const spec={...originalSpec,turns:[originalSpec.turns[0],originalSpec.turns[2]],"
        "gapsSeconds:[0],interruptions:[{beforeTurn:1,voiceAgeMs:900}],activities:[]};")
if args.active_barge:
    old = "s.audio.status==='playing'&&now()-v.voiceAt>=rule.voiceAgeMs"
    assert driver.count(old) == 1, "interrupt_driver_contract_changed"
    driver = driver.replace(old, old + "&&Boolean(s.body.active)")
    # One fixture may create more than one listener/voice turn. Never wait on a
    # cancelled early fragment while its replacement is actually speaking.
    old = "const v=s.trials[startCount];return v?.voiceAt!==undefined"
    assert driver.count(old) == 1, "interrupt_turn_contract_changed"
    driver = driver.replace(old, "const v=s.trials.slice(startCount).findLast(v=>!v.revoked);return v?.voiceAt!==undefined")
    driver = driver.replace("before:observe(),targetTurn:t.id", "before:observe(),targetTurn:api.state().trials.slice(startCount).findLast(v=>!v.revoked)?.id??t.id")
if args.postvoice_barge:
    assert not args.interrupt_supplement, "postvoice_gate_uses_full_five_input_case"
    old = "    if(!nextBarge){\n     result.phase='idle_gap:'+i;"
    assert driver.count(old) == 1, "postvoice_gap_contract_changed"
    driver = driver.replace(old, """    if(!nextBarge&&i===0){
     try{
      await wait(s=>s.audio.status==='ended'&&s.audio.sourceCount===0&&s.body.active?.status==='playing','body_only_input_window',12);
      gap.bodyOnlyTarget=true;
      result.interruptions.push({kind:'postvoice_body_barge_next_turn',at:now(),before:observe(),targetTurn:api.state().trials.at(-1)?.id});
     }catch(e){result.errors.push('missed_body_only_window:'+e.message);}
    }
    if(!nextBarge&&!gap.bodyOnlyTarget){
     result.phase='idle_gap:'+i;""")
path = OUT / "run-browser.generated.js"
path.write_text(driver, encoding="utf-8")
(OUT / "driver-source.json").write_text(json.dumps({"generatedSha256":hashlib.sha256(path.read_bytes()).hexdigest(),
    "originalDriverSha256":hashlib.sha256((ROOT/"realtime/character-campaign/run-browser.js").read_bytes()).hexdigest(),
    "instrumentationOnly":True,"tailObservationSeconds":15,"manualActionCommands":False,
    "interruptRequiresActiveModelAction":args.active_barge,
    "postvoiceInputRequiresActiveModelAction":args.postvoice_barge,
    "supplementFixtureIndices":[0,2] if args.interrupt_supplement else None},indent=2),encoding="utf-8")
print("Generated read-only instrumented browser driver; no model called.")
