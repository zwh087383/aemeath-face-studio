// Real PMX browser acceptance. Deterministic pose sampling is separate from the
// wall-clock playback/interrupt checks below. This harness does not use a cloud API.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));}
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[3]||path.join(root,'outputs/full-body-activities-20261022'));
const url=process.argv[2]||'http://127.0.0.1:18788/activities/';fs.mkdirSync(out,{recursive:true});
const files=['preview/core/activity-library.js','preview/core/full-body-controller.js','preview/core/full-body-ik.js','realtime/browser-activities.cjs',...['scene.mjs','viewer.mjs','director.mjs','props.mjs','prop-layout.mjs','index.html','style.css'].map(f=>'realtime/activities/'+f)];
const hashes=()=>Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
const report={experimental:true,started:new Date().toISOString(),checks:[],errors:[],sourceBefore:hashes(),clothPhysics:false,cloudCalls:0};
const check=(name,ok,data={})=>{report.checks.push({name,passed:!!ok,...data});if(!ok)throw Error(name);};
(async()=>{
  const browser=await playwright.chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1080}});page.on('pageerror',e=>report.errors.push(e.message));
    page.on('console',e=>{if(e.type()==='error')report.errors.push(e.text());});
    await page.goto(url);await page.waitForFunction(()=>window.activityLab?.ready||window.activityLab?.snapshot().error,null,{timeout:90000});
    await page.waitForFunction(()=>window.activityLab?.snapshot().rendered?.frame>5,null,{timeout:30000});
    const snapshot=()=>page.evaluate(()=>window.activityLab.snapshot());let s=await snapshot();report.environment=s.environment;
    check('actual_model_and_catalog_loaded',s.ready&&!s.error&&s.rendered.finite&&s.counts.activities>=65,{counts:s.counts});
    // Stop the host animation clock only on this automated page. Advance its actual body
    // solver at 60Hz and render representative poses using real MMD grants.
    await page.evaluate(()=>activityLab.setManualClock(true));await page.waitForTimeout(100);
    const ids=await page.evaluate(()=>Object.keys(activityLab.catalog));report.poses=[];
    for(const id of ids){
      const item=await page.evaluate(async id=>{
        const l=activityLab,b=l.scene.body,d=l.catalog[id];l.reset();l.choose('activities',id);
        const samples=[],targets=[.15,.4,.65,.9,1];let index=0;
        for(let i=0;i<1800;i++){
          const time=i/60;b.update(time,1/60);
          if(b.activeId===id&&!b.bridge&&(b.elapsed>=targets[index]*d.duration||(b.done&&index<targets.length))){
            await new Promise(requestAnimationFrame);const r=l.drawFrame(time),p=r.body.pose;let maxAnkleError=0;
            for(const side of ['L','R'])maxAnkleError=Math.max(maxAnkleError,Math.hypot(...r.bones[side==='L'?'leftAnkle':'rightAnkle'].map((v,j)=>v-p.feet[side].position[j])));
            samples.push({fraction:targets[index],finite:r.finite,root:r.body.root,support:p.support,maxAnkleError,props:r.props});index++;
          }
          if(b.done&&!b.afterPrerequisite)break;
        }
        return {id,samples,done:b.done,support:b.pose.support,expected:d.endSupport};
      },id);
      report.poses.push(item);check('pose_'+id,item.done&&item.samples.length>=4&&item.support===item.expected&&item.samples.every(s=>s.finite&&s.maxAnkleError<.03),{samples:item.samples.length,maxAnkleError:Math.max(...item.samples.map(s=>s.maxAnkleError))});
    }
    // Screenshot key phases after real support prerequisites, never force a
    // seated pose onto a standing rig or discard the body's motion state.
    for(const [id,fraction,view] of [['walk_forward',.36,'angle'],['run_forward',.42,'side'],['jump_forward',.42,'side'],['sit_down',1,'side'],['page_turn_seated',.55,'angle'],['squat',.45,'side'],['lunge_left',.5,'angle'],['type_at_desk',.5,'side'],['drink_standing',.5,'side'],['pickup_box',.8,'angle']]){
      await page.evaluate(async({id,fraction,view})=>{const l=activityLab,b=l.scene.body;l.reset();l.setView(view);l.choose('activities',id);for(let i=0;i<1600;i++){b.update(i/60,1/60);if(b.activeId===id&&!b.bridge&&b.elapsed>=fraction*l.catalog[id].duration){await new Promise(requestAnimationFrame);l.drawFrame(i/60);break;}}}, {id,fraction,view});
      await page.screenshot({path:path.join(out,id+'-'+view+'.png')});
    }
    // Preserve the desk in world space while the chair retreats, then stand.
    await page.evaluate(async()=>{const l=activityLab,b=l.scene.body;l.reset();l.setView('side');l.choose('activities','type_at_desk');for(let i=0;i<1200;i++){b.update(i/60,1/60);if(b.activeId==='type_at_desk'&&b.elapsed>2){await new Promise(requestAnimationFrame);l.drawFrame(i/60);break;}}});
    const tableBefore=await page.evaluate(()=>activityLab.scene.props.snapshot().props.table.position);
    await page.evaluate(()=>activityLab.choose('activities','stand_up_from_desk'));
    for(const [name,elapsed] of [['chair-retreat',1.7],['desk-rising',5.5],['desk-standing',7.5]]){
      const desk=await page.evaluate(async elapsed=>{const l=activityLab,b=l.scene.body;for(let i=0;i<900;i++){b.update(i/60,1/60);if(b.elapsed>=elapsed||b.done){await new Promise(requestAnimationFrame);return l.drawFrame(i/60);}}},elapsed);
      check(name+'_table_stays_fixed',JSON.stringify(desk.props.props.table.position)===JSON.stringify(tableBefore)&&desk.props.props.table.visible);
      await page.screenshot({path:path.join(out,name+'-side.png')});
    }
    // Reload restores the natural display clock for timing and interruption.
    await page.reload();await page.waitForFunction(()=>window.activityLab?.ready,null,{timeout:90000});
    await page.evaluate(()=>{activityLab.reset();activityLab.choose('activities','jump_forward');activityLab.resetMetrics();});
    await page.waitForFunction(()=>activityLab.snapshot().body.support==='airborne');
    const air=await snapshot();await page.evaluate(()=>activityLab.stop());
    check('airborne_has_real_height',air.rendered.bones.leftAnkle[1]>1.5&&air.rendered.bones.rightAnkle[1]>1.5,{root:air.body.root});
    await page.waitForFunction(()=>activityLab.snapshot().body.done,null,{timeout:8000});
    s=await snapshot();check('interrupt_lands_and_retires_queue',s.body.support==='standing'&&!s.body.queued&&!s.director.sequence&&s.rendered.bones.leftAnkle[1]<1.45&&s.rendered.bones.rightAnkle[1]<1.45,{elapsed:s.body.elapsed});
    await page.evaluate(()=>{activityLab.reset();activityLab.choose('sequences','reading_break');activityLab.startRecording();});
    await page.waitForFunction(()=>activityLab.snapshot().director.sequence?.step>=3&&activityLab.snapshot().body.activeId==='read_seated',null,{timeout:22000});
    await page.waitForTimeout(700);await page.evaluate(()=>activityLab.pause());await page.waitForTimeout(100);const frozen=await snapshot();await page.waitForTimeout(450);const later=await snapshot();
    check('pause_freezes_body_props_and_sequence',frozen.director.time===later.director.time&&JSON.stringify(frozen.rendered.bones)===JSON.stringify(later.rendered.bones)&&JSON.stringify(frozen.rendered.props)===JSON.stringify(later.rendered.props));
    await page.evaluate(()=>activityLab.pause());await page.waitForTimeout(500);await page.evaluate(()=>activityLab.stop());await page.waitForTimeout(1000);s=await snapshot();
    check('seated_stop_retains_support_and_no_future_steps',s.body.support==='seated'&&s.body.done&&!s.director.sequence&&s.rendered.props.props.chair.visible&&s.rendered.props.props.book.visible);
    await page.evaluate(()=>activityLab.choose('activities','walk_forward'));
    await page.waitForFunction(()=>activityLab.snapshot().body.activeId==='walk_forward',null,{timeout:7000});
    await page.waitForFunction(()=>activityLab.snapshot().body.done,null,{timeout:8500});s=await snapshot();
    check('seated_to_walk_stands_then_travels',s.body.support==='standing'&&s.body.root.position[2]>10&&s.rendered.props.props.chair.visible,{root:s.body.root,chair:s.rendered.props.props.chair.position});
    report.playback=s.performance;check('real_frames_continue',s.performance.frames>120&&s.performance.frameP95Ms<100,{performance:s.performance});
    const bytes=await page.evaluate(()=>activityLab.stopRecording());check('recorded_preview',bytes>10000,{bytes});
    const download=page.waitForEvent('download');await page.evaluate(()=>activityLab.downloadRecording());await(await download).saveAs(path.join(out,'full-body-activities.webm'));
    await page.locator('#search').fill('不存在的活动');check('search_empty_state',await page.locator('#empty').isVisible());await page.locator('#search').fill('');
    await page.locator('#reset').click();await page.waitForTimeout(150);s=await snapshot();
    check('ui_reset_returns_to_origin_and_clears_props',s.body.root.position.every(v=>Math.abs(v)<1e-6)&&!Object.values(s.rendered.props.props).some(p=>p.visible));
    await page.screenshot({path:path.join(out,'activities-desktop.png')});await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
    check('mobile_no_horizontal_overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'activities-mobile.png')});
    check('no_browser_errors',report.errors.length===0,{errors:report.errors});report.sourceAfter=hashes();check('source_frozen',JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter));report.passed=true;
  }catch(e){report.failure=e.stack;report.passed=false;process.exitCode=1;}
  finally{await browser.close();fs.writeFileSync(path.join(out,'browser-acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,failure:report.failure}));}
})();
