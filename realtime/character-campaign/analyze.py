"""Read-only analysis of every attempted case, including failures and unknowns."""
from collections import Counter
import json
import math
from pathlib import Path
import statistics
import time

CACHE={}
def read(path,default=None):
    try:return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError,ValueError):return default

def stats(values):
    values=sorted(v for v in values if isinstance(v,(int,float)) and math.isfinite(v))
    if not values:return {"n":0,"median":None,"p95":None,"max":None}
    return {"n":len(values),"median":round(statistics.median(values),2),"p95":round(values[math.ceil(.95*len(values))-1],2),"max":round(values[-1],2)}

def case_summary(root,spec):
    folder=root/"cases"/spec["id"]
    path=folder/"campaign-observations.json"
    signature=(str(path),path.stat().st_mtime_ns) if path.exists() else None
    if signature and signature in CACHE:return CACHE[signature]
    raw=read(path) or read(folder/"progress.json",{})
    ledger=read(folder/"ledger.json",{})
    reading=read(folder/"reading-cases.json",{})
    turns=raw.get("finalTurns",raw.get("turns",[]))
    voices=[t for t in turns if isinstance(t.get("metrics",{}).get("lastSpeechToVoiceMs"),(int,float))]
    all_events=raw.get("bodyEvents",[])
    if not all_events:
        seen=set()
        for sample in raw.get("samples",[]):
            for event in sample.get("body",{}).get("events",[]):
                key=(event.get("id"),event.get("type"),event.get("at"))
                if key not in seen:seen.add(key);all_events.append(event)
    started=[e for e in all_events if e.get("type")=="action_started"]
    actions=Counter(e.get("action") for e in started)
    failures=[e for e in all_events if e.get("type") in {"action_rejected","action_failed","action_expired"}]
    activity=[]
    for planned in spec.get("activities",[]):
        actual=reading.get(planned["caseId"],{})
        events=actual.get("events",[])
        terminal=next((e for e in reversed(events) if e.get("status") in {"done","failed","dropped"}),{})
        states=[]
        for e in events:
            if not states or states[-1]!=e.get("status"):states.append(e.get("status"))
        matched=(terminal.get("status")=="done" and bool(terminal.get("artifactId"))) if planned["expected"]=="complete" else (
            "paused" in states and terminal.get("status")=="done" if planned["expected"]=="interrupted" else terminal.get("status")=="failed")
        owned=[e for e in started if str(e.get("sourceKey",e.get("owner",{}).get("sourceKey",""))).startswith("activity:") and planned["caseId"] in str(e)]
        activity.append({**planned,"states":states,"status":terminal.get("status") or (states[-1] if states else "not_started"),
             "artifactId":terminal.get("artifactId"),"reason":terminal.get("block",{}).get("reason"),"matched":matched,"bodyActions":dict(Counter(e["action"] for e in owned))})
    samples=raw.get("samples",[])
    vals=[s.get("face",{}).get("math",{}).get("emotion",{}).get("V") for s in samples]
    arousal=[s.get("face",{}).get("math",{}).get("emotion",{}).get("A") for s in samples]
    unknown=[r for r in ledger.get("responses",[]) if r.get("state")=="unknown"]
    active=[r for r in ledger.get("responses",[]) if r.get("state") in {"active","reserved"}]
    usage=sum((r.get("usage") or {}).get("total_tokens",0) or 0 for r in ledger.get("responses",[]))
    reasons=Counter(str(e.get("reason")) for e in failures)
    result={"id":spec["id"],"kind":spec["kind"],"emotion":spec["emotion"],"label":spec["initialMath"]["label"],"phase":raw.get("phase","not_started"),
      "plannedTurns":len(spec["turns"]),"turns":turns,"admitted":len(turns),"voiced":len(voices),
      "settled":sum(bool(t.get("historySettled") or t.get("settledAt")) for t in turns),"cancelled":sum(bool(t.get("revoked")) for t in turns),
      "firstVoice":stats([t["metrics"]["lastSpeechToVoiceMs"] for t in voices]),
      "bodyLag":stats([-t.get("metrics",{}).get("bodyStartLeadMs") for t in turns if isinstance(t.get("metrics",{}).get("bodyStartLeadMs"),(int,float))]),
      "visibleFaceLag":stats([-t.get("metrics",{}).get("visibleFaceLeadMs") for t in turns if isinstance(t.get("metrics",{}).get("visibleFaceLeadMs"),(int,float))]),
      "activities":activity,"actions":dict(actions),"actionFailures":dict(reasons),"bodyEventCounts":dict(Counter(e.get("type") for e in all_events)),
      "mathV":stats(vals),"mathA":stats(arousal),"sampleCount":len(samples),"errors":raw.get("errors",[]),"gaps":raw.get("gaps",[]),
      "interruptions":raw.get("interruptions",[]),"usage":{"reportedTokens":usage,"states":dict(Counter(r.get("state") for r in ledger.get("responses",[]))),
         "channels":dict(Counter(r.get("channel") for r in ledger.get("responses",[]) if r.get("state")!="unused")),"pcmSeconds":ledger.get("pcmBytes",0)/32000,
         "unknown":len(unknown),"active":len(active),"unknownMaxReservedTokens":sum(sum(r.get("maxTokens",{}).get(k,0) for k in ("input","output")) for r in unknown)},
      "renderFault":raw.get("finalBrowser",{}).get("renderFault"),"runtimeEvidence":raw.get("runtimeEvidence",{}),
      "recordingStartedAt":raw.get("recordingStartedAt"),"renderPerformance":raw.get("renderPerformance"),
      "video":next((p.name for p in folder.glob("preview-*-original-speed.webm")),None)}
    if signature:CACHE[signature]=result
    return result

