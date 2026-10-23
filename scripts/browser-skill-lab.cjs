const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {chromium} = require(path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'outputs/architecture-skill-20261022/browser');
const url = process.env.SKILL_LAB_URL || 'http://127.0.0.1:18793/skill-lab/';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(out, {recursive:true});
const result = {schema:1, url, startedAt:new Date().toISOString(), checks:[], errors:[], console:[], failedRequests:[]};
const sourceFiles=['preview/core/skill-reaction.js','realtime/skill-lab/viewer.mjs','realtime/skill-lab/server.mjs','realtime/skill-lab/index.html','preview/core/native-motion.js','preview/core/native-cloth-binding.js','preview/core/native-resource-layer.js','preview/core/motion-profile.js','preview/core/motion-skeleton.js'];
const hashes=()=>Object.fromEntries(sourceFiles.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
result.sourceBefore=hashes();
const save = () => fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify(result,null,2));
const check = (name,data={}) => {result.checks.push({name,passed:true,...data});save();console.log('PASS '+name);};
(async()=>{
  const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  const page = await browser.newPage({viewport:{width:1520,height:1080}});
  page.on('pageerror',e=>{result.errors.push(e.message);save();console.log('PAGEERROR '+e.message);});
  page.on('console',e=>{if(['error','warning'].includes(e.type())){result.console.push(e.text());save();}});
  page.on('requestfailed',r=>{result.failedRequests.push({url:r.url(),error:r.failure()});save();});
  try{
    console.log('Browser launched; loading model and shader readiness.');
    await page.goto(url,{waitUntil:'commit'});
    let state;const begin=Date.now();
    while(Date.now()-begin<240000){
      state=await page.evaluate(()=>({api:!!window.skillLab,s:window.skillLab?.snapshot(),status:document.getElementById('status')?.textContent}));
      if(state.s?.error)throw Error(state.s.error);
      if(result.errors.length)throw Error(result.errors.join('\n'));
      if(state.s?.ready)break;
      if(Math.floor((Date.now()-begin)/1000)%20===0)console.log('LOAD '+JSON.stringify({elapsed:Date.now()-begin,api:state.api,status:state.status,stage:state.s?.loadDiagnostics?.stage}));
      await delay(1000);
    }
    assert.ok(state.s?.ready,'Actual PMX renderer did not become ready: '+JSON.stringify(state));
    result.initial=state.s;check('real PMX, native Stand2 and exact Ribbon loaded',{loadMs:Date.now()-begin,environment:state.s.environment});
    await page.evaluate(()=>window.skillLab.pause(true));
    // Controls must alter the real displayed rig at identical native timestamps.
    const comparisons=[];
    for(const t of [.32,.9,1.8,2.9,3.45,4.5]){
      comparisons.push(await page.evaluate(t=>{
        const lab=window.skillLab;lab.seek(t);lab.setEnabled(false);const off=lab.boneSample();lab.setEnabled(true);const on=lab.boneSample();
        const changed={};for(const name of ['上半身','上半身1','上半身2','首','頭','右腕','右ひじ','右手首'])if(off[name]&&on[name]){
          const dot=Math.abs(off[name].q.reduce((s,x,i)=>s+x*on[name].q[i],0));changed[name]=2*Math.acos(Math.min(1,dot));
        }
        const protectedNames=['左腕','左ひじ','左手首','右足','左足','右ひざ','左ひざ','右足首','左足首'];
        let protectedMax=0;for(const name of protectedNames)if(off[name]&&on[name])for(const k of ['p','q','s'])off[name][k].forEach((x,i)=>{protectedMax=Math.max(protectedMax,Math.abs(x-on[name][k][i]));});
        const finite=Object.values(on).every(b=>[...b.p,...b.q,...b.s,...b.world].every(Number.isFinite));
        return {t,changed,protectedMax,finite,state:lab.snapshot()};
      },t));
    }
    assert.ok(comparisons.every(c=>c.finite&&c.protectedMax<1e-7));
    assert.ok(comparisons.some(c=>c.changed['上半身']>.01&&c.changed['右腕']>.01));
    result.poseComparisons=comparisons;check('body and right arm participate while protected limbs remain unchanged');
    // Repeated seeks cannot leave authored helpers active after return or layer-off.
    const drift=await page.evaluate(()=>{
      const l=window.skillLab;l.seek(0);l.setEnabled(false);const initial=l.boneSample();
      l.setEnabled(true);for(let i=0;i<5;i++){l.seek(1.8);l.seek(2.95);l.seek(4.5);l.seek(0);}l.setEnabled(false);const final=l.boneSample();
      let max=0,name='';for(const [n,b]of Object.entries(initial))for(const k of ['p','q','s'])b[k].forEach((v,i)=>{const d=Math.abs(v-final[n][k][i]);if(d>max){max=d;name=n;}});
      l.setEnabled(true);return {max,name};
    });
    result.drift=drift;assert.ok(drift.max<1e-6,'Repeated review leaves drift: '+JSON.stringify(drift));check('repeated playback and layer switch leave no rig drift',drift);
    const speech=await page.evaluate(()=>{const l=window.skillLab;l.setSpeech(.32);const out=[];for(const t of [0,.8,1.8,2.95,3.4,4.5]){l.seek(t);out.push({t,value:l.snapshot().speechA,face:l.snapshot().faceResult});}l.setSpeech(0);return out;});
    assert.ok(speech.every(s=>Math.abs(s.value-.32)<1e-8));result.speech=speech;check('authored expression preserves held speech vowel through all phases');
    const phaseResults=[];
    for(const t of [.1,.65,1.8,2.9,3.55]){
      phaseResults.push(await page.evaluate(t=>{
        const l=window.skillLab;l.pause(true);l.seek(t);const before=l.controller.snapshot(),old=l.controller.command({understood:true});
        const receipt=l.interrupt().receipt,after=l.controller.snapshot(),stale=l.confirm(old).receipt;
        let poseJump=0;for(const k in before.pose)poseJump=Math.max(poseJump,Math.abs(before.pose[k]-after.pose[k]));
        l.controller.pause(false);l.controller.advance(1);l.setEnabled(true);const end=l.snapshot();
        return {t,receipt,stale,poseJump,endPhase:end.controller.phase,remaining:Math.max(...Object.values(end.controller.pose).map(Math.abs))};
      },t));
    }
    assert.ok(phaseResults.every(r=>r.receipt.ok&&!r.stale.ok&&r.poseJump<1e-8&&r.endPhase==='idle'&&r.remaining<1e-8));
    result.interruptions=phaseResults;check('five-stage cancellation preserves current pose, rejects old confirmation and returns to idle');
    const manual=await page.evaluate(()=>{
      const l=window.skillLab;l.manual();l.pause(true);l.controller.pause(false);l.controller.advance(.4);l.correction();l.controller.advance(3);
      const wait=l.snapshot();const rejected=l.confirm(l.controller.command({understood:false})).receipt;
      const stillSpeaking=l.confirm(l.controller.command({understood:true,speakerCompleted:false,partnerVoicing:true})).receipt;
      const wrongCancel=l.interrupt(l.controller.command({sessionId:'different-session'})).receipt;
      l.controller.advance(1);const still=l.snapshot();const accepted=l.confirm().receipt;l.controller.advance(2);l.pause(true);
      return {wait:wait.controller.phase,rejected,stillSpeaking,wrongCancel,still:still.controller.phase,accepted,end:l.snapshot().controller.phase};
    });
    assert.equal(manual.wait,'wait');assert.equal(manual.still,'wait');assert.ok(!manual.rejected.ok&&!manual.stillSpeaking.ok&&!manual.wrongCancel.ok&&manual.accepted.ok);assert.equal(manual.end,'idle');
    check('waiting never acknowledges before explicit understood completion',manual);
    await page.evaluate(()=>{const l=window.skillLab;l.seek(1.8);l.pause(true);});
    const pause0=await page.evaluate(()=>window.skillLab.snapshot());await delay(350);const pause1=await page.evaluate(()=>window.skillLab.snapshot());assert.equal(pause0.time,pause1.time);check('global review pause freezes the review timeline');
    for(const [view,t]of [['front',1.8],['side',1.8],['angle',.6],['face',1.8],['face',2.98]]){
      await page.evaluate(({view,t})=>{window.skillLab.seek(t);window.skillLab.setView(view);},{view,t});
      await page.screenshot({path:path.join(out,`${view}-${String(t).replace('.','-')}.png`),fullPage:true});
    }
    check('front, side, angle and facial closeups captured');
    await page.evaluate(()=>{window.skillLab.setView('front');window.skillLab.restart();});await delay(4600);
    result.final=await page.evaluate(()=>window.skillLab.snapshot());
    assert.equal(result.final.controller.phase,'idle');
    check('real RAF playback reaches final recovery',{phase:result.final.controller.phase,time:result.final.time,performance:result.final.performance});
    const recording=await page.evaluate(async()=>{
      const l=window.skillLab;l.setView('angle');l.restart();
      const stream=l.renderer.domElement.captureStream(30),chunks=[];
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:3500000});
      const completed=new Promise(resolve=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onstop=async()=>{
        const blob=new Blob(chunks,{type:'video/webm'}),buffer=await blob.arrayBuffer();let binary='';const a=new Uint8Array(buffer);for(let i=0;i<a.length;i+=8192)binary+=String.fromCharCode(...a.subarray(i,i+8192));resolve(btoa(binary));
      };});recorder.start();await new Promise(r=>setTimeout(r,5200));recorder.stop();const data=await completed;stream.getTracks().forEach(t=>t.stop());return data;
    });
    fs.writeFileSync(path.join(out,'repair-wait-ack.webm'),Buffer.from(recording,'base64'));check('actual canvas motion recording saved');
    result.sourceAfter=hashes();assert.deepEqual(result.sourceAfter,result.sourceBefore);check('tested source hashes unchanged');
    assert.equal(result.errors.length,0);result.passed=true;
  }catch(e){result.passed=false;result.failure=e.stack;console.error(e.stack);process.exitCode=1;}
  finally{result.finishedAt=new Date().toISOString();save();await browser.close();}
})();
