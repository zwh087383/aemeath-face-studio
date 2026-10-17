// Local PMX before/after visual evidence. No cloud, microphone or audio calls.
// node realtime/browser-body-elbows.cjs baseline|current [comma-separated IDs]
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
let playwright;
try {playwright=require('playwright');} catch {playwright=require(path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));}
const root=path.resolve(__dirname,'..'),version=process.argv[2]||'current';
if(!['baseline','current'].includes(version)) throw new Error('baseline or current required');
const out=path.join(root,'outputs/body-elbows-20261016'),ids=(process.argv[3]||'explain,wave,shrug,chest,shy,think,comfort,greet,bow_smile,laugh,curious,explain_firm,surprise,listen,look_up,agree').split(',');
const core=['motion-controller.js','motion-profile.js','motion-skeleton.js','motion-math.js'];
const sourceFiles=[...core.map(f=>'preview/core/'+f),'preview/studio/motion-rig.js','realtime/qwen/scene.mjs','realtime/performance/director.mjs','realtime/performance/viewer.mjs'];
const hashes=()=>Object.fromEntries(sourceFiles.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(version==='baseline'&&core.includes(path.basename(f))?path.join(out,'baseline',path.basename(f)):path.join(root,f))).digest('hex')]));
const report={version,generatedAt:new Date().toISOString(),sourceHashes:hashes(),actions:[],errors:[],boundary:'Actual local PMX render. Baseline four motion modules are routed from git 63199b1; scene, face, camera and model identical. No cloud/audio/microphone. Natural noise disabled to isolate authored body response; physics disabled.'};
(async()=>{
  fs.mkdirSync(out,{recursive:true});let browser;
  try{
    browser=await playwright.chromium.launch({channel:'chrome',headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='127.0.0.1')return route.abort();
      const file=url.pathname.startsWith('/preview/core/')?path.basename(url.pathname):'';
      if(version==='baseline'&&core.includes(file))return route.fulfill({contentType:'text/javascript; charset=utf-8',body:fs.readFileSync(path.join(out,'baseline',file),'utf8')});
      return route.continue();
    });
    const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
    await page.goto('http://127.0.0.1:18768/performance/');
    await page.waitForFunction(()=>window.performanceLab?.ready,null,{timeout:30000});
    await page.evaluate(()=>{const l=window.performanceLab;l.stop();l.setOptions({natural:false,speech:false,expression:true,speed:1,intensity:1});});
    await page.waitForFunction(()=>!window.performanceLab.snapshot().motion.gestures.length);
    for(const id of ids){
      const action=await page.evaluate(async id=>{
        const l=window.performanceLab,frame=()=>new Promise(requestAnimationFrame),{GESTURES}=await import('/preview/core/motion-profile.js');
        const samples=[],before=l.snapshot().rendered,deadline=performance.now()+12000;
        while(l.director.now-(l.motion.lastStart.get(id)??-100)<GESTURES[id].cooldown)await frame();
        if(!l.play(id))throw new Error('Rejected '+id);
        while(performance.now()<deadline){
          await frame();const s=l.snapshot(),g=s.motion.gestures.find(g=>g.gesture===id&&!g.recovering);
          samples.push({time:l.director.now,phase:g?.phase,age:g?.age,bones:s.rendered.bones,rotations:s.rendered.rotations});
          if(g?.age>=GESTURES[id].apex+.1){l.pause();window.__bodyTrace=samples;return{id,before,pose:s.rendered,phase:g.phase,age:g.age};}
        }
        throw new Error('Missing apex '+id);
      },id);
      for(const view of ['body','angle']){
        await page.evaluate(view=>window.performanceLab.setView(view),view);
        await page.waitForFunction(view=>window.performanceLab.snapshot().rendered.view===view,view);
        await page.locator('#stage').screenshot({path:path.join(out,`${version}-${id}-${view}.png`)});
      }
      const rest=await page.evaluate(async()=>{
        const l=window.performanceLab,frame=()=>new Promise(requestAnimationFrame);l.pause();
        const deadline=performance.now()+16000;let finite=true;
        while(performance.now()<deadline){await frame();const s=l.snapshot(),g=s.motion.gestures.find(g=>!g.recovering);finite&&=s.rendered.finite;
          window.__bodyTrace.push({time:l.director.now,phase:g?.phase,age:g?.age,bones:s.rendered.bones,rotations:s.rendered.rotations});
          if(!s.motion.gestures.length)return{finite,completed:true,samples:window.__bodyTrace};}
        return{finite,completed:false,samples:window.__bodyTrace};
      });
      if(!rest.completed||!rest.finite)throw new Error('Incomplete/invalid '+id);
      report.actions.push({...action,...rest});console.log(`[${version}] ${id}: ${rest.samples.length} frames; real apex captured`);
    }
    report.passed=report.errors.length===0;
    if(!report.passed)process.exitCode=1;
  }catch(e){report.passed=false;report.failure=String(e.stack||e);process.exitCode=1;console.error(report.failure);}
  finally{const after=hashes();report.sourceChangedDuringRun=sourceFiles.filter(f=>after[f]!==report.sourceHashes[f]);if(report.sourceChangedDuringRun.length){report.passed=false;process.exitCode=1;}fs.writeFileSync(path.join(out,`${version}-browser.json`),JSON.stringify(report,null,2));if(browser)await browser.close();}
})();
