const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));
const root=path.resolve(__dirname,'../..'),out=path.join(root,'outputs/native-motion-20261022');

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:18789/native-motion/');
  try{await page.waitForFunction(()=>window.nativeMotion?.snapshot().ready||window.nativeMotionError,{},{timeout:90000});}
  catch(error){
    const diagnostic=await page.evaluate(()=>({status:document.getElementById('status')?.textContent,error:window.nativeMotionError,resources:performance.getEntriesByType('resource').length}));
    fs.writeFileSync(path.join(out,'browser-load-failure.json'),JSON.stringify({error:error.message,diagnostic,errors},null,2));
    await browser.close();throw error;
  }
  assert.equal(await page.evaluate(()=>window.nativeMotionError),undefined);
  console.log('Both native and PMX renderers ready; auditing the complete clip.');
  const audit=await page.evaluate(()=>{
    const n=window.nativeMotion;n.pause(true);
    const selected=['頭','左腕','左ひじ','左手首','右腕','右ひじ','右手首','左足','左ひざ','左足首','右足','右ひざ','右足首'];
    const samples=[],points={},errors=[],fingerErrors=[],driver=[];
    const meshes=[];n.source.traverse(o=>{if(o.isSkinnedMesh)meshes.push(o);});
    function skinHash(mesh){let sum=0;const v=n.clip.world[0].p.clone();for(let i=0;i<mesh.geometry.attributes.position.count;i+=53){v.fromBufferAttribute(mesh.geometry.attributes.position,i);mesh.applyBoneTransform(i,v);sum+=v.x*1.3+v.y*.7+v.z*.2;}return sum;}
    for(let i=0;i<n.clip.data.frameCount;i++){
      const s=n.seek(i*n.clip.data.duration/(n.clip.data.frameCount-1));
      samples.push(s);driver.push(s.lastStepMs);
      for(const row of n.retarget.mapping.filter(r=>selected.includes(r.bone.name))){
        const t=row.bone.matrixWorld.elements.slice(12,15),src=n.clip.world[row.source].p.toArray().map(x=>x*n.retarget.scale);
        const error=Math.hypot(...t.map((x,j)=>x-src[j]));errors.push(error);
        (points[row.bone.name]??=[]).push(t);
      }
      for(const row of n.retarget.mapping.filter(r=>r.bone.name.includes('指'))){
        const t=row.bone.matrixWorld.elements.slice(12,15),src=n.clip.world[row.source].p.toArray().map(x=>x*n.retarget.scale);
        fingerErrors.push(Math.hypot(...t.map((x,j)=>x-src[j])));
      }
      if(i===0||i===60||i===120)s.skin={source:meshes.map(skinHash),target:skinHash(n.mesh)};
    }
    const first=samples[0],last=samples.at(-1),loop={};
    for(const name of selected)loop[name]=Math.hypot(...first.target.bones[name].map((v,i)=>v-last.target.bones[name][i]));
    const ranges={};for(const [name,p] of Object.entries(points))ranges[name]=Math.hypot(...[0,1,2].map(i=>Math.max(...p.map(v=>v[i]))-Math.min(...p.map(v=>v[i]))));
    driver.sort((a,b)=>a-b);const max=arr=>Math.max(...arr);
    return {sourceName:n.clip.data.name,frameCount:samples.length,sourceBones:n.clip.data.bones.length,mappedBones:n.retarget.mapping.length,scale:n.retarget.scale,environment:n.snapshot().environment,
      finite:samples.every(s=>Object.values(s.target.bones).flat().every(Number.isFinite)),maxLengthError:max(samples.map(s=>s.target.maxLengthError)),
      jointPositionError:{rms:Math.sqrt(errors.reduce((s,x)=>s+x*x,0)/errors.length),max:max(errors),units:'PMX scene units'},
      fingerPositionError:{rms:Math.sqrt(fingerErrors.reduce((s,x)=>s+x*x,0)/fingerErrors.length),max:max(fingerErrors)},
      loopPositionDelta:loop,ranges,skinFrames:samples.filter(s=>s.skin).map(s=>({time:s.time,skin:s.skin})),
      renderedStepMs:{p50:driver[Math.floor(driver.length*.5)],p95:driver[Math.floor(driver.length*.95)],max:max(driver)},
      samples:samples.map(({target,...s})=>({...s,bones:target.bones})),userAgent:navigator.userAgent};
  });
  assert.equal(audit.finite,true);assert.equal(audit.maxLengthError,0);assert.ok(audit.jointPositionError.max<.25);
  assert.ok(audit.fingerPositionError.max<.25);
  assert.ok(audit.ranges['頭']>.02);assert.ok(audit.ranges['右手首']>.04);
  assert.notEqual(audit.skinFrames[0].skin.target,audit.skinFrames[1].skin.target);
  assert.notDeepEqual(audit.skinFrames[0].skin.source,audit.skinFrames[1].skin.source);
  assert.ok(Math.max(...Object.values(audit.loopPositionDelta))<.02);
  const freeze=await page.evaluate(()=>{const n=window.nativeMotion;n.pause(true);return n.seek(1.234);});
  await page.waitForTimeout(250);const frozen=await page.evaluate(()=>window.nativeMotion.snapshot());assert.equal(frozen.time,freeze.time);assert.deepEqual(frozen.target.bones,freeze.target.bones);
  await page.getByRole('button',{name:'播放',exact:true}).click();await page.waitForTimeout(550);
  const resumed=await page.evaluate(()=>window.nativeMotion.snapshot());assert.ok(resumed.time>frozen.time+.2);
  await page.evaluate(()=>{window.nativeMotion.pause(true);window.nativeMotion.seek(1.5);window.nativeMotion.setView('front');});
  await page.screenshot({path:path.join(out,'comparison-front.png'),fullPage:true});
  for(const view of ['side','back','angle']){
    await page.evaluate(v=>window.nativeMotion.setView(v),view);
    await page.screenshot({path:path.join(out,`comparison-${view}.png`),fullPage:true});
  }
  await page.evaluate(()=>{window.nativeMotion.setView('front');window.nativeMotion.seek(0);window.nativeMotion.pause(false);});
  audit.live=await page.evaluate(()=>new Promise(resolve=>{
    const samples=[],start=performance.now();function next(){samples.push(window.nativeMotion.snapshot().lastStepMs);if(samples.length<180)requestAnimationFrame(next);else {samples.sort((a,b)=>a-b);resolve({frames:samples.length,elapsedMs:performance.now()-start,fps:samples.length/((performance.now()-start)/1000),p50:samples[90],p95:samples[171]});}}requestAnimationFrame(next);
  }));
  audit.browserErrors=errors;audit.acceptance={all121Frames:true,finitePose:true,constantLengths:true,visibleSkinChanged:true,pauseFreeze:true,resume:true,loopClosure:true};
  fs.writeFileSync(path.join(out,'browser-acceptance.json'),JSON.stringify(audit,null,2));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({...audit,samples:undefined},null,2));await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
