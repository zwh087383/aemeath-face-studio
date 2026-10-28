import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CHARACTER_ACTIONS } from '../../realtime/character-center/catalog.mjs';
const require=createRequire(import.meta.url);
const playwrightPath=process.env.PLAYWRIGHT_PACKAGE??path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright');
const {chromium}=require(playwrightPath);
const flag=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const group=flag('--group','activity'),output=path.resolve(flag('--output','outputs/library-expansion-20261027/browser-'+group+'.json'));
const ids=flag('--ids','').split(',').filter(Boolean);
const cases=ids.length?ids:Object.values(CHARACTER_ACTIONS).filter(x=>x.executor===group).map(x=>x.id);
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
const result={at:new Date().toISOString(),cloudCalls:0,kind:'actual PMX browser integration, accelerated clock; not continuous human acceptance',cases:[],errors:[]};
page.on('pageerror',error=>result.errors.push(String(error)));
await fs.mkdir(path.dirname(output),{recursive:true});
try {
 for(const [index,id] of cases.entries()) {
  if(index%8===0){await page.goto(flag('--url','http://127.0.0.1:18820/library-expansion/'));await page.waitForFunction(()=>window.motionLibrary?.snapshot().ready||window.motionLibrary?.snapshot().fault,null,{timeout:120000});}
  const row=await page.evaluate(async id=>{
   const a=window.motionLibrary;a.setManual(true);const start=performance.now();
   const admitted=await a.inspect(id);let last,frames=0,driver=[];const loadMs=performance.now()-start;
   for(let i=0;i<1800;i++){
    last=a.step(.1,i%10===0);frames++;driver.push(last.driverMs);
    if(last.body.pending.some(x=>x.preparation==='loading'||x.nativePreparation==='loading'))await new Promise(r=>setTimeout(r,10));
    if(!last.body.active&&!last.body.pending.length&&!last.body.faceActive.length&&!last.body.controlActive)break;
    if(i%30===0)await new Promise(r=>setTimeout(r,0));
   }
   a.step(0,true);const receipt=last.body.events.filter(e=>e.action===id&&['action_completed','action_failed','action_rejected'].includes(e.type)).at(-1);
   driver.sort((x,y)=>x-y);
   return {id,catalogHash:a.snapshot().catalogHash,admitted,loadMs,wallMs:performance.now()-start,frames,simSeconds:last.now,finite:last.finite,
    terminal:receipt?{type:receipt.type,reason:receipt.reason,duration:receipt.actualDuration}:null,
    support:last.actorState.support,held:Object.entries(last.actorState.props).filter(([,p])=>p.visible&&['left','right','both'].includes(p.attachment)).map(([id])=>id),
    active:last.body.active?.action,pending:last.body.pending.map(x=>({action:x.action,preparation:x.preparation})),
    failures:last.body.events.filter(e=>['action_failed','action_rejected','action_skipped'].includes(e.type)).map(e=>({action:e.action,reason:e.reason})),
    driverMs:{median:driver[Math.floor(driver.length*.5)],p95:driver[Math.floor(driver.length*.95)],max:driver.at(-1)}};
  },id).catch(error=>({id,error:String(error)}));
  result.cases.push(row);await fs.writeFile(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({index:index+1,total:cases.length,id,status:row.terminal?.type??'incomplete',reason:row.terminal?.reason??row.error??row.failures}));
 }
}finally{await browser.close();await fs.writeFile(output,JSON.stringify(result,null,2));}
if(result.cases.some(x=>x.terminal?.type!=='action_completed'))process.exitCode=1;
