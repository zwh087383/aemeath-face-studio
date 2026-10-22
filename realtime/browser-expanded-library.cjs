// Actual PMX/browser acceptance for the expanded local library. No cloud calls.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));}
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[3]||path.join(root,'outputs/expanded-library-20261022'));
const url=process.argv[2]||'http://127.0.0.1:18788/performance/library/';fs.mkdirSync(out,{recursive:true});
const files=['preview/core/motion-profile.js','preview/core/expanded-motion-library.js','preview/core/profile.js','preview/core/expanded-expression-library.js','preview/core/controller.js','preview/core/motion-controller.js','preview/core/motion-skeleton.js','preview/core/motion-math.js','preview/core/continuity-math.js','preview/core/expression-choreography.js','preview/studio/motion-rig.js','realtime/qwen/scene.mjs','realtime/performance/director.mjs','realtime/performance/expanded-sequences.mjs','realtime/performance/library/viewer.mjs','realtime/performance/library/index.html','realtime/performance/library/style.css','realtime/avatar/controller-bridge.mjs','realtime/browser-expanded-library.cjs'];
const hashes=()=>Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
const report={experimental:true,started:new Date().toISOString(),checks:[],errors:[],sourceBefore:hashes(),acousticVerified:false};
const check=(name,ok,data={})=>{report.checks.push({name,passed:!!ok,...data});if(!ok)throw Error(name);};
(async()=>{
  const browser=await playwright.chromium.launch({channel:process.env.LIBRARY_BROWSER_CHANNEL||'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1080}});
    page.on('pageerror',e=>report.errors.push(e.message));
    page.on('console',e=>{if(e.type()==='error')report.errors.push(e.text());});
    await page.goto(url);await page.waitForFunction(()=>window.motionLibrary?.ready||window.motionLibrary?.snapshot().error,null,{timeout:60000});
    await page.waitForFunction(()=>window.motionLibrary?.snapshot().rendered?.frame>5,null,{timeout:20000});
    const snapshot=()=>page.evaluate(()=>window.motionLibrary.snapshot());
    let s=await snapshot();report.environment=s.environment;
    check('real_model_loaded',s.ready&&!s.error&&s.rendered.finite&&!s.rendered.missingBindings.length,{counts:s.counts});
    check('catalog_expanded',s.counts.body>=50&&s.counts.faces===40&&s.counts.micro===17&&s.counts.stories>=23);
    const ids=await page.evaluate(()=>{const a=window.motionLibrary.catalog.body.filter(x=>x.fresh);return [...new Set(['wave','greet',...['micro','conversation','emotion'].map(c=>a.find(x=>x.category===c)?.id),...a.filter(x=>x.category==='large').map(x=>x.id),'grateful','clarify'])].filter(Boolean);});
    for(const id of ids){
      await page.evaluate(()=>{const l=window.motionLibrary;l.stop();l.setOptions({natural:false,expression:true});});
      await page.waitForFunction(()=>!window.motionLibrary.snapshot().motion.gestures.length,null,{timeout:6000});
      check(`start_${id}`,await page.evaluate(id=>window.motionLibrary.choose('body',id),id));
      await page.waitForFunction(id=>window.motionLibrary.snapshot().motion.gestures.some(g=>g.gesture===id&&['stroke','hold'].includes(g.phase)),id,{timeout:12000});
      const samples=await page.evaluate(async()=>{const l=window.motionLibrary,start=performance.now(),initial=l.snapshot().rendered,ranges={head:0,chest:0,leftWrist:0,rightWrist:0};let finite=true,frames=0,maxStep=0,previous=initial.bones;while(performance.now()-start<1000){await new Promise(requestAnimationFrame);const r=l.snapshot().rendered;finite&&=r.finite;for(const k of ['leftWrist','rightWrist'])maxStep=Math.max(maxStep,Math.hypot(...r.bones[k].map((v,i)=>v-previous[k][i])));for(const k of Object.keys(ranges))ranges[k]=Math.max(ranges[k],Math.hypot(...r.bones[k].map((v,i)=>v-initial.bones[k][i])));previous=r.bones;frames++;}return{finite,frames,renderedFrames:l.snapshot().rendered.frame-initial.frame,ranges,maxWristStep:maxStep,...l.snapshot().performance};});
      check(`actual_pose_${id}`,samples.finite&&samples.renderedFrames>12&&samples.maxWristStep<1.2&&Math.max(...Object.values(samples.ranges))>.001,samples);
      if(!['wave','micro_ack'].includes(id)){await page.evaluate(()=>window.motionLibrary.setView('angle'));await page.screenshot({path:path.join(out,`${id}-angle.png`)});await page.evaluate(()=>window.motionLibrary.setView('body'));}
    }
    await page.evaluate(()=>window.motionLibrary.stop());await page.waitForFunction(()=>!window.motionLibrary.snapshot().motion.gestures.length,null,{timeout:6000});
    check('head_action_start',await page.evaluate(()=>window.motionLibrary.choose('micro','double_nod')));
    const headAction=await page.evaluate(async()=>{const l=window.motionLibrary,initial=l.snapshot().rendered.rotations.head,start=performance.now();let change=0;while(performance.now()-start<1600){await new Promise(requestAnimationFrame);const q=l.snapshot().rendered.rotations.head;change=Math.max(change,Math.hypot(...q.map((v,i)=>v-initial[i])));}return change;});
    check('head_action_visible',headAction>.005,{quaternionChange:headAction});
    await page.evaluate(()=>{window.motionLibrary.stop();window.motionLibrary.selectTab('faces');window.motionLibrary.setView('face');});
    await page.waitForFunction(()=>!window.motionLibrary.snapshot().motion.gestures.length,null,{timeout:6000});
    const faceBefore=(await snapshot()).rendered.weights;
    check('face_preset',await page.evaluate(()=>window.motionLibrary.choose('faces','skeptical')));
    await page.waitForTimeout(650);await page.screenshot({path:path.join(out,'skeptical-face.png')});
    const faceChannels=await page.evaluate(async before=>{const {C}=await import('/preview/core/profile.js'),w=window.motionLibrary.snapshot().rendered.weights;return Object.fromEntries(['browAsym','eyeHalf'].map(k=>[k,{value:w[C[k]],change:w[C[k]]-before[C[k]]}]));},faceBefore);
    check('face_visible',Object.values(faceChannels).every(v=>v.value>.1&&v.change>.08),{channels:faceChannels});
    await page.evaluate(()=>{window.motionLibrary.setOptions({mouth:true});});
    await page.waitForFunction(()=>window.motionLibrary.snapshot().rendered.mouthOpen>.2);
    await page.evaluate(()=>window.motionLibrary.pause());await page.waitForTimeout(150);
    check('paused_test_mouth_closed',(await snapshot()).rendered.mouthOpen<1e-6);
    await page.evaluate(()=>window.motionLibrary.pause());await page.waitForFunction(()=>window.motionLibrary.snapshot().rendered.mouthOpen>.2);
    await page.evaluate(()=>window.motionLibrary.stop());await page.waitForTimeout(150);
    check('interrupted_test_mouth_closed',(await snapshot()).rendered.mouthOpen<1e-6);
    await page.evaluate(()=>{window.motionLibrary.setView('body');window.motionLibrary.selectTab('stories');window.motionLibrary.setOptions({natural:true});});
    check('continuous_scene_start',await page.evaluate(()=>window.motionLibrary.choose('stories','first_meeting')));
    await page.waitForTimeout(220);
    check('first_step_label',await page.locator('#sequence-step').textContent().then(t=>t.includes('第 1 /')));
    await page.evaluate(()=>window.motionLibrary.startRecording());
    await page.waitForFunction(()=>window.motionLibrary.snapshot().director.sequence?.step>=3,null,{timeout:50000});
    const before=await snapshot();await page.evaluate(()=>window.motionLibrary.pause());
    await page.waitForTimeout(100);const frozen=await snapshot();await page.waitForTimeout(450);const after=await snapshot();
    check('pause_freezes_sequence_and_pose',after.director.time===frozen.director.time&&JSON.stringify(after.rendered.bones)===JSON.stringify(frozen.rendered.bones),{step:before.director.sequence.step});
    await page.evaluate(()=>window.motionLibrary.pause());await page.waitForTimeout(1000);
    await page.evaluate(()=>window.motionLibrary.stop());
    await page.waitForFunction(()=>!window.motionLibrary.snapshot().motion.gestures.length,null,{timeout:6000});
    await page.waitForTimeout(1000);s=await snapshot();
    check('interrupt_retires_sequence',!s.director.story&&!s.director.sequence&&!s.motion.gestures.length&&s.rendered.mouthOpen<.001,{snapshot:s.director});
    const bytes=await page.evaluate(()=>window.motionLibrary.stopRecording());check('recorded_local_preview',bytes>10000,{bytes});
    const dl=page.waitForEvent('download');await page.evaluate(()=>window.motionLibrary.downloadRecording());await(await dl).saveAs(path.join(out,'expanded-library.webm'));
    await page.evaluate(()=>{window.motionLibrary.selectTab('body');});
    await page.locator('#search').fill('wave');check('search_filters_cards',(await page.locator('#cards button').count())>0);
    await page.locator('#search').fill('impossible-no-match');check('search_empty_state',await page.locator('#empty').isVisible());await page.locator('#search').fill('');
    await page.screenshot({path:path.join(out,'library-desktop.png')});
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
    check('mobile_no_horizontal_overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(out,'library-mobile.png')});
    check('no_browser_errors',report.errors.length===0,{errors:report.errors});
    report.sourceAfter=hashes();check('source_frozen',JSON.stringify(report.sourceAfter)===JSON.stringify(report.sourceBefore));
    report.final=await snapshot();report.passed=true;
  }catch(e){report.failure=e.stack;report.passed=false;process.exitCode=1;}
  finally{await browser.close();fs.writeFileSync(path.join(out,'browser-acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,failure:report.failure}));}
})();
