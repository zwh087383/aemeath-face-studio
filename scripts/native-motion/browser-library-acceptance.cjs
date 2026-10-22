const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));
const root=path.resolve(__dirname,'../..');
const out=path.join(root,'outputs/native-common-motions-20261022');
const url=process.env.NATIVE_LIBRARY_URL||'http://127.0.0.1:18790/native-library/';
const visualOnly=process.argv.includes('--visual-only');
const near=(a,b,tolerance=1e-6)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
  const page=await browser.newPage({viewport:{width:1520,height:1050}});
  const errors=[],requests=[];let result={url,browserErrors:errors};
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/\/native-library-data\/clips\//.test(request.url()))requests.push(request.url());});
  try{
    await page.goto(url);
    await page.waitForFunction(()=>window.nativeLibrary?.snapshot().ready||window.nativeLibraryError,{},{timeout:120000});
    assert.equal(await page.evaluate(()=>window.nativeLibraryError),undefined);
    const manifest=await page.evaluate(async()=>{const response=await fetch('/native-library-data/manifest.json');if(!response.ok)throw Error('Manifest unavailable');return response.json();});
    const clips=manifest.clips.filter(clip=>clip.status==='ready');
    assert.ok(clips.length>1,'A common-action library should include more than one playable clip');
    assert.equal(new Set(clips.map(clip=>clip.id)).size,clips.length,'Clip IDs must be unique');
    const initial=await page.evaluate(()=>window.nativeLibrary.snapshot());
    const initialRequests=[...requests];
    assert.equal(new Set(initialRequests).size,1,'Initial page load must request one clip, rather than the whole library');
    result={...result,manifest:{schema:manifest.schema,experimental:manifest.experimental,count:clips.length},initial,initialRequests};
    console.log(visualOnly?'Both model renderers ready; checking updated camera follow, sitting framing and visual evidence.':`Both model renderers ready; auditing ${clips.length} locally decoded native clips.`);

    // Exercise an actual out-of-order network completion before these clips enter the cache.
    const fresh=clips.filter(clip=>!initialRequests.some(request=>request.endsWith(`/${clip.id}.json`)));
    if(fresh.length>=2&&!visualOnly){
      const [older,newer]=fresh;let releaseOlder,olderStarted;
      const olderArrived=new Promise(resolve=>{olderStarted=resolve;});
      const release=new Promise(resolve=>{releaseOlder=resolve;});
      const routePattern=`**/native-library-data/clips/${older.id}.json`;
      await page.route(routePattern,async route=>{olderStarted();await release;await route.continue().catch(()=>{});});
      await page.evaluate(id=>{window.nativeLibrary.pause(true);window.nativeLibraryOlderSelection=window.nativeLibrary.select(id).then(value=>({ok:true,value}),error=>({ok:false,error:error.message}));},older.id);
      await Promise.race([olderArrived,new Promise((_,reject)=>setTimeout(()=>reject(Error('Deferred selection did not request its clip')),15000))]);
      await page.evaluate(async id=>{await window.nativeLibrary.select(id);window.nativeLibrary.pause(true);},newer.id);
      releaseOlder();
      const olderResult=await page.evaluate(()=>window.nativeLibraryOlderSelection);
      const settled=await page.evaluate(()=>window.nativeLibrary.snapshot());
      assert.equal(settled.selectedId,newer.id,'An older asynchronous selection must not replace the latest selection');
      result.staleSelection={older:older.id,newer:newer.id,olderResult,settledId:settled.selectedId};
      await page.unroute(routePattern);
    }

    const audits=[];
    for(const entry of visualOnly?[]:clips){
      const selected=await page.evaluate(async id=>{await window.nativeLibrary.select(id);return window.nativeLibrary.pause(true);},entry.id);
      assert.equal(selected.selectedId,entry.id,`${entry.id}: selection failed`);assert.equal(selected.lastLoadError,null,entry.id);
      const audit=await page.evaluate(entry=>{
        const n=window.nativeLibrary;n.pause(true);
        const skins=[];n.source.traverse(object=>{if(object.isSkinnedMesh)skins.push(object);});
        function skinHash(mesh){
          const v=n.clip.world[0].p.clone();let sum=0,sumSq=0,count=0;
          for(let index=0;index<mesh.geometry.attributes.position.count;index+=53){
            v.fromBufferAttribute(mesh.geometry.attributes.position,index);mesh.applyBoneTransform(index,v);
            sum+=v.x*1.3+v.y*.7+v.z*.2;sumSq+=v.lengthSq();count++;
          }return {sum,sumSq,count};
        }
        const samples=[];
        for(const fraction of [0,.25,.5,.75,1]){
          const snapshot=n.seek(entry.duration*fraction),target=n.retarget.snapshot();
          const allTransformsFinite=n.mesh.skeleton.bones.every(bone=>bone.matrixWorld.elements.every(Number.isFinite))&&n.clip.world.every(transform=>[...transform.p.toArray(),...transform.q.toArray(),...transform.s.toArray()].every(Number.isFinite));
          samples.push({fraction,time:snapshot.time,target,allTransformsFinite,sourceWorld:n.clip.world.map(t=>t.p.toArray()),sourceSkin:skins.map(skinHash),targetSkin:skinHash(n.mesh),lastStepMs:snapshot.lastStepMs});
        }
        const first=n.clip.frames[0],last=n.clip.frames.at(-1);
        const loopDelta={position:0,rotationRadians:0,scale:0};
        for(let index=0;index<first.length;index++){
          loopDelta.position=Math.max(loopDelta.position,first[index].p.distanceTo(last[index].p));
          loopDelta.rotationRadians=Math.max(loopDelta.rotationRadians,first[index].q.angleTo(last[index].q));
          loopDelta.scale=Math.max(loopDelta.scale,first[index].s.distanceTo(last[index].s));
        }
        const sourceMoves=samples.some(sample=>sample.sourceWorld.some((p,index)=>p.some((value,axis)=>Math.abs(value-samples[0].sourceWorld[index][axis])>1e-5)));
        const skinMoves=(key)=>samples.some(sample=>JSON.stringify(sample[key])!==JSON.stringify(samples[0][key]));
        const finite=samples.every(sample=>sample.allTransformsFinite&&[...Object.values(sample.target.bones).flat(),...sample.sourceWorld.flat(),sample.targetSkin.sum,sample.targetSkin.sumSq,...sample.sourceSkin.flatMap(skin=>[skin.sum,skin.sumSq])].every(Number.isFinite));
        return {id:entry.id,name:entry.name,category:entry.category,loop:entry.loop,duration:entry.duration,sourceFrames:n.clip.data.frameCount,sourceBones:n.clip.data.bones.length,mappedBones:n.retarget.mapping.length,
          finite,maxLengthError:Math.max(...samples.map(sample=>sample.target.maxLengthError)),sourceMoves,sourceSkinChanges:skinMoves('sourceSkin'),targetSkinChanges:skinMoves('targetSkin'),
          loopDelta,loopClosed:loopDelta.position<.02&&loopDelta.rotationRadians<.002&&loopDelta.scale<.002,
          samples:samples.map(({sourceWorld,...sample})=>sample)};
      },entry);
      assert.equal(audit.finite,true,entry.id);assert.ok(audit.maxLengthError<1e-6,`${entry.id}: target bone lengths changed`);
      assert.equal(audit.sourceFrames,entry.frameCount,entry.id);assert.equal(audit.sourceBones,entry.boneCount,entry.id);
      if(audit.sourceMoves){
        assert.equal(audit.sourceSkinChanges,true,`${entry.id}: bone motion did not reach source skin`);
        assert.equal(audit.targetSkinChanges,true,`${entry.id}: bone motion did not reach target skin`);
      }
      const frozen=await page.evaluate(duration=>{const n=window.nativeLibrary;n.pause(true);return n.seek(duration*.25);},entry.duration);
      await page.waitForTimeout(100);
      const still=await page.evaluate(()=>window.nativeLibrary.snapshot());near(still.time,frozen.time);assert.deepEqual(still.target.bones,frozen.target.bones,entry.id);
      await page.evaluate(()=>window.nativeLibrary.pause(false));await page.waitForTimeout(180);
      const resumed=await page.evaluate(()=>window.nativeLibrary.snapshot());assert.ok(resumed.time>frozen.time+.05,`${entry.id}: resume did not advance`);
      await page.evaluate(duration=>{const n=window.nativeLibrary;n.pause(true);n.seek(Math.max(0,duration-.05));n.pause(false);},entry.duration);
      await page.waitForTimeout(240);const ending=await page.evaluate(()=>window.nativeLibrary.snapshot());
      if(entry.loop){assert.equal(ending.playing,true,entry.id);assert.ok(ending.time<entry.duration-.05,`${entry.id}: loop did not wrap`);}
      else {assert.equal(ending.playing,false,`${entry.id}: one-shot did not stop`);near(ending.time,entry.duration);}
      audit.acceptance={fiveSamples:true,finitePose:true,constantLengths:true,sourceSkin:true,targetSkin:true,pauseFreeze:true,resume:true,ending:true};
      audits.push(audit);console.log(`${entry.id}: finite poses, constant lengths, skin, pause and ${entry.loop?'loop':'one-shot'} playback passed.`);
    }
    result.clips=audits;

    const first=clips[0],second=clips[1];
    const before=await page.evaluate(async({id,duration})=>{const n=window.nativeLibrary;await n.select(id);n.pause(true);return n.seek(duration*.37);},first);
    await page.evaluate(async({id,duration})=>{const n=window.nativeLibrary;await n.select(id);n.pause(true);n.seek(duration*.81);},second);
    const after=await page.evaluate(async({id,duration})=>{const n=window.nativeLibrary;await n.select(id);n.pause(true);return n.seek(duration*.37);},first);
    assert.deepEqual(after.target.bones,before.target.bones,'Returning to a clip must start from the original bind pose without accumulated transforms');
    result.switchRestoration={first:first.id,second:second.id,exactSamePose:true};

    // Stable form IDs make filtering verifiable without depending on Chinese labels.
    const search=page.locator('#search'),categories=page.locator('#categories');
    assert.equal(await search.count(),1,'Search control must exist');assert.equal(await categories.count(),1,'Category filter must exist');
    await search.fill('__no_such_native_motion__');
    assert.equal(await page.locator('#clip-list [data-clip-id]:visible').count(),0,'Search must hide unmatched clips');
    await search.fill('');
    await categories.locator(`[data-category="${first.category}"]`).click();
    const visibleIds=await page.locator('#clip-list [data-clip-id]:visible').evaluateAll(nodes=>nodes.map(node=>node.dataset.clipId));
    assert.ok(visibleIds.length>0);assert.ok(visibleIds.every(id=>clips.find(clip=>clip.id===id)?.category===first.category));
    await categories.locator('[data-category="all"]').click();
    assert.equal(await page.locator('#clip-list [data-clip-id]:visible').count(),clips.length);
    result.filters={search:true,category:true,restoredCount:clips.length};

    // Reload for visual evidence so a camera-only refinement made during the
    // longer full-library audit is included in the saved screenshots.
    await page.reload();
    await page.waitForFunction(()=>window.nativeLibrary?.snapshot().ready||window.nativeLibraryError,{},{timeout:120000});
    assert.equal(await page.evaluate(()=>window.nativeLibraryError),undefined);
    result.cameraFollow=await page.evaluate(async()=>{
      const n=window.nativeLibrary;
      await n.select('aimisi-salut01');n.pause(true);n.setView('angle');n.setFollow(true);
      const path=Array.from({length:9},(_,index)=>n.seek(n.clip.data.duration*index/8));
      const start=path[0],end=path.at(-1);
      const beforeToggle=n.snapshot(),off=n.setFollow(false),offStart=n.seek(0),offEnd=n.seek(n.clip.data.duration),on=n.setFollow(true);
      const poseUnaffected=JSON.stringify(beforeToggle.target.bones)===JSON.stringify(off.target.bones)&&JSON.stringify(offEnd.target.bones)===JSON.stringify(on.target.bones);
      const fixedOff=JSON.stringify(offStart.cameras)===JSON.stringify(offEnd.cameras);
      const travel=start.cameras.map((camera,index)=>({id:camera.id,focusDistance:Math.max(...path.flatMap(a=>path.map(b=>Math.hypot(...a.cameras[index].focus.map((v,axis)=>v-b.cameras[index].focus[axis]))))),startFocus:camera.focus,endFocus:end.cameras[index].focus}));
      await n.select('aimisi-sit01-loop');n.pause(true);n.seek(n.clip.data.duration*.5);n.setFollow(true);
      const sitting=n.snapshot();
      const visible=[];
      for(const camera of sitting.cameras){
        const points=camera.id==='source-stage'?['Bip001Head','Bip001Pelvis','Bip001LHand','Bip001RHand','Bip001LFoot','Bip001RFoot'].map(name=>n.clip.world[n.clip.indices.get(name)].p.clone().multiplyScalar(n.retarget.scale)):
          ['頭','腰','左手首','右手首','左足首','右足首'].map(name=>n.retarget.bones.get(name).getWorldPosition(n.clip.world[0].p.clone()));
        const host=document.getElementById(camera.id),aspect=host.clientWidth/host.clientHeight;
        const rotation=n.clip.world[0].q.clone().fromArray(camera.quaternion).invert(),tan=Math.tan(35*Math.PI/360);
        for(const point of points){
          point.sub(n.clip.world[0].p.clone().fromArray(camera.position)).applyQuaternion(rotation);
          visible.push({stage:camera.id,x:point.x/(-point.z*tan*aspect),y:point.y/(-point.z*tan),depth:-point.z});
        }
      }
      return {travel,poseUnaffected,fixedOff,offFocus:offEnd.cameras.map(camera=>camera.focus),sittingFocus:sitting.cameras.map(camera=>camera.focus),sittingProjectedPoints:visible};
    });
    assert.equal(result.cameraFollow.poseUnaffected,true,'Camera follow must not change bone poses');
    assert.equal(result.cameraFollow.fixedOff,true,'Disabled follow must keep the camera fixed while the character moves');
    assert.ok(result.cameraFollow.travel.every(row=>row.focusDistance>20),'Both cameras must follow Salut01 displacement');
    assert.ok(result.cameraFollow.offFocus.every(point=>JSON.stringify(point)==='[0,9,0]'));
    assert.ok(result.cameraFollow.sittingFocus.every(point=>point[1]<8.5),'Sitting poses should lower the full-body framing');
    assert.ok(result.cameraFollow.sittingProjectedPoints.every(point=>point.depth>0&&Math.abs(point.x)<1&&Math.abs(point.y)<1),'Sitting head, hips, hands and feet must remain in the frame');
    await page.screenshot({path:path.join(out,'library-sitting-follow.png'),fullPage:true});
    await page.evaluate(async({id,duration})=>{const n=window.nativeLibrary;await n.select(id);n.pause(true);n.seek(duration*.37);},first);
    for(const view of ['front','side','back','angle']){
      await page.evaluate(view=>window.nativeLibrary.setView(view),view);
      assert.equal((await page.evaluate(()=>window.nativeLibrary.snapshot())).view,view);
      await page.screenshot({path:path.join(out,`library-${view}.png`),fullPage:true});
    }
    result.visualSamples=[];
    for(const id of ['aimisi-salut01','aimisi-liaofa','aimisi-turn-right90']){
      const descriptor=clips.find(clip=>clip.id===id);if(!descriptor)continue;
      const snapshot=await page.evaluate(async({id,duration})=>{const n=window.nativeLibrary;await n.select(id);n.pause(true);n.setView('angle');return n.seek(duration*.68);},descriptor);
      await page.screenshot({path:path.join(out,`library-${id}.png`),fullPage:true});
      result.visualSamples.push({id,time:snapshot.time,view:snapshot.view});
    }
    result.final=await page.evaluate(()=>window.nativeLibrary.snapshot());
    result.requests=requests;result.acceptance={visualOnly,clipCount:audits.length,minimumSamplesPerClip:visualOnly?0:5,lazyLoading:true,staleSelection:!visualOnly&&fresh.length>=2,switchRestoration:true,filters:true,views:true};
    assert.deepEqual(errors,[],'Unexpected page exceptions');
    fs.writeFileSync(path.join(out,visualOnly?'browser-visual-acceptance.json':'browser-acceptance.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({acceptance:result.acceptance,nonClosingLoops:audits.filter(clip=>clip.loop&&!clip.loopClosed).map(clip=>({id:clip.id,delta:clip.loopDelta})),browserErrors:errors},null,2));
  }catch(error){
    result.failure={message:error.message,stack:error.stack,diagnostic:await page.evaluate(()=>({status:document.getElementById('status')?.textContent,error:window.nativeLibraryError,snapshot:window.nativeLibrary?.snapshot()})).catch(()=>null)};
    fs.writeFileSync(path.join(out,'browser-acceptance-failure.json'),JSON.stringify(result,null,2));
    await page.screenshot({path:path.join(out,'library-failure.png'),fullPage:true}).catch(()=>{});throw error;
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
