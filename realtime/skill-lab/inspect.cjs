const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));
const out=path.resolve(__dirname,'../../outputs/architecture-skill-20261022/forward-test');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  try{
  await page.goto('http://127.0.0.1:18793/skill-lab/');
  await page.waitForFunction(()=>window.skillLab?.snapshot().ready||window.skillLab?.snapshot().error,null,{timeout:120000});
  let initial=await page.evaluate(()=>window.skillLab.pause(true));
  const states=[];
  for(const [view,time]of [['front',.55],['front',1.8],['side',1.8],['face',1.8],['face',3.01],['front',3.01]]){
    const s=await page.evaluate(({view,time})=>{skillLab.seek(time);skillLab.setView(view);return skillLab.snapshot();},{view,time});
    states.push(s);await page.screenshot({path:path.join(out,`${view}-${time}.png`)});
  }
  fs.writeFileSync(path.join(out,'author-browser-inspection.json'),JSON.stringify({initial,states,errors},null,2));
  console.log(JSON.stringify({ready:initial.ready,error:initial.error,errors,states:states.map(s=>({time:s.time,view:s.view,arm:s.arm,face:s.faceResult,perf:s.performance}))},null,2));
  }catch(error){
    const state=await page.evaluate(()=>({status:document.getElementById('status')?.textContent,snapshot:window.skillLab?.snapshot()})).catch(()=>null);
    fs.writeFileSync(path.join(out,'author-browser-failure.json'),JSON.stringify({error:error.message,errors,state},null,2));
    await page.screenshot({path:path.join(out,'author-browser-failure.png'),timeout:10000}).catch(()=>{});
    throw error;
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
