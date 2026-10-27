"""Serial browser campaign. Resume skips every attempted case; never replays billing."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import psutil

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]

def save(path,value):
    path=Path(path);temp=path.with_suffix(path.suffix+".tmp")
    temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding="utf-8")
    for attempt in range(8):
        try:temp.replace(path);return
        except PermissionError:
            if attempt==7:raise
            time.sleep(.025*(attempt+1))

def read(path,default=None):
    try: return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError,ValueError): return default

def http(url):
    with urllib.request.urlopen(url,timeout=4) as r: return json.loads(r.read())

def environment():
    result={"at":time.time(),"cpuPercent":psutil.cpu_percent(interval=.1),"availableMemory":psutil.virtual_memory().available}
    try: result["gpu"]=subprocess.check_output(["nvidia-smi","--query-gpu=utilization.gpu,memory.used,memory.total","--format=csv,noheader"],text=True,timeout=5).strip()
    except Exception: result["gpu"]="unavailable"
    return result

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ("output","data-root","env-file","wai-root"): p.add_argument("--"+name,type=Path,required=True)
    p.add_argument("--port",type=int,default=18818)
    p.add_argument("--asset-port",type=int,default=18809)
    p.add_argument("--local-proxy",action="store_true")
    p.add_argument("--only",default="")
    p.add_argument("--prior-output",type=Path)
    a=p.parse_args();out=a.output.resolve();out.mkdir(parents=True,exist_ok=True)
    from manifest import write,validate
    digest=write(out/"manifest.json");data=read(out/"manifest.json");validate(data)
    path=out/"campaign-state.json"
    state=read(path,{"startedAt":time.time(),"manifestSha256":digest,"cases":{},"policy":data["policy"]})
    if state["manifestSha256"]!=digest: raise ValueError("changed_campaign_manifest")
    cli=shutil.which("playwright-cli.cmd")
    if not cli: raise RuntimeError("playwright_cli_unavailable")
    def browser(*args,timeout=100):
        # cmd shim contains no user text or secrets; paths are separately quoted by subprocess.
        return subprocess.run([cli,"-s=character-campaign",*args],cwd=ROOT,capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=timeout)
    url=f"http://127.0.0.1:{a.port}"
    try: http(url+"/api/duplex/status")
    except Exception: pass
    else: raise RuntimeError("campaign_port_already_occupied")
    pending=[s for s in data["scenarios"] if s["id"] not in state["cases"] and (not a.only or s["id"] in a.only.split(','))]
    for case in pending:
        charged={key:0 for key in data['totals']['limits']};pcm_charged=0
        for evidence_root in (out,a.prior_output):
            if evidence_root is None:continue
            for ledger_path in evidence_root.glob('**/ledger.json'):
                old=read(ledger_path,{});pcm_charged+=old.get('pcmBytes',0)/32000
                for row in old.get('responses',[]):
                    if row.get('state')!='unused':charged[row['channel']]+=1
        if pcm_charged+case['pcmSeconds']>data['totals']['pcmSeconds'] or any(charged[k]+case['limits'][k]>data['totals']['limits'][k] for k in charged):
            state['stopped']='aggregate_channel_capacity_with_prior_evidence';save(path,state);break
        identity=case["id"];caseout=out/"cases"/identity;caseout.mkdir(parents=True,exist_ok=True)
        if not(caseout/"inputs/input-fixtures.json").exists(): raise RuntimeError("input_fixtures_missing")
        if(caseout/"ledger.json").exists(): raise RuntimeError("unregistered_existing_case_ledger")
        state["current"]=identity;state["cases"][identity]={"status":"attempted","startedAt":time.time(),"environment":environment()};save(path,state)
        cmd=[sys.executable,"-u",str(HERE/"server.py"),"--manifest",str(out/"manifest.json"),"--case",identity,"--output",str(caseout),
             "--data-dir",str(a.data_root/identity),"--env-file",str(a.env_file),"--wai-root",str(a.wai_root),"--port",str(a.port),"--asset-port",str(a.asset_port)]
        if a.local_proxy: cmd.append("--local-proxy")
        env={**os.environ,"PYTHONIOENCODING":"utf-8"}
        stdout=(caseout/"server-stdout.log").open("w",encoding="utf-8");stderr=(caseout/"server-stderr.log").open("w",encoding="utf-8")
        process=subprocess.Popen(cmd,cwd=ROOT,env=env,stdout=stdout,stderr=stderr,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        state["cases"][identity]["pid"]=process.pid;save(path,state)
        print(json.dumps({"case":identity,"event":"started","completed":len(state["cases"])-1},ensure_ascii=False),flush=True)
        try:
            deadline=time.monotonic()+100
            while time.monotonic()<deadline:
                if process.poll() is not None: raise RuntimeError("server_startup_exit")
                try:
                    health=http(url+"/api/duplex/status")
                    if health.get("cloudEnabled"):
                        if http(url+'/api/campaign/case').get('id')!=identity:raise RuntimeError('wrong_case_owns_port')
                        break
                except Exception: pass
                time.sleep(.4)
            else: raise TimeoutError("server_health_deadline")
            browser('close',timeout=30)
            nav=browser("open",url+"/character-center/?campaign="+identity,"--headed")
            (caseout/"browser-navigation.txt").write_text(nav.stdout+nav.stderr,encoding="utf-8")
            if nav.returncode: raise RuntimeError("browser_navigation_failed")
            run=browser("run-code","--filename="+str(HERE/"run-browser.js"))
            (caseout/"browser-start.txt").write_text(run.stdout+run.stderr,encoding="utf-8")
            if run.returncode or "### Error" in run.stdout: raise RuntimeError("browser_runner_start_failed")
            deadline=time.monotonic()+sum(case["gapsSeconds"])+130*len(case["turns"])+180
            last_phase=None
            while time.monotonic()<deadline:
                progress=read(caseout/"progress.json",{})
                if progress.get("phase")!=last_phase:
                    last_phase=progress.get("phase");print(json.dumps({"case":identity,"phase":last_phase},ensure_ascii=False),flush=True)
                if progress.get("phase")=="finished": break
                if process.poll() is not None: raise RuntimeError("server_exited_during_case")
                if progress and time.time()-progress.get("serverReceivedAt",0)>130: raise TimeoutError("browser_progress_stalled")
                time.sleep(2)
            else: raise TimeoutError("scenario_deadline")
            state["cases"][identity].update(status="finished",progress=progress,endedAt=time.time())
            # One real frame for every scenario, original-speed video retained separately.
            shot=browser("screenshot","--filename="+str(caseout/"preview-final.png"),timeout=30)
            if shot.returncode: state["cases"][identity]["screenshotError"]=True
        except Exception as exc:
            state["cases"][identity].update(status="infrastructure_failed",error=type(exc).__name__+":"+str(exc),endedAt=time.time())
            try: browser("run-code","async page => await page.evaluate(async()=>{await window.characterCenter?.save();await window.characterCenter?.close();})",timeout=40)
            except Exception: pass
        finally:
            # Drain usage before killing this owned server. Unknown remains charged.
            until=time.monotonic()+45
            while time.monotonic()<until:
                ledger=read(caseout/"ledger.json",{})
                if not any(r.get("state") in {"reserved","active"} for r in ledger.get("responses",[])): break
                time.sleep(1)
            try: save(caseout/"final-server-status.json",http(url+"/api/duplex/status"))
            except Exception: pass
            if process.poll() is None:
                # Windows venv launchers may own a second Python process. Stop
                # this exact descendant tree, not unrelated runtime services.
                try:children=psutil.Process(process.pid).children(recursive=True)
                except psutil.NoSuchProcess:children=[]
                for child in reversed(children):
                    try:child.terminate()
                    except psutil.NoSuchProcess:pass
                psutil.wait_procs(children,timeout=5)
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill();process.wait(timeout=5)
            stdout.close();stderr.close()
            state["cases"][identity]["endingEnvironment"]=environment()
            state["cases"][identity]["ledgerSha256"]=hashlib.sha256((caseout/"ledger.json").read_bytes()).hexdigest() if(caseout/"ledger.json").exists() else None
            save(path,state)
        print(json.dumps({"case":identity,"event":"finished","status":state["cases"][identity]["status"],"completed":len(state["cases"])},ensure_ascii=False),flush=True)
        if state['cases'][identity]['status']=='infrastructure_failed':
            state['stopped']='infrastructure_fault_requires_inspection';save(path,state);break
    state["current"]=None;state["endedAt"]=time.time();save(path,state)

if __name__=="__main__": main()
