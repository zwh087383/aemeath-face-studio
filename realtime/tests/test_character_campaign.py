"""Campaign coverage, bounded accounting and real-time fixtures; no network."""
import importlib.util
from pathlib import Path
import sys
import pytest

ROOT=Path(__file__).resolve().parents[2]

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

manifest=module("campaign_manifest",ROOT/"realtime/character-campaign/manifest.py")
budget=module("campaign_budget",ROOT/"realtime/character-center/budget.py")

def test_exact_user_coverage_and_reproducibility():
    data=manifest.build()
    assert data==manifest.build()
    assert manifest.validate(data)
    long=[s for s in data["scenarios"] if s["kind"]=="long"]
    assert sum(len(s["gapsSeconds"]) for s in long)==40
    assert all(60<t<300 for s in long for t in s["gapsSeconds"])
    assert all("beforeTurn" not in v for s in long for v in s["interruptions"])
    assert len({t["id"] for s in data["scenarios"] for t in s["turns"]})==180
    assert sum(s["limits"][k] for s in data["scenarios"] for k in s["limits"])==data["totals"]["responses"]

def test_manifest_is_immutable(tmp_path):
    path=tmp_path/"manifest.json"
    original=manifest.write(path)
    assert original==manifest.write(path)
    path.write_text("{}")
    with pytest.raises(ValueError,match="exists"): manifest.write(path)

def test_old_budget_ceiling_remains_default(tmp_path):
    limits={**budget.LIMITS,"action":180}
    with pytest.raises(ValueError,match="channel_limits"):
        budget.CenterBudget(tmp_path/"reject.json",limits=limits)
    ledger=budget.CenterBudget(tmp_path/"accept.json",limits=limits,limit_ceilings=limits)
    assert ledger.snapshot()["channels"]["action"]["limit"]==180

def test_known_terminal_unknown_is_retained_and_cap_not_refunded(tmp_path):
    limits={"listener":1,"voice":1,"action":1,"background":1}
    ledger=budget.CenterBudget(tmp_path/"ledger.json",limits=limits)
    row=ledger.reserve("voice","provider","turn")
    ledger.created(row,"reply")
    ledger.settle(row,{"id":"reply","status":"cancelled","usage":None})
    assert row["state"]=="unknown" and row["terminalObserved"]
    assert not ledger.available("voice")
    assert ledger.available("action")
    assert ledger.snapshot()["unknownReservedTokens"]==262144

def test_unconfirmed_terminal_freezes_that_channel(tmp_path):
    ledger=budget.CenterBudget(tmp_path/"ledger.json")
    row=ledger.reserve("action","provider","turn")
    ledger.block("unconfirmed_terminal",row)
    assert not ledger.available("action")
    assert ledger.available("voice")

def test_strict_previous_batch_policy_unchanged(tmp_path):
    ledger=budget.CenterBudget(tmp_path/"ledger.json",stop_on_unknown=True)
    row=ledger.reserve("voice","provider","turn")
    ledger.created(row,"reply")
    ledger.settle(row,{"id":"reply","status":"cancelled","usage":None})
    assert ledger.snapshot()["blocked"]
    assert not ledger.available("action")

def test_fixture_runner_cannot_choose_actions():
    runner=(ROOT/"realtime/character-campaign/run-browser.js").read_text(encoding="utf-8")
    for prohibited in ("componentCommand(","gesture:wave","actions:[","character_actions","setAttitude(","local-wave"):
        assert prohibited not in runner
    assert "gap.actualSeconds" in runner and "performance.now()" in runner

def test_execution_event_stages_with_same_action_id_are_not_deduplicated(tmp_path):
    import json
    analyzer=module("campaign_analysis",ROOT/"realtime/character-campaign/analyze.py")
    case=next(s for s in manifest.build()["scenarios"] if s["kind"]=="single")
    folder=tmp_path/"cases"/case["id"];folder.mkdir(parents=True)
    events=[{"id":"same-action","type":kind,"at":i,"action":"gesture:agree"}
            for i,kind in enumerate(("action_queued","action_started","action_completed"))]
    (folder/"campaign-observations.json").write_text(json.dumps({"phase":"finished","samples":[{"body":{"events":events}}, {"body":{"events":events}}]}))
    result=analyzer.case_summary(tmp_path,case)
    assert result["actions"]=={"gesture:agree":1}
    assert result["bodyEventCounts"]=={"action_queued":1,"action_started":1,"action_completed":1}

def test_simulated_clock_advances_only_authorized_gap_and_holds_real_work():
    clocks=module('campaign_simclock',ROOT/'realtime/character-campaign/simclock.py')
    stamp=[1000.0]
    clock=clocks.IdleClock([180,90],wall=lambda:stamp[0],monotonic=lambda:stamp[0])
    clock.begin(0);stamp[0]+=2
    held=clock.step(0,hold=True)
    assert held['advancedSeconds']==0 and held['logicalElapsedSeconds']==2
    moved=clock.step(0)
    assert moved['advancedSeconds']==12 and stamp[0]==1002
    with pytest.raises(ValueError,match='previous_gap'):clock.begin(1)
    for _ in range(90):
        stamp[0]+=.25;last=clock.step(0)
    assert 180<=last['logicalElapsedSeconds']<190
    assert stamp[0]<1030
    clock.begin(1)
    with pytest.raises(ValueError):clock.step(0)


def test_transcription_capacity_does_not_change_stimuli_or_global_ceiling():
    policy=module('campaign_policy',ROOT/'realtime/character-campaign/policy.py')
    original=manifest.build()
    case=next(c for c in original['scenarios'] if c['kind']=='long')
    selected=policy.effective_case(case,20)
    assert selected['limits']['listener']==20 and case['limits']['listener']==8
    assert selected['turns']==case['turns'] and selected['gapsSeconds']==case['gapsSeconds']
    assert selected['limits']['action']==case['limits']['action']
    assert original['totals']['limits']['listener']==400
    assert original['totals']['responses']==5660
    single=next(c for c in original['scenarios'] if c['kind']=='single')
    assert policy.effective_case(single,20)==single
    with pytest.raises(ValueError):policy.effective_case(case,21)


def test_split_transcripts_cannot_count_as_more_dialogue_fixtures():
    analyzer=module('campaign_coverage_analysis',ROOT/'realtime/character-campaign/analyze.py')
    spec={'turns':[{'id':'one'},{'id':'two'},{'id':'three'}]}
    inputs=[{'id':'one','at':100,'sentPackets':50,'finishedAt':300},
            {'id':'two','at':500,'sentPackets':0}]
    turns=[{'id':str(i),'input':{'startAt':at},'metrics':{'lastSpeechToVoiceMs':2000}}
           for i,at in enumerate((150,250))]
    coverage=analyzer.input_coverage(spec,inputs,turns)
    assert len(coverage[0]['responseIds'])==2
    assert sum(r['voiced'] for r in coverage)==1
    assert sum(r['sent'] for r in coverage)==1
    assert sum(r['feedComplete'] for r in coverage)==1
