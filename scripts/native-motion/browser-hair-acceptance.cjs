const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));
const root=path.resolve(__dirname,'../..');
const out=path.join(root,'outputs/hair-binding-20261022');
const url=process.env.NATIVE_RESOURCES_URL||'http://127.0.0.1:18792/native-resources/';
const output=path.join(out,'browser-hair-acceptance.json');

// Isolated headless Chrome; the user's visible preview and model assets are never
// edited. Old behavior is simulated only by deleting aliases from this page's
// in-memory lookup, and restored before the next selection.
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist',
    '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  const page=await browser.newPage({viewport:{width:1580,height:1080}});
  const errors=[];
  const result={schema:1,url,startedAt:new Date().toISOString(),
    evidence:'Real local decoded clips and PMX skinning in independent headless Chrome; old alias omission simulated in memory; no cloud calls.',
    browserErrors:errors,checks:[],screenshots:[]};
  page.on('pageerror',error=>errors.push(error.message));
  console.log('Independent Chrome launched; waiting for both model renderers.');
  const save=()=>fs.writeFileSync(output,JSON.stringify(result,null,2));
  const check=(name,data)=>{result.checks.push({name,...data});save();console.log(`PASS ${name}`);};
  const select=async id=>page.evaluate(async id=>{await window.nativeResources.select(id);return window.nativeResources.pause(true);},id);
  try{
    await page.goto(url);
    await page.bringToFront();
    await page.waitForFunction(()=>{const n=window.nativeResources;if(n?.snapshot().ready){n.pause(true);return true;}return window.nativeResourcesError;},{},{timeout:180000,polling:250});
    assert.equal(await page.evaluate(()=>window.nativeResourcesError),undefined);
    const manifest=await page.evaluate(async()=>{const r=await fetch('/native-resources-data/manifest.json');if(!r.ok)throw Error('manifest');return r.json();});
    const body=name=>manifest.clips.find(r=>r.resourceKind==='body'&&(r.id===name||r.name===name));
    const ribbon=name=>manifest.clips.find(r=>r.resourceKind==='ribbon'&&r.name===name);
    const stand=body('Stand2'),cheek=body('aimisi-cheek01'),standRibbon=ribbon('Rib_Stand2');
    assert.ok(stand&&cheek&&standRibbon);
    const initial=await page.evaluate(()=>window.nativeResources.pause(true));
    assert.equal(initial.currentId,stand.id);assert.equal(initial.error,null);
    assert.equal(initial.layers.find(row=>row.kind==='ribbon')?.id,standRibbon.id);
    assert.equal(initial.layers.find(row=>row.kind==='ribbon')?.automatic,true);
    assert.equal(initial.target.nativeLongHairMapped,63);
    check('default Stand2 loads authored companion',{body:initial.currentId,layers:initial.layers,target:initial.target,environment:initial.environment});

    await page.evaluate(async()=>{
      const n=window.nativeResources,{NATIVE_HAIR_BINDINGS,nativeHairSource}=await import('/preview/core/native-hair-binding.js');
      const longBones=n.mesh.skeleton.bones.filter(b=>nativeHairSource(b.name));
      const indices=new Set(longBones.map(b=>n.mesh.skeleton.bones.indexOf(b)));
      const a=n.mesh.geometry.attributes,vertexIndices=[];
      for(let i=0;i<a.position.count;i++)for(let k=0;k<4;k++)if(indices.has(a.skinIndex.array[i*4+k])&&a.skinWeight.array[i*4+k]>1e-7){vertexIndices.push(i);break;}
      const vector=n.clip.world[0].p.clone(),head=n.mesh.skeleton.bones.find(b=>b.name==='頭');
      function capture(){
        const position=head.getWorldPosition(vector.clone()),inverse=head.getWorldQuaternion(head.quaternion.clone()).invert(),points=[];
        for(const index of vertexIndices){vector.fromBufferAttribute(a.position,index);n.mesh.applyBoneTransform(index,vector);n.mesh.localToWorld(vector);vector.sub(position).applyQuaternion(inverse);points.push(vector.x,vector.y,vector.z);}
        return {points,finite:points.every(Number.isFinite),body:n.retarget.snapshot().bones,
          matrices:n.mesh.skeleton.bones.flatMap(b=>b.matrixWorld.elements),
          local:longBones.map(b=>b.quaternion.clone()),
          maxLengthError:n.retarget.snapshot().maxLengthError};
      }
      function displacement(a,b){let maximum=0,total=0;for(let i=0;i<a.length;i+=3){const d=Math.hypot(a[i]-b[i],a[i+1]-b[i+1],a[i+2]-b[i+2]);maximum=Math.max(maximum,d);total+=d;}return {maximum,mean:total/(a.length/3)};}
      function sample(){
        n.pause(true);const length=n.clip.data.duration,rows=[];
        for(let j=0;j<=16;j++){const fraction=j/16;n.seek(length*fraction);const s=capture();rows.push({fraction,time:n.snapshot().time,...s});}
        const first=rows[0];return {vertices:vertexIndices.length,longBones:longBones.length,
          finite:rows.every(s=>s.finite&&s.matrices.every(Number.isFinite)),maxLengthError:Math.max(...rows.map(s=>s.maxLengthError)),
          maxLocalDegrees:Math.max(...rows.flatMap(s=>s.local.map((q,i)=>q.angleTo(first.local[i])*180/Math.PI))),
          maxDisplacement:Math.max(...rows.map(s=>displacement(first.points,s.points).maximum)),
          maxMeanDisplacement:Math.max(...rows.map(s=>displacement(first.points,s.points).mean)),
          samples:rows.map(s=>({fraction:s.fraction,time:s.time,...displacement(first.points,s.points)})),
          _rows:rows};
      }
      function omitAliases(){const removed=[];for(const [bone,row]of n.retarget.byBone)if(nativeHairSource(bone.name)){removed.push([bone,row]);n.retarget.byBone.delete(bone);}return removed;}
      function restoreAliases(rows){for(const [bone,row]of rows)n.retarget.byBone.set(bone,row);}
      window.__hairAudit={capture,sample,omitAliases,restoreAliases,displacement,aliases:NATIVE_HAIR_BINDINGS};
    });
    const standMotion=await page.evaluate(()=>{const a=window.__hairAudit.sample();delete a._rows;return a;});
    assert.equal(standMotion.longBones,63);assert.equal(standMotion.vertices,23972);assert.ok(standMotion.maxDisplacement>.01);assert.ok(standMotion.finite);assert.equal(standMotion.maxLengthError,0);
    check('Stand2 companion visibly deforms real long-hair skin',standMotion);

    const selectedCheek=await select(cheek.id);
    assert.equal(selectedCheek.error,null);assert.equal(selectedCheek.layers.some(row=>row.kind==='ribbon'),false,'Old Stand2 companion must be removed for Cheek01');
    const comparison=await page.evaluate(()=>{
      const a=window.__hairAudit,n=window.nativeResources,removed=a.omitAliases(),old=a.sample();a.restoreAliases(removed);const current=a.sample();
      let protectedBodyError=0;
      for(let i=0;i<old._rows.length;i++)for(const name of Object.keys(old._rows[i].body))for(let k=0;k<3;k++)protectedBodyError=Math.max(protectedBodyError,Math.abs(old._rows[i].body[name][k]-current._rows[i].body[name][k]));
      const peak=current.samples.reduce((best,row)=>row.maximum>best.maximum?row:best,current.samples[0]);
      delete old._rows;delete current._rows;return {removedAliases:removed.length,old,current,protectedBodyError,peak};
    });
    assert.equal(comparison.removedAliases,63);assert.ok(comparison.old.maxDisplacement<1e-5);assert.ok(comparison.current.maxDisplacement>.1);
    assert.ok(comparison.protectedBodyError<1e-7);assert.equal(comparison.current.maxLengthError,0);assert.ok(comparison.current.finite);
    check('Cheek01 old omission versus fixed real skin',{body:cheek.id,...comparison});

    for(const old of [true,false]){
      await page.evaluate(({old,time})=>{const a=window.__hairAudit,n=window.nativeResources;n.pause(true);if(old)window.__oldAliases=a.omitAliases();else if(window.__oldAliases){a.restoreAliases(window.__oldAliases);delete window.__oldAliases;}n.seek(time);document.querySelector('#target-section .label span').textContent=old?'旧版漏驱动（独立浏览器内模拟）':'修复后：63 个中文长发骨已驱动';},{old,time:comparison.peak.time});
      for(const view of ['back','side']){await page.evaluate(view=>window.nativeResources.setView(view),view);const filename=`cheek-${old?'old':'fixed'}-${view}.png`;await page.locator('#comparison').screenshot({path:path.join(out,filename)});result.screenshots.push(filename);}
    }

    await select(stand.id);
    const deterministic=await page.evaluate(()=>{
      const n=window.nativeResources,a=window.__hairAudit;n.pause(true);n.seek(.5);const first=a.capture();
      for(const time of [3.1,.1,2.4,.5])n.seek(time);
      const second=a.capture();return {hairError:a.displacement(first.points,second.points),bodyEqual:JSON.stringify(first.body)===JSON.stringify(second.body)};
    });
    assert.ok(deterministic.hairError.maximum<1e-7);assert.ok(deterministic.bodyEqual);
    const beforePause=await page.evaluate(()=>{window.nativeResources.pause(true);return {snapshot:window.nativeResources.snapshot(),matrices:window.__hairAudit.capture().matrices};});
    await page.waitForTimeout(300);
    const afterPause=await page.evaluate(()=>({snapshot:window.nativeResources.snapshot(),matrices:window.__hairAudit.capture().matrices}));
    assert.equal(afterPause.snapshot.time,beforePause.snapshot.time);assert.deepEqual(afterPause.matrices,beforePause.matrices);
    await page.evaluate(()=>{window.nativeResources.seek(3.9);window.nativeResources.pause(false);});
    await page.waitForFunction(()=>window.nativeResources.snapshot().cycleOffset>=4,{},{timeout:15000,polling:250});
    const loop=await page.evaluate(()=>window.nativeResources.pause(true));assert.ok(loop.layers.some(row=>row.id==='rib-rib-stand2-e1fc7ce581'));
    check('pause backward seeks and loop preserve companion',{deterministic,pausedMilliseconds:300,loopTime:loop.time,loopOffset:loop.cycleOffset});
    const clear=await page.evaluate(()=>{const n=window.nativeResources;n.seek(1.2);const before=n.retarget.snapshot().bones;n.clearLayers();return {before,after:n.retarget.snapshot().bones,snapshot:n.snapshot()};});
    assert.deepEqual(clear.before,clear.after);assert.equal(clear.snapshot.layers.length,0);
    check('clearing layers protects body pose',{bodyPoseUnchanged:true,layers:clear.snapshot.layers});

    // Delay only the first request for an uncached companion. A newer A must win
    // after A -> B -> A, regardless of the old companion completing last.
    const staleBody=body('Team_Stand2'),staleRibbon=ribbon('Rib_Team_Stand2');assert.ok(staleBody&&staleRibbon);
    let releaseFirst,arrivedFirst;const release=new Promise(resolve=>{releaseFirst=resolve;}),arrived=new Promise(resolve=>{arrivedFirst=resolve;});let intercepted=0;
    const pattern=`**/native-resources-data/clips/${staleRibbon.id}.json`;
    await page.route(pattern,async route=>{if(intercepted++===0){arrivedFirst();await release;}await route.continue().catch(()=>{});});
    await page.evaluate(id=>{window.__oldHairSelection=window.nativeResources.select(id);},staleBody.id);
    await Promise.race([arrived,new Promise((_,reject)=>setTimeout(()=>reject(Error('Delayed companion never requested')),15000))]);
    await select(cheek.id);const latest=await select(staleBody.id);releaseFirst();await page.evaluate(()=>window.__oldHairSelection);await page.unroute(pattern);
    const finalStale=await page.evaluate(()=>window.nativeResources.pause(true));
    assert.equal(finalStale.currentId,staleBody.id);assert.equal(finalStale.selectedId,staleBody.id);assert.equal(finalStale.error,null);assert.equal(finalStale.layers.find(row=>row.kind==='ribbon')?.id,staleRibbon.id);
    check('delayed companion A B A rejects stale completion',{olderAndLatest:staleBody.id,middle:cheek.id,intercepted,currentId:finalStale.currentId,layers:finalStale.layers});

    const representative=[...manifest.clips.filter(row=>row.resourceKind==='body'&&row.boneCount===197),
      body('aimisi-turn-left90'),body('aimisi-turn-right90'),body('sit_headmove_01_Loop'),body('Team_Stand1')].filter(Boolean);
    for(const entry of representative){
      const selected=await select(entry.id);assert.equal(selected.currentId,entry.id);assert.equal(selected.error,null);
      const audit=await page.evaluate(entry=>{const n=window.nativeResources,poses=[];for(const t of [0,.25,.5,.75,.999]){n.seek(entry.duration*t);const s=n.retarget.snapshot();poses.push({finite:n.mesh.skeleton.bones.every(b=>b.matrixWorld.elements.every(Number.isFinite)),maxLengthError:s.maxLengthError,time:n.snapshot().time});}return {sourceBones:n.clip.data.bones.length,longHairMapped:n.retarget.snapshot().nativeLongHairMapped,poses,layers:n.snapshot().layers};},entry);
      assert.ok(audit.poses.every(p=>p.finite&&p.maxLengthError===0));if(entry.boneCount===197)assert.equal(audit.longHairMapped,0);
      check(`representative ${entry.id}`,{id:entry.id,...audit});
    }
    const fallbackBody=body('Stand1_Action02'),fallbackRibbon=ribbon('Rib_Stand1_Action02');assert.ok(fallbackBody&&fallbackRibbon);
    const fallbackPattern=`**/native-resources-data/clips/${fallbackRibbon.id}.json`;let fallbackRequests=0;
    await page.route(fallbackPattern,async route=>{
      if(fallbackRequests++===0)await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({schema:999,frames:[]})});
      else await route.continue();
    });
    const fallback=await select(fallbackBody.id);
    const fallbackDiagnostic=await page.locator('#diagnostics').textContent();
    assert.equal(fallback.currentId,fallbackBody.id);assert.equal(fallback.selectedId,fallbackBody.id);assert.equal(fallback.error,null);
    assert.equal(fallback.layers.some(layer=>layer.kind==='ribbon'),false);assert.match(fallbackDiagnostic,/Unsupported native clip/);
    check('malformed companion preserves successful body selection',{id:fallback.currentId,error:fallback.error,layers:fallback.layers,companionError:JSON.parse(fallbackDiagnostic).companionError});
    const retry=await select(fallbackBody.id);
    assert.equal(retry.layers.find(layer=>layer.kind==='ribbon')?.id,fallbackRibbon.id,'An invalid companion must be evicted so an immediate retry can recover');
    assert.equal(retry.layers.find(layer=>layer.kind==='ribbon')?.automatic,true);assert.equal(fallbackRequests,2);
    await page.unroute(fallbackPattern);
    check('malformed companion immediate retry recovers',{requests:fallbackRequests,id:retry.currentId,companion:fallbackRibbon.id});
    assert.equal(errors.length,0);result.passed=true;result.finishedAt=new Date().toISOString();save();
    console.log(JSON.stringify({passed:true,checks:result.checks.length,screenshots:result.screenshots,output}));
  }catch(error){result.passed=false;result.failure={message:error.message,stack:error.stack};
    try{result.failure.page=await Promise.race([page.evaluate(()=>{const state=window.nativeResources?.snapshot();return{status:document.getElementById('status')?.textContent,error:window.nativeResourcesError,state:state?{ready:state.ready,modelsReady:state.modelsReady,frame:state.frame,currentId:state.currentId,error:state.error,environment:state.environment}:null};}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Diagnostic page evaluation timed out')),5000))]);}catch(diagnostic){result.failure.diagnosticError=diagnostic.message;}
    save();throw error;}
  finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