def summarize(root):
    root=Path(root);manifest=read(root/"manifest.json");state=read(root/"campaign-state.json",{})
    cases=[case_summary(root,s) for s in manifest["scenarios"]]
    voice=[t["metrics"]["lastSpeechToVoiceMs"] for c in cases for t in c["turns"] if isinstance(t.get("metrics",{}).get("lastSpeechToVoiceMs"),(int,float))]
    lag=[-t["metrics"]["bodyStartLeadMs"] for c in cases for t in c["turns"] if isinstance(t.get("metrics",{}).get("bodyStartLeadMs"),(int,float))]
    activities=[a for c in cases for a in c["activities"]]
    summary={"updatedAt":time.time(),"seed":manifest["seed"],"planned":manifest["totals"],"current":state.get("current"),"cases":cases,
      "finished":sum(c["phase"]=="finished" for c in cases),"attempted":len(state.get("cases",{})),
      "admittedTurns":sum(c["admitted"] for c in cases),"voicedTurns":len(voice),"firstVoice":stats(voice),"bodyLag":stats(lag),
      "cancelledTurns":sum(c["cancelled"] for c in cases),"activityMatched":sum(bool(a["matched"]) for a in activities),
      "activityStarted":sum(a["status"]!="not_started" for a in activities),"activityTerminal":dict(Counter(a["status"] for a in activities)),
      "usage":{"reportedTokens":sum(c["usage"]["reportedTokens"] for c in cases),"unknown":sum(c["usage"]["unknown"] for c in cases),
        "pcmSeconds":sum(c["usage"]["pcmSeconds"] for c in cases),"unknownMaxReservedTokens":sum(c["usage"]["unknownMaxReservedTokens"] for c in cases)},
      "emotionCoverage":{emotion:{"planned":sum(c["emotion"]==emotion for c in cases),"finished":sum(c["emotion"]==emotion and c["phase"]=="finished" for c in cases),
          "voiced":sum(c["voiced"] for c in cases if c["emotion"]==emotion)} for emotion in ("high_sad","high_excited","mild_sad","happy")}}
    return summary

if __name__=="__main__":
    import sys
    root=Path(sys.argv[1]);result=summarize(root)
    (root/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({k:v for k,v in result.items() if k!="cases"},ensure_ascii=False,indent=2))
