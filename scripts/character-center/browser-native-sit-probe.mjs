import fs from 'node:fs/promises';import path from 'node:path';import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
try{
 await page.goto('http://127.0.0.1:18820/library-expansion/');await page.waitForFunction(()=>window.motionLibrary?.snapshot().ready,null,{timeout:120000});
 const data=await page.evaluate(async()=>{
  const a=window.motionLibrary,id='native:025acfb4d0c464f4';a.setManual(true);await a.inspect(id);a.step(0,false);
  let s=a.scene.snapshot(),start=performance.now();
  while(!s.body.active){s=a.step(0,false);if(performance.now()-start>35000)throw Error('prepare timeout');const e=s.body.events.find(e=>e.action===id&&['action_failed','action_rejected'].includes(e.type));if(e)throw Error(JSON.stringify(e));await new Promise(r=>setTimeout(r,5));}
  const row=a.scene.bodyDirector.active,plan=row.preparedNative.plan,diags=row.preparedNative.diagnostics,initial=s.actorState,samples=[];
  for(let t=0;t<12;t+=1/60){s=a.step(1/60,false);if(t>9.5&&Math.round(t*60)%6===0)samples.push({t,root:s.actorState.root,feet:[s.bones.leftAnkle,s.bones.rightAnkle],pelvis:s.bones.pelvis,native:s.native,support:s.actorState.support});if(Math.round(t*60)%60===0)await new Promise(r=>setTimeout(r,0));}
  a.scene.setView('side');a.step(0,true);a.ui();return {plan,diags,initial,samples,terminal:s.body.events.filter(e=>['action_completed','action_failed','action_rejected'].includes(e.type)).at(-1)};
 });
 await fs.writeFile('outputs/library-expansion-20261027/native-sit01-runtime-probe.json',JSON.stringify(data,null,2));
 await page.locator('#stage').screenshot({path:'outputs/library-expansion-20261027/native-sit01-runtime-probe.png'});
 console.log(JSON.stringify({plan:data.plan,diags:data.diags,initialRoot:data.initial.root,chair:data.initial.props.chair,terminal:data.terminal,last:data.samples.slice(-3)}));
}finally{await browser.close();}
