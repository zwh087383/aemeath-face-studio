const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const {chromium}=require(path.join(process.env.APPDATA,'npm/node_modules/@playwright/cli/node_modules/playwright'));
const root=path.resolve(__dirname,'../..');
const out=path.join(root,'outputs/skirt-binding-20261022');
const url=process.env.NATIVE_RESOURCES_URL||'http://127.0.0.1:18792/native-resources/';
const output=path.join(out,'browser-skirt-acceptance.json');
const runningOutput=path.join(out,`browser-skirt-running-${Date.now()}.json`);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Node-side polling intentionally avoids Playwright's RAF/WaitTask readiness.
// Every iteration reads a small result through CDP. An independent headless
// Chrome process is used; the user's browser and on-disk PMX are never edited.
async function poll(page,predicate,{timeout=180000,label='condition'}={}){
  const started=Date.now();let last,reported=0;
  while(Date.now()-started<timeout){
    last=await page.evaluate(predicate);
    if(last?.error)throw Error(`${label}: ${last.error}`);
    if(last?.ready)return last;
    const elapsed=Math.floor((Date.now()-started)/1000);
    if(elapsed>=reported+20){reported=elapsed;console.log(`Waiting for ${label}: ${elapsed}s`);}
    await delay(250);
  }
  // A busy renderer may become ready at the boundary. Check the actual state
  // once more, rather than treating an expired polling budget as product failure.
  last=await page.evaluate(predicate);
  if(last?.ready&&!last.error)return {...last,readyAtBudgetBoundary:true};
  throw Error(`${label} did not become ready within ${timeout}ms: ${JSON.stringify(last)}`);
}

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const {Parser}=await import(pathToFileURL(path.join(root,'preview/node_modules/mmd-parser/build/mmdparser.module.mjs')).href);
  const pmxPath=path.join(root,'assets/Aemeath/鸣潮_爱弥斯1.05.pmx'),pmxBytes=fs.readFileSync(pmxPath);
  const pmx=new Parser().parsePmx(pmxBytes.buffer.slice(pmxBytes.byteOffset,pmxBytes.byteOffset+pmxBytes.byteLength),true);
  const skirtPattern=/^(?:スカート_\d+_\d+|[左右]侧裙_\d+_\d+|[左右]裙[A-D])$/;
  const skirtBones=new Set(pmx.bones.map((bone,index)=>skirtPattern.test(bone.name)?index:-1).filter(index=>index>=0));
  const expectedVertices=pmx.vertices.map((vertex,index)=>vertex.skinIndices.some((bone,k)=>skirtBones.has(bone)&&vertex.skinWeights[k]>1e-7)?index:-1).filter(index=>index>=0);
  const correspondencePath=path.join(out,'vertex-correspondence.json');
  const correspondenceSummary=fs.existsSync(correspondencePath)?JSON.parse(fs.readFileSync(correspondencePath,'utf8')).summary:null;
  assert.equal(expectedVertices.length,8856,'Independent raw PMX bone names and positive skin weights must identify 8856 cloth vertices');
  assert.equal(new Set(expectedVertices).size,expectedVertices.length);
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist',
    '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  const page=await browser.newPage({viewport:{width:1580,height:1080}});
  const errors=[],result={schema:1,url,startedAt:new Date().toISOString(),
    evidence:'Real local clips and PMX CPU skinning in independent Chrome; original and native cloth weights switched through the public preview control. The untouched raw PMX independently defines the skirt mask through explicit bone names and positive skin weights; no private correspondence generator is required. No cloud calls.',
    independentMask:{source:'raw PMX 1.05',pattern:skirtPattern.source,minimumWeight:1e-7,skirtBones:skirtBones.size,vertices:expectedVertices.length},
    optionalCorrespondenceSummary:correspondenceSummary,browserErrors:errors,checks:[],screenshots:[]};
  page.on('pageerror',error=>errors.push(error.message));
  const save=()=>fs.writeFileSync(runningOutput,JSON.stringify(result,null,2));
  const check=(name,data)=>{result.checks.push({name,...data});save();console.log(`PASS ${name}`);};
  const select=id=>page.evaluate(async id=>{await window.nativeResources.select(id);return window.nativeResources.pause(true);},id);
  try{
    console.log('Independent Chrome launched; polling model and cloth readiness from Node.');
    await page.goto(url);await page.bringToFront();
    result.readiness=await poll(page,()=>{const n=window.nativeResources,s=n?.snapshot();return {ready:Boolean(s?.ready),error:window.nativeResourcesError??s?.error??null,status:document.getElementById('status')?.textContent};},{label:'both model renderers'});
    const initial=await page.evaluate(()=>window.nativeResources.pause(true));
    assert.ok(await page.evaluate(()=>typeof window.nativeResources.setClothEnabled==='function'&&Boolean(window.nativeResources.cloth)),'Preview must expose its real cloth binding and public toggle');
    assert.ok(initial.cloth,'Snapshot must expose cloth diagnostics');
    const manifest=await page.evaluate(async()=>{const r=await fetch('/native-resources-data/manifest.json');if(!r.ok)throw Error('manifest');return r.json();});
    const body=name=>manifest.clips.find(row=>row.resourceKind==='body'&&(row.id===name||row.name===name));
    const stand=body('Stand2'),cheek=body('aimisi-cheek01');assert.ok(stand&&cheek);
    assert.equal(initial.currentId,stand.id);assert.equal(initial.cloth.enabled,true);assert.equal(initial.cloth.active,true);
    assert.equal(initial.layers.find(row=>row.kind==='ribbon')?.automatic,true);
    check('default authored Stand2 companion and native skirt are active',{id:initial.currentId,cloth:initial.cloth,layers:initial.layers,environment:initial.environment});

    await page.evaluate(expectedVertices=>{
      const n=window.nativeResources,mesh=n.mesh,mask=new Set(expectedVertices),a=mesh.geometry.attributes;
      if(expectedVertices.some(index=>index<0||index>=a.position.count))throw Error('Independent skirt mask references an invalid vertex');
      const pelvis=mesh.skeleton.bones.find(b=>b.name==='腰');if(!pelvis)throw Error('Missing pelvis');
      const vector=n.clip.world[0].p.clone();
      const originalBones=mesh.skeleton.bones.filter(b=>!b.userData.nativeClothVirtual);
      const bytes=attribute=>new Uint8Array(attribute.array.buffer,attribute.array.byteOffset,attribute.array.byteLength).slice();
      function weights(){return {index:bytes(a.skinIndex),weight:bytes(a.skinWeight),indexStride:a.skinIndex.itemSize*a.skinIndex.array.BYTES_PER_ELEMENT,weightStride:a.skinWeight.itemSize*a.skinWeight.array.BYTES_PER_ELEMENT};}
      function byteDifferences(first,current,indices){let count=0;for(const vertex of indices)for(let k=0;k<first.indexStride;k++)if(first.index[vertex*first.indexStride+k]!==current.index[vertex*current.indexStride+k])count++;for(const vertex of indices)for(let k=0;k<first.weightStride;k++)if(first.weight[vertex*first.weightStride+k]!==current.weight[vertex*current.weightStride+k])count++;return count;}
      function changedVertices(first,current){const changed=[];for(let vertex=0;vertex<a.position.count;vertex++){let different=false;for(let k=0;k<first.indexStride;k++)different||=first.index[vertex*first.indexStride+k]!==current.index[vertex*current.indexStride+k];for(let k=0;k<first.weightStride;k++)different||=first.weight[vertex*first.weightStride+k]!==current.weight[vertex*current.weightStride+k];if(different)changed.push(vertex);}return changed;}
      function pose(){return originalBones.flatMap(bone=>bone.matrixWorld.elements);}
      function maxError(first,current){if(first.length!==current.length)return Infinity;let error=0;for(let i=0;i<first.length;i++)error=Math.max(error,Math.abs(first[i]-current[i]));return error;}
      function capture(){
        const inverse=pelvis.matrixWorld.clone().invert(),points=[];
        for(const index of expectedVertices){vector.fromBufferAttribute(a.position,index);mesh.applyBoneTransform(index,vector);mesh.localToWorld(vector);vector.applyMatrix4(inverse);points.push(vector.x,vector.y,vector.z);}
        return {points,pose:pose(),finite:points.every(Number.isFinite)&&mesh.skeleton.bones.every(b=>b.matrixWorld.elements.every(Number.isFinite)),maxLengthError:n.retarget.snapshot().maxLengthError};
      }
      function displacement(first,current){let maximum=0,total=0;for(let i=0;i<first.length;i+=3){const d=Math.hypot(first[i]-current[i],first[i+1]-current[i+1],first[i+2]-current[i+2]);maximum=Math.max(maximum,d);total+=d;}return {maximum,mean:total/(first.length/3)};}
      function sample(enabled){n.pause(true);n.setClothEnabled(enabled);const rows=[];for(let j=0;j<=8;j++){const fraction=j/8;n.seek(n.clip.data.duration*fraction);rows.push({fraction,time:n.snapshot().time,...capture()});}const first=rows[0];return {enabled:n.snapshot().cloth.enabled,active:n.snapshot().cloth.active,finite:rows.every(row=>row.finite),maxLengthError:Math.max(...rows.map(row=>row.maxLengthError)),maxDisplacement:Math.max(...rows.map(row=>displacement(first.points,row.points).maximum)),maxMeanDisplacement:Math.max(...rows.map(row=>displacement(first.points,row.points).mean)),samples:rows.map(row=>({fraction:row.fraction,time:row.time,...displacement(first.points,row.points)})),_rows:rows};}
      function compare(){const old=sample(false),current=sample(true);let originalBoneError=0;const samples=current._rows.map((row,i)=>{originalBoneError=Math.max(originalBoneError,maxError(old._rows[i].pose,row.pose));return {fraction:row.fraction,time:row.time,...displacement(old._rows[i].points,row.points)};});const peak=samples.reduce((best,row)=>row.maximum>best.maximum?row:best,samples[0]);delete old._rows;delete current._rows;return {old,current,originalBoneError,skirtVertices:expectedVertices.length,originalBones:originalBones.length,skinDifference:Math.max(...samples.map(row=>row.maximum)),skinMeanDifference:Math.max(...samples.map(row=>row.mean)),samples,peak,cloth:n.snapshot().cloth};}
      window.__skirtAudit={weights,bytes,byteDifferences,changedVertices,pose,maxError,capture,displacement,sample,compare,expectedVertices,mask,originalBones};
    },expectedVertices);

    // Capture original weights through the actual visible control, then enable
    // native skinning. Check every unselected vertex byte, not only sampled hashes.
    const weights=await page.evaluate(()=>{
      const n=window.nativeResources,a=window.__skirtAudit,attributes=n.mesh.geometry.attributes;
      n.pause(true);n.seek(.75);n.setClothEnabled(false);
      const old=a.weights(),oldPose=a.pose(),positions=a.bytes(attributes.position);
      n.setClothEnabled(true);const current=a.weights(),currentPose=a.pose();
      const changed=a.changedVertices(old,current),outside=Array.from({length:attributes.position.count},(_,i)=>i).filter(i=>!a.mask.has(i));
      const changedOutside=changed.filter(index=>!a.mask.has(index));
      const positionBytes=a.bytes(attributes.position);let positionByteChanges=0;for(let i=0;i<positions.length;i++)if(positions[i]!==positionBytes[i])positionByteChanges++;
      n.setClothEnabled(false);const restored=a.weights();n.setClothEnabled(true);
      return {vertexCount:attributes.position.count,expected:a.expectedVertices.length,changed:changed.length,changedOutside,
        nonSkirtByteChanges:a.byteDifferences(old,current,outside),restoredByteChanges:a.byteDifferences(old,restored,Array.from({length:attributes.position.count},(_,i)=>i)),
        originalBoneMatrixError:a.maxError(oldPose,currentPose),originalBones:a.originalBones.length,positionByteChanges,
        oldIndexStride:old.indexStride,newIndexStride:current.indexStride,oldWeightStride:old.weightStride,newWeightStride:current.weightStride,
        cloth:n.snapshot().cloth};
    });
    assert.equal(weights.changed,expectedVertices.length);assert.deepEqual(weights.changedOutside,[]);assert.equal(weights.nonSkirtByteChanges,0);assert.equal(weights.restoredByteChanges,0);
    assert.equal(weights.positionByteChanges,0);assert.ok(weights.originalBoneMatrixError<1e-7);assert.equal(weights.originalBones,915);
    assert.equal(weights.oldIndexStride,weights.newIndexStride);assert.equal(weights.oldWeightStride,weights.newWeightStride);
    check('exact skirt mask changes while original geometry non-skirt weights and 915 bones are preserved',weights);
    await page.locator('#native-skirt').uncheck();assert.equal(await page.evaluate(()=>window.nativeResources.snapshot().cloth.enabled),false);
    await page.locator('#native-skirt').check();assert.equal(await page.evaluate(()=>window.nativeResources.snapshot().cloth.enabled),true);
    check('visible old and native skirt switch controls the live binding',{checkbox:'#native-skirt',offThenOn:true});

    const comparisons=[];
    for(const entry of [stand,cheek,body('aimisi-turn-left90'),body('aimisi-turn-right90'),body('sit_headmove_01_Loop')].filter(Boolean)){
      const selected=await select(entry.id);assert.equal(selected.currentId,entry.id);assert.equal(selected.error,null);
      const comparison=await page.evaluate(()=>window.__skirtAudit.compare());
      assert.equal(comparison.current.enabled,true);assert.equal(comparison.current.active,true);assert.equal(comparison.old.active,false);assert.ok(comparison.current.finite&&comparison.old.finite);assert.equal(comparison.current.maxLengthError,0);assert.ok(comparison.originalBoneError<1e-7);
      if(entry.id===stand.id){assert.ok(comparison.current.maxDisplacement>.01,'Authored idle ribbon must actually move skirt skin relative to the pelvis');assert.ok(comparison.skinDifference>.01,'Native skirt skin must visibly differ from the old rigid weights');}
      comparisons.push({id:entry.id,...comparison});check(`real skirt skin old and native ${entry.id}`,{id:entry.id,...comparison});
    }
    const preview=comparisons.find(row=>row.id===stand.id);await select(stand.id);
    for(const enabled of [false,true]){
      await page.evaluate(({enabled,time})=>{const n=window.nativeResources;n.pause(true);n.setClothEnabled(enabled);n.seek(time);document.querySelector('#target-section .label span').textContent=enabled?'修复后：原生裙片蒙皮驱动':'旧版：原始 PMX 裙片权重';},{enabled,time:preview.peak.time});
      for(const view of ['back','side']){await page.evaluate(view=>window.nativeResources.setView(view),view);const filename=`stand2-skirt-${enabled?'native':'old'}-${view}.png`;await page.locator('#comparison').screenshot({path:path.join(out,filename)});result.screenshots.push(filename);}
    }

    const deterministic=await page.evaluate(()=>{const n=window.nativeResources,a=window.__skirtAudit;n.pause(true);n.setClothEnabled(true);n.seek(.5);const first=a.capture();for(const time of [3.1,.1,2.4,.5])n.seek(time);const second=a.capture();return {skinError:a.displacement(first.points,second.points),boneError:a.maxError(first.pose,second.pose),cloth:n.snapshot().cloth};});
    assert.ok(deterministic.skinError.maximum<1e-7);assert.ok(deterministic.boneError<1e-7);
    const paused=await page.evaluate(()=>({time:window.nativeResources.pause(true).time,skin:window.__skirtAudit.capture().points}));await delay(300);
    const still=await page.evaluate(()=>({time:window.nativeResources.snapshot().time,skin:window.__skirtAudit.capture().points}));assert.equal(still.time,paused.time);assert.deepEqual(still.skin,paused.skin);
    await page.evaluate(()=>{window.nativeResources.seek(3.9);window.nativeResources.pause(false);});
    await poll(page,()=>({ready:window.nativeResources.snapshot().cycleOffset>=4,error:window.nativeResources.snapshot().error}),{timeout:15000,label:'authored idle loop'});
    const loop=await page.evaluate(()=>window.nativeResources.pause(true));assert.equal(loop.cloth.enabled,true);assert.equal(loop.cloth.active,true);
    check('native skirt pause seeks backward and authored loop are deterministic',{deterministic,pausedMilliseconds:300,loopOffset:loop.cycleOffset,cloth:loop.cloth});
    const cleared=await page.evaluate(()=>{const n=window.nativeResources,a=window.__skirtAudit;n.seek(1.2);const before=a.pose(),beforeBody=n.retarget.snapshot().bones;n.clearLayers();return {bodyHairChange:a.maxError(before,a.pose()),beforeBody,afterBody:n.retarget.snapshot().bones,layers:n.snapshot().layers,cloth:n.snapshot().cloth,finite:a.capture().finite};});
    // Clearing an authored ribbon can change hair and cloth by design. The
    // protected body joints must retain the current body pose; compare only those.
    assert.deepEqual(cleared.beforeBody,cleared.afterBody);assert.equal(cleared.layers.length,0);assert.ok(cleared.finite);assert.equal(cleared.cloth.enabled,true);assert.equal(cleared.cloth.active,true);
    const {beforeBody,afterBody,...clearSummary}=cleared;
    check('clearing authored layers preserves body and a valid skirt binding',{...clearSummary,bodyPoseUnchanged:true});

    for(const entry of manifest.clips.filter(row=>row.resourceKind==='body'&&row.boneCount===197)){
      const selected=await select(entry.id);assert.equal(selected.currentId,entry.id);assert.equal(selected.error,null);
      const fallback=await page.evaluate(()=>{const n=window.nativeResources,a=window.__skirtAudit;n.setClothEnabled(true);const s=n.snapshot(),finite=a.capture().finite;n.setClothEnabled(false);const old=a.weights();n.setClothEnabled(true);const current=a.weights();return {cloth:s.cloth,finite,changedAfterRequestedEnable:a.changedVertices(old,current).length,longHair:n.retarget.snapshot().nativeLongHairMapped};});
      assert.equal(fallback.cloth.enabled,true);assert.equal(fallback.cloth.active,false);assert.equal(fallback.changedAfterRequestedEnable,0);assert.ok(fallback.finite);assert.equal(fallback.longHair,0);
      check(`missing skirt tracks safely preserve original weights ${entry.id}`,{id:entry.id,...fallback});
    }
    await select(stand.id);const recovered=await page.evaluate(()=>window.nativeResources.setClothEnabled(true));assert.equal(recovered.cloth.enabled,true);assert.equal(recovered.cloth.active,true);
    check('compatible body after shared walking restores native skirt',{id:recovered.currentId,cloth:recovered.cloth});
    assert.equal(errors.length,0);result.passed=true;result.finishedAt=new Date().toISOString();save();fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,checks:result.checks.length,screenshots:result.screenshots,output}));
  }catch(error){
    result.passed=false;result.failure={message:error.message,stack:error.stack};
    try{result.failure.page=await page.evaluate(()=>{const s=window.nativeResources?.snapshot();return {status:document.getElementById('status')?.textContent,ready:s?.ready,currentId:s?.currentId,error:s?.error,cloth:s?.cloth};});}catch(diagnostic){result.failure.diagnosticError=diagnostic.message;}
    // Failed attempts receive separate names; never replace successful evidence.
    const failed=path.join(out,`browser-skirt-failed-${Date.now()}.json`);fs.writeFileSync(failed,JSON.stringify(result,null,2));console.error(`Failure evidence: ${failed}`);throw error;
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
