import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE??path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));
const continuationOnly=process.argv.includes('--continuation-only');
const id='native:a5508661ae29831d',out='outputs/library-expansion-20261027',destination=path.join(out,continuationOnly?'native-weak-continuation-browser.json':'browser-native-weak-final.json');
const result={at:new Date().toISOString(),cloudCalls:0,kind:'Actual PMX browser; source clock advanced at 60Hz, screenshots rendered, not human continuous-view acceptance',cases:[],errors:[]};
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>result.errors.push(String(e)));
await fs.mkdir(out,{recursive:true});
try{
  await page.goto('http://127.0.0.1:18820/library-expansion/');
  await page.waitForFunction(()=>window.motionLibrary?.snapshot().ready||window.motionLibrary?.snapshot().fault,null,{timeout:120000});
  for(const cancelAt of (continuationOnly?[2]:[null,2,8.5,10.8])){
    const started=await page.evaluate(async id=>{
      const a=window.motionLibrary;a.setManual(true);await a.inspect(id);a.step(0,true);
      const initial=a.scene.snapshot(),begin=performance.now();
      while(!a.scene.snapshot().body.active){
        a.step(0,false);const s=a.scene.snapshot();
        const failure=s.body.events.find(e=>e.action===id&&['action_failed','action_rejected'].includes(e.type));
        if(failure)throw Error(JSON.stringify(failure));
        if(performance.now()-begin>35000)throw Error('native preparation timed out');
        await new Promise(r=>setTimeout(r,5));
      }
      a.scene.setView('angle');a.step(0,true);
      return {root:initial.actorState.root,chair:initial.props.props.chair,visibleProps:Object.entries(initial.props.props).filter(([,p])=>p.visible).map(([k])=>k),catalogHash:a.snapshot().catalogHash,preparationMs:performance.now()-begin};
    },id);
    if(started.visibleProps.join(',')!=='chair'||Math.abs(started.chair.position[2]+8.2)>1e-5||Math.abs(started.root.position[2]+2.594705891609191)>1e-5)throw Error('inspection fixture changed: '+JSON.stringify(started));
    const prefix=cancelAt===null?'complete':'cancel-'+cancelAt;let elapsed=0,receipt=null,last;
    const checkpoints=cancelAt===null?[0,3,8.95,11.5,15]:[cancelAt,15];
    for(const target of checkpoints){
      last=await page.evaluate(async({seconds,interrupt})=>{
        const a=window.motionLibrary;let s=a.scene.snapshot();
        for(let t=0;t<seconds-1e-8;t+=1/60){s=a.step(Math.min(1/60,seconds-t),Math.round(t*60)%3===0);if(Math.round(t*60)%30===0)await new Promise(r=>setTimeout(r,0));}
        if(interrupt){const before=structuredClone(s.bones);a.cancel();s=a.step(0,true);const gap=Math.max(...Object.keys(before).map(k=>Math.hypot(...before[k].map((v,i)=>v-s.bones[k][i]))));if(gap>1e-6)throw Error('cancel jumped display: '+gap);}
        a.step(0,true);a.ui();s=a.scene.snapshot();
        return {finite:s.finite,support:s.actorState.support,native:s.native,body:s.body,sourceSpeed:s.sourceSpeed,bodyAmplitude:s.bodyAmplitude};
      },{seconds:target-elapsed,interrupt:cancelAt!==null&&target===cancelAt});elapsed=target;
      if(cancelAt===null||target===cancelAt)await page.locator('#stage').screenshot({path:path.join(out,`weak-seat-${prefix}-${target}.png`)});
    }
    receipt=last.body.events.filter(e=>e.action===id&&['action_completed','action_cancelled','action_failed','action_rejected'].includes(e.type)).at(-1);
    const row={id,scenario:prefix,initial:started,catalogHash:started.catalogHash,terminal:receipt?{type:receipt.type,reason:receipt.reason}:null,finite:last.finite,support:last.support,native:last.native,sourceSpeed:last.sourceSpeed,bodyAmplitude:last.bodyAmplitude,
      failures:last.body.events.filter(e=>['action_failed','action_rejected'].includes(e.type)),passed:!!receipt&&receipt.type===(cancelAt===null?'action_completed':'action_cancelled')&&last.support==='standing'&&last.finite};
    if(cancelAt!==null&&last.native?.state!=='cancelled-held')row.passed=false;
    if(continuationOnly){
      row.followup=await page.evaluate(async id=>{
        const a=window.motionLibrary,before=a.scene.snapshot(),startedBefore=before.body.events.filter(e=>e.action===id&&e.type==='action_started').length;
        const admitted=a.submit([{action:'gesture:wave',anchor:'immediate'}]);let s=before;
        for(let i=0;i<360;i++){s=a.step(1/60,i%3===0);if(i%30===0)await new Promise(r=>setTimeout(r,0));}
        a.step(0,true);a.ui();const receipt=s.body.events.filter(e=>e.action==='gesture:wave'&&['action_completed','action_failed','action_rejected'].includes(e.type)).at(-1);
        const revived=s.native?.state!=='cancelled-held'||s.body.events.filter(e=>e.action===id&&e.type==='action_started').length!==startedBefore;
        return {admitted,terminal:receipt?{type:receipt.type,reason:receipt.reason}:null,executor:s.executor,support:s.actorState.support,nativeState:s.native?.state,revived,finite:s.finite};
      },id);
      row.passed&&=row.followup.terminal?.type==='action_completed'&&!row.followup.revived&&row.followup.finite;
      await page.locator('#stage').screenshot({path:path.join(out,'weak-seat-followup-wave.png')});
    }
    result.cases.push(row);await fs.writeFile(destination,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({scenario:prefix,terminal:row.terminal,support:row.support,nativeState:last.native?.state,passed:row.passed}));
  }
}catch(error){result.errors.push(String(error));throw error;}
finally{await browser.close();await fs.writeFile(destination,JSON.stringify(result,null,2)+'\n');}
if(result.errors.length||result.cases.some(c=>!c.passed))process.exitCode=1;
