"""One isolated, manifest-bounded campaign scenario; no motion choreography."""
from __future__ import annotations
import argparse
import asyncio
from functools import partial
import hashlib
import json
import os
from pathlib import Path
import sys
import time

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
CENTER=ROOT/"realtime/character-center"
sys.path.insert(0,str(CENTER))

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for key in ("manifest","output","data-dir","env-file","wai-root"): p.add_argument("--"+key,type=Path,required=True)
    p.add_argument("--case",required=True)
    p.add_argument("--port",type=int,default=18818)
    p.add_argument("--asset-port",type=int,default=18809)
    p.add_argument("--local-proxy",action="store_true")
    a=p.parse_args()
    from manifest import validate
    manifest=json.loads(a.manifest.read_text(encoding="utf-8"));validate(manifest)
    case=next(s for s in manifest["scenarios"] if s["id"]==a.case)
    out=a.output.resolve();out.mkdir(parents=True,exist_ok=True)
    sys.path.insert(0,str(a.wai_root.resolve()))
    from tools.voice_avatar.bootstrap import configure,bootstrap_runtime
    cfg=configure(a.env_file,a.data_dir,batch_id="campaign-20261027-"+a.case)
    os.environ.update(WAI_LIFE_THREADS="1",WAI_PREPARATION_PROBE="1",WAI_LATENCY_BATCH1="1",WAI_REPLY_PREWARM_POLICY="after_request")
    from budget import CenterBudget
    budget=CenterBudget(out/"ledger.json",max_turns=case["turnLimit"],limits=case["limits"],
        pcm_seconds=case["pcmSeconds"],stop_on_unknown=False,limit_ceilings=case["limits"])
    from provider_accounting import install_accounting
    install_accounting(budget)
    runtime,module=bootstrap_runtime(cfg)
    from tools.voice_avatar.duplex_transport import save_json
    from activity import ReadingActivities
    from aiohttp import web
    from app import create_app,load
    guard=load("campaign_access_guard",ROOT/"realtime/qwen/server.py")
    def allowed(request,mutation=False):
        if not guard.allowed_request(request,require_origin=mutation): raise web.HTTPForbidden(text="Invalid loopback origin")
    from backend import CharacterCenterSession
    from deepseek_planner import DeepSeekConfig,DeepSeekPlannerConnection
    provider=DeepSeekConfig.from_file(a.env_file,proxy="http://127.0.0.1:7890" if a.local_proxy else None)
    factory=load("campaign_proxy_transport",ROOT/"realtime/parallel-duplex/app.py").existing_local_proxy_socket if a.local_proxy else None
    session_class=partial(CharacterCenterSession,planner_connection_class=partial(DeepSeekPlannerConnection,config=provider))
    fixture_log=[]

    def initialise(_main,_output,fixture_id):
        if fixture_id!=case["id"]: raise ValueError("wrong_scenario_initial_condition")
        path=out/"initial-conditions.json"
        if path.exists(): return {"alreadyApplied":True,**json.loads(path.read_text(encoding="utf-8"))}
        system=module.emotion_system
        with system._emotion_lock:
            before=system.dynamics.get_state()
            system.dynamics.reset(E0=case["initialMath"]["E"],R0=system.dynamics.R.copy())
            system._sync_state_and_check_spike();system.save_state()
            result={"fixtureId":fixture_id,"label":case["initialMath"]["label"],"at":time.time(),"before":before,
                "after":system.dynamics.get_state(),"source":"explicit_campaign_math_initial_condition",
                "ongoingDynamics":"unchanged_WAI_math_real_time; no_face_or_motion_targets"}
        save_json(path,result);return result

    class CampaignActivities(ReadingActivities):
        def _read_selected_public_source(self,query,*,read_pages=False):
            spec=next((s for s in case.get("activities",[]) if s["caseId"]==self.current_id),{})
            fault=spec.get("fault")
            if self.current_id=="reading-failure":
                fixture_log.append({"type":"injected_business_fault","fault":fault,"at":time.time(),"networkRequestMade":False})
                save_json(out/"fault-receipts.json",fixture_log)
                # Actual business read path receives the fault; no fabricated body receipt.
                if fault=="empty_source": return {"status":"success","sources":[],"page_extracts":[]}
                if fault=="fetch_timeout": raise TimeoutError("campaign_simulated_source_timeout")
                if fault=="fetch_denied": raise PermissionError("campaign_simulated_source_denied")
                raise RuntimeError("campaign_simulated_source_worker_exception")
            return super()._read_selected_public_source(query,read_pages=read_pages)

    async def case_get(request):
        allowed(request)
        return web.json_response(case)
    async def progress(request):
        allowed(request,True)
        value=await request.json()
        if value.get("id")!=case["id"]: raise web.HTTPBadRequest(text="wrong_case")
        value["serverReceivedAt"]=time.time()
        await asyncio.to_thread(save_json,out/"progress.json",value)
        return web.json_response({"saved":True})
    async def sample_report(request):
        allowed(request,True)
        value=await request.json()
        if value.get("id")!=case["id"]: raise web.HTTPBadRequest(text="wrong_case")
        await asyncio.to_thread(save_json,out/"campaign-observations.json",value)
        return web.json_response({"saved":True})
    async def video(request):
        allowed(request,True)
        path=out/("preview-"+case["id"]+"-original-speed.webm")
        if path.exists(): raise web.HTTPConflict(text="video_already_saved")
        size=0;temp=path.with_suffix(".partial")
        with temp.open("xb") as stream:
            async for chunk in request.content.iter_chunked(65536):
                size+=len(chunk)
                if size>512*1024*1024: raise web.HTTPRequestEntityTooLarge(max_size=512*1024*1024,actual_size=size)
                await asyncio.to_thread(stream.write,chunk)
        temp.replace(path)
        return web.json_response({"saved":True,"bytes":size})
    routes=[web.get("/api/campaign/case",case_get),web.post("/api/campaign/progress",progress),
            web.post("/api/campaign/observations",sample_report),web.post("/api/campaign/video",video)]
    app=create_app(runtime,module,budget,out,cloud=True,asset_port=a.asset_port,session_class=session_class,
        factory=factory,action_provider="deepseek",activity_class=CampaignActivities,initial_state_initializer=initialise,extra_routes=routes)
    save_json(out/"case-source.json",{"id":case["id"],"case":case,"manifestSha256":hashlib.sha256(a.manifest.read_bytes()).hexdigest(),
        "pid":os.getpid(),"createdAt":time.time(),"sourceHashes":{str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest()
            for folder in (HERE,CENTER) for path in folder.iterdir() if path.is_file() and path.suffix in {".py",".mjs",".js",".json"}},
        "unknownPolicy":manifest["policy"]["unknownUsage"]})
    web.run_app(app,host="127.0.0.1",port=a.port,print=lambda *args:None)

if __name__=="__main__": main()
