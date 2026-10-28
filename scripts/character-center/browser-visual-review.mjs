import fs from 'node:fs/promises';import path from 'node:path';import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE??path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),out='outputs/library-expansion-20261027';
try{
 await page.goto('http://127.0.0.1:18820/library-expansion/');await page.waitForFunction(()=>window.motionLibrary?.snapshot().ready,null,{timeout:120000});
 const rows=[];
 for(const [id,seconds,view,name] of [['action:chin_tap',1.1,'face','chin-final-front'],['action:chin_tap',1.1,'other-side','chin-final-right'],['activity:read_seated',2,'angle','read-seated-final'],['activity:type_at_desk',4,'angle','typing-final'],['native:a5508661ae29831d',3,'angle','native-weak-sit'],['native:d387689ca7480266',3,'other-side','native-seated-reaction'],['native:fdc84d12a3151b50',3,'angle','native-keyboard']]){
  const row=await page.evaluate(async({id,seconds,view})=>{
   const a=window.motionLibrary;a.setManual(true);await a.inspect(id);let s,activeTime=0;
   for(let i=0;i<4000;i++){
    const loading=a.scene.bodyDirector.pending.some(r=>r.preparation==='loading'||r.nativePreparation==='loading');
    s=a.step(loading?0:.05,false);if(loading)await new Promise(r=>setTimeout(r,10));
    if(s.body.active?.action===id)activeTime+=loading?0:.05;
    if(activeTime>=seconds||s.body.events.some(e=>e.action===id&&['action_failed','action_rejected'].includes(e.type)))break;
    if(i%20===0)await new Promise(r=>setTimeout(r,0));
   }
   a.scene.setView(view);a.step(0,true);return {id,support:s.actorState.support,phase:s.actorState.phase,active:s.body.active?.action,activeTime,failures:s.body.events.filter(x=>x.type==='action_failed'||x.type==='action_rejected').map(x=>({action:x.action,reason:x.reason}))};
  },{id,seconds,view});
  await page.locator('#stage').screenshot({path:`${out}/${name}.png`});rows.push(row);
 }
 for(const emotion of ['excited','sad']){
  await page.evaluate(async()=>{const a=window.motionLibrary;await a.reset();a.setManual(true);a.scene.setView('face');});
  await page.selectOption('#emotion',emotion);await page.evaluate(()=>{for(let i=0;i<12;i++)window.motionLibrary.step(.1,false);window.motionLibrary.step(0,true);});
  await page.locator('#stage').screenshot({path:`${out}/face-${emotion}-final.png`});
 }
 await fs.writeFile(`${out}/visual-review-frames.json`,JSON.stringify(rows,null,2));console.log(JSON.stringify(rows));
}finally{await browser.close();}
