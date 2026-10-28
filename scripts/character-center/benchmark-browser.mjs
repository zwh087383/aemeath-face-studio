import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE??path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const result={at:new Date().toISOString(),cloudCalls:0,baseline:'5b1f583556610da09e63d0eaf872340277dfd462',machine:{platform:os.platform(),cpu:os.cpus()[0].model,cores:os.cpus().length,freeMemory:os.freemem(),totalMemory:os.totalmem()},runs:[]};
const resourceOnly=process.argv.includes('--resources-only');
const movementOnly=process.argv.includes('--movement-only');
const finalComparison=process.argv.includes('--final-comparison');
const nativeLong=process.argv.includes('--native-long');
const output='outputs/library-expansion-20261027/'+(nativeLong?'performance-native-complete.json':movementOnly?'performance-movement-final.json':finalComparison?'performance-comparison-final.json':resourceOnly?'performance-resource-followup.json':'performance-comparison.json');
const attachErrors=page=>page.on('pageerror',error=>console.error('PAGE ERROR: '+error.stack));
const hostSample=()=>({at:new Date().toISOString(),freeMemory:os.freemem(),cpus:os.cpus().map(c=>c.times)});
async function measure(page,options){
 const before=hostSample(),row=await page.evaluate(options=>window.benchmark.run(options),options),after=hostSample();
 const delta=after.cpus.map((cpu,i)=>Object.fromEntries(Object.keys(cpu).map(k=>[k,cpu[k]-before.cpus[i][k]])));
 const total=delta.flatMap(Object.values).reduce((s,v)=>s+v,0),idle=delta.reduce((s,v)=>s+v.idle,0);
 return {...row,host:{before,after,cpuBusyPercent:100*(total-idle)/Math.max(1,total)},hostIsolation:'Other user services were preserved; measurements are interleaved, not an isolated-machine benchmark.'};
}
try {
 if(nativeLong){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});attachErrors(page);
  await page.goto('http://127.0.0.1:18820/library-expansion/benchmark.html');await page.waitForFunction(()=>window.benchmark?.ready,null,{timeout:120000});
  result.runs.push(await measure(page,{seconds:35,loadNative:true}));
  await fs.writeFile(output,JSON.stringify(result,null,2));console.log('Saved '+output);await page.close();
 }else if(movementOnly){
  for(const movement of ['activity:walk_left','activity:walk_forward']){
   const page=await browser.newPage({viewport:{width:1440,height:1000}});attachErrors(page);
   await page.goto('http://127.0.0.1:18820/library-expansion/benchmark.html');await page.waitForFunction(()=>window.benchmark?.ready,null,{timeout:120000});
   result.runs.push(await measure(page,{seconds:12,movement}));await fs.writeFile(output,JSON.stringify(result,null,2));await page.close();
  }
  console.log('Saved '+output);
 }else{
 // Interleave versions; timings include all scene work, not just bone solving.
 for(const version of (resourceOnly?['expanded']:['expanded','baseline','baseline','expanded'])){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});attachErrors(page);await page.goto('http://127.0.0.1:18820/library-expansion/benchmark.html?version='+version);
  await page.waitForFunction(()=>window.benchmark?.ready,null,{timeout:120000});
  const row=await measure(page,{seconds:8});result.runs.push(row);await fs.writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify({...row,host:{cpuBusyPercent:row.host.cpuBusyPercent}}));await page.close();
 }
 const page=await browser.newPage({viewport:{width:1440,height:1000}});attachErrors(page);await page.goto('http://127.0.0.1:18820/library-expansion/benchmark.html');await page.waitForFunction(()=>window.benchmark?.ready,null,{timeout:120000});
 result.runs.push(await measure(page,{seconds:10,loadNative:true}));
 await page.close();
 const failed=await browser.newPage({viewport:{width:1440,height:1000}});attachErrors(failed);await failed.route('**/native-resources-data/clips/*.json',route=>route.fulfill({status:503,body:'local injected resource failure'}));
 await failed.goto('http://127.0.0.1:18820/library-expansion/benchmark.html');await failed.waitForFunction(()=>window.benchmark?.ready,null,{timeout:120000});
 result.runs.push(await measure(failed,{seconds:8,loadNative:true,failResource:true}));
 await fs.writeFile(output,JSON.stringify(result,null,2));console.log('Saved '+output);
 }
}finally{await browser.close();}
