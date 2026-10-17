// Actual PMX wave/recovery diagnostics, with no microphone, cloud or audio.
// node realtime/browser-wave-acceptance.cjs [output-directory]
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
let playwright;
try { playwright=require('playwright'); }
catch { playwright=require(path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright')); }
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'outputs/crisp-wave-20261016/browser');
const files=['preview/core/motion-controller.js','preview/core/motion-skeleton.js','preview/core/motion-profile.js','preview/studio/motion-rig.js','realtime/qwen/scene.mjs','realtime/performance/director.mjs','realtime/performance/viewer.mjs'];
const hashes=()=>Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
const result={boundary:'Actual PMX browser render. Silent local actions; no cloud/audio. Video capture and other previews affect FPS, so this is not a performance benchmark. Mesh contact validation is separate.',sourceHashes:hashes(),actions:[],interruptions:[],errors:[]};
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const sleeveNames=Array.from({length:5},(_,i)=>[`leftSleeveRoot${i}`,`leftSleeveTip${i}`]).flat();
(async()=>{
 fs.mkdirSync(out,{recursive:true});let browser;
 try {
  browser=await playwright.chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1,recordVideo:{dir:path.join(out,'video'),size:{width:1280,height:900}}});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));
  await page.goto('http://127.0.0.1:18768/performance/');
  await page.waitForFunction(()=>window.performanceLab?.ready,null,{timeout:60000});
  await page.evaluate(()=>{const l=window.performanceLab;l.stop();l.setOptions({natural:false,expression:true,speech:false,speed:1,intensity:1});l.setView('angle');});
  await page.waitForFunction(()=>!window.performanceLab.snapshot().motion.gestures.length);
  for(const id of ['wave','greet']) {
   await page.evaluate(async id=>{
    const l=window.performanceLab,{GESTURES}=await import('/preview/core/motion-profile.js');
    while(l.director.now-(l.motion.lastStart.get(id)??-100)<GESTURES[id].cooldown)await new Promise(requestAnimationFrame);
    const r=window.__waveRun={id,before:l.snapshot().rendered,samples:[],done:false};
    if(!l.play(id))throw new Error('rejected '+id);
    let seen=false;const start=performance.now();
    function sample(){const s=l.snapshot(),g=s.motion.gestures.find(g=>g.gesture===id&&!g.recovering);seen||=!!g;
     r.samples.push({wallMs:performance.now()-start,age:g?.age,phase:g?.phase,rendered:s.rendered});
     if(seen&&!s.motion.gestures.length){r.done=true;return;}
     if(performance.now()-start>12000){r.error='timeout';r.done=true;return;}requestAnimationFrame(sample);}
    requestAnimationFrame(sample);
   },id);
   await page.waitForFunction(()=>window.__waveRun.samples.some(s=>s.phase==='stroke'));
   await page.screenshot({path:path.join(out,`${id}-stroke.png`)});
   await page.waitForFunction(()=>window.__waveRun.samples.some(s=>s.phase==='recover'));
   await page.evaluate(()=>window.performanceLab.setView('side'));
   await page.screenshot({path:path.join(out,`${id}-recover-side.png`)});
   await page.waitForFunction(()=>window.__waveRun.done,null,{timeout:15000});
   const trace=await page.evaluate(()=>window.__waveRun);
   const angle=(a,b)=>2*Math.acos(Math.min(1,Math.abs(a.reduce((s,v,i)=>s+v*b[i],0))))*180/Math.PI;
   const peakChest=Math.max(...trace.samples.map(s=>angle(s.rendered.rotations.upperChest,trace.before.rotations.upperChest)));
   assert(!trace.error&&trace.samples.every(s=>s.rendered.finite),'invalid trace '+id);
   assert(peakChest>=(id==='wave'?9.5:10.8),'body amplitude dropped '+id+': '+peakChest);
   assert(trace.samples.every(s=>sleeveNames.every(k=>s.rendered.bones[k]?.every(Number.isFinite))),'missing sleeve bone application');
   fs.writeFileSync(path.join(out,`${id}-trajectory.json`),JSON.stringify(trace));
   result.actions.push({id,frames:trace.samples.length,elapsedMs:trace.samples.at(-1).wallMs,peakChestDegrees:peakChest,phases:[...new Set(trace.samples.map(s=>s.phase).filter(Boolean))]});
   console.log(`[wave browser] ${id}: complete, chest ${peakChest.toFixed(2)}deg`);
   await page.evaluate(()=>window.performanceLab.setView('angle'));
  }
  for(const id of ['wave','greet'])for(const phase of ['prepare','stroke','hold','recover']) {
   const data=await page.evaluate(async({id,phase})=>{
    const l=window.performanceLab,frame=()=>new Promise(requestAnimationFrame),{GESTURES}=await import('/preview/core/motion-profile.js');
    while(l.director.now-(l.motion.lastStart.get(id)??-100)<GESTURES[id].cooldown)await frame();
    if(!l.play(id))throw new Error('rejected '+id);
    const target=GESTURES[id].phases[phase],age=(target[0]+target[1])/2;
    while(!l.snapshot().motion.gestures.some(g=>g.gesture===id&&g.age>=age))await frame();
    const before=l.snapshot();l.stop();let finite=true,frames=0,maxSleeveStep=0,prev=before.rendered,start=performance.now();
    while(performance.now()-start<4000){await frame();frames++;const s=l.snapshot();finite&&=s.rendered.finite;
     for(let i=0;i<5;i++){const k=`leftSleeveTip${i}`;maxSleeveStep=Math.max(maxSleeveStep,Math.hypot(...s.rendered.bones[k].map((v,j)=>v-prev.bones[k][j])));}
     prev=s.rendered;if(!s.motion.gestures.length)return{id,phase,at:before.motion.gestures[0]?.age,finite,frames,maxSleeveStep,finishedMs:performance.now()-start,completed:true};}
    return{id,phase,finite,frames,maxSleeveStep,completed:false};
   },{id,phase});
   assert(data.finite&&data.completed&&data.finishedMs<2500,`cancel failure ${id}/${phase}`);
   result.interruptions.push(data);console.log(`[wave browser] ${id}/${phase}: cancelled in ${Math.round(data.finishedMs)}ms`);
  }
  await page.evaluate(()=>{const l=window.performanceLab;l.setOptions({natural:true});l.playStory('wave_review');l.setView('angle');});
  await page.waitForFunction(()=>window.performanceLab.snapshot().motion.gestures.some(g=>g.phase==='stroke'));
  await page.screenshot({path:path.join(out,'preview.png')});
  result.passed=result.errors.length===0;
  await context.close();const videos=fs.readdirSync(path.join(out,'video')).filter(f=>f.endsWith('.webm'));result.videoFiles=videos;
 }catch(e){result.passed=false;result.failure=String(e.stack||e);process.exitCode=1;console.error(result.failure);}
 finally{const end=hashes();result.sourceChangedDuringRun=files.filter(f=>end[f]!==result.sourceHashes[f]);if(result.sourceChangedDuringRun.length)result.passed=false;if(!result.passed)process.exitCode=1;fs.writeFileSync(path.join(out,'browser-wave-acceptance.json'),JSON.stringify(result,null,2));if(browser)await browser.close();}
})();
