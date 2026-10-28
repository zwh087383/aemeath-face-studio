import * as THREE from 'three';
import {captureNativePose,cloneNativePose,applyNativePose,finiteNativePose} from '../../preview/core/native-behavior.js';
import {buildFullBodyRig,solveLegTargets} from '../../preview/core/full-body-ik.js';
import {sampleActivity} from '../../preview/core/activity-library.js';

const SIDES=['L','R'],UP=new THREE.Vector3(0,1,0),smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
const names={pelvis:'腰',head:'頭',chest:'上半身2',upperChest:'上半身1',lowerBody:'下半身',
  leftAnkle:'左足首',rightAnkle:'右足首',leftKnee:'左ひざ',rightKnee:'右ひざ',leftElbow:'左ひじ',rightElbow:'右ひじ',
  leftWrist:'左手首',rightWrist:'右手首'};
const sideName=side=>side==='L'?'left':'right';
const yaw=q=>{const f=new THREE.Vector3(0,0,1).applyQuaternion(q);return Math.atan2(f.x,f.z);};
const fail=reason=>{throw Error(reason);};

/** Source motion plus scene-specific support. A prepare transaction samples the
 * real PMX and real furniture without replacing the displayed pose. Numerical
 * contacts are explicit evidence; they do not certify skirt/hair clearance or
 * subjective naturalness. Upper-body source curves keep their original clock. */
export function createNativeSceneDriver({mesh,source,nativeAdapter,body,byName,skeleton,avatarRoot,getProps}) {
  if(!nativeAdapter) return {preparePlan:()=>({accepted:false,reason:'native_adapter_missing'}),measureState:()=>null,validateTerminal:()=>({ok:false,reason:'native_adapter_missing'})};
  const nodes=nativeAdapter.nodes,rig=body?.rig??buildFullBodyRig(skeleton),rest=new Map(nativeAdapter.targetRest.map(r=>[r.node.name,r]));
  const footY=Object.fromEntries(SIDES.map(s=>[s,skeleton.get(s==='L'?'左足首':'右足首').position[1]]));
  const seatOffset=skeleton.get('腰').position[1]+sampleActivity('sit_listen',0,{...body?.context,seatHeight:0}).pelvis.offset[1];
  let active=null,lastEvidence=null;
  const preparedContexts=new WeakMap();
  const bone=name=>byName.get(name),position=name=>bone(name).getWorldPosition(new THREE.Vector3());
  const update=()=>{source.updateMatrixWorld(true);avatarRoot?.updateMatrixWorld(true);mesh.updateMatrixWorld(true);mesh.skeleton.update();};
  const physical=()=>{update();return Object.fromEntries(Object.entries(names).filter(([,name])=>bone(name)).map(([key,name])=>[key,position(name)]));};
  const propsObject=()=>getProps?.();
  function surface(id,part) {
    const object=propsObject()?.objects?.[id];if(!object?.visible)return null;
    const meshPart=object.getObjectByName(part);if(!meshPart)return null;object.updateMatrixWorld(true);
    meshPart.geometry.computeBoundingBox();
    return {object,part:meshPart,box:new THREE.Box3().setFromObject(meshPart),local:meshPart.geometry.boundingBox.clone(),inverse:meshPart.matrixWorld.clone().invert()};
  }
  const inside=(point,surface,margin=.15)=>{const p=point.clone().applyMatrix4(surface.inverse);return p.x>=surface.local.min.x+margin&&p.x<=surface.local.max.x-margin&&p.z>=surface.local.min.z+margin&&p.z<=surface.local.max.z-margin;};
  const snapshot=()=>({pose:captureNativePose(nodes),id:nativeAdapter.lastId,names:new Set(nativeAdapter.availableSourceNames)});
  const restore=value=>{applyNativePose(nodes,value.pose);nativeAdapter.lastId=value.id;nativeAdapter.availableSourceNames=value.names;update();nativeAdapter.cloth?.apply({availableSourceNames:value.names});};

  function worldTransform(pose,matrix) {
    const result=cloneNativePose(pose);
    for(const index of [0,1]) {
      const node=nodes[index],parent=node.parent?.matrixWorld??new THREE.Matrix4();node.parent?.updateMatrixWorld(true);
      const local=new THREE.Matrix4().compose(result[index].p,result[index].q,result[index].s);
      const transformed=parent.clone().invert().multiply(matrix).multiply(parent).multiply(local);
      transformed.decompose(result[index].p,result[index].q,result[index].s);
    }
    return result;
  }
  function move(pose,offset) {return worldTransform(pose,new THREE.Matrix4().makeTranslation(...offset));}
  function raw(id,t) {const pose=nativeAdapter.sample(id,t);nativeAdapter.apply(pose);return {pose,points:physical()};}
  function localsFromDisplay() {
    const locals=new Map();locals.translations=new Map();
    for(const [name,r] of rest){locals.set(name,r.q.clone().invert().multiply(r.node.quaternion).normalize().toArray());
      if(name===rig.support.root)locals.translations.set(name,r.node.position.clone().sub(r.p).toArray());}
    return locals;
  }
  function solveFeet(goals) {
    const rootP=mesh.getWorldPosition(new THREE.Vector3()),rootQ=mesh.getWorldQuaternion(new THREE.Quaternion());
    const root={position:rootP.toArray(),yaw:yaw(rootQ)},locals=localsFromDisplay(),points=physical();
    for(const s of SIDES){const knee=points[sideName(s)+'Knee'],hip=position(rig.legs[s].names.hip);
      goals[s].pole=knee.clone().sub(hip).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(UP,-root.yaw)).toArray();}
    const diagnostics=solveLegTargets(rig,locals,goals,root);
    for(const s of SIDES)for(const key of ['hip','knee','ankle']){const name=rig.legs[s].names[key],r=rest.get(name);r.node.quaternion.copy(r.q).multiply(new THREE.Quaternion().fromArray(locals.get(name)));}
    update();
    // The native host disables MMD grants. Keep duplicate deform chains in the
    // same attained world orientation, rather than letting D-bones keep an old leg.
    for(const prefix of ['左','右'])for(const [main,extra] of [['足','足D'],['ひざ','ひざD'],['足首','足首D'],['足首','足先EX']]){
      const a=bone(prefix+main),b=bone(prefix+extra);if(a&&b){const q=a.getWorldQuaternion(new THREE.Quaternion()),parent=b.parent.getWorldQuaternion(new THREE.Quaternion());b.quaternion.copy(parent.invert().multiply(q));b.updateMatrixWorld(true);}}
    return diagnostics;
  }
  function supportProjection(goals,{seatLocked=false}={}) {
    // Retargeted limbs are shorter than the source limbs. Preserve all source
    // joint curves while moving the root just enough to satisfy actual reach;
    // never stretch the bones or call a clamped IK goal a planted contact.
    let lower=-Infinity,upper=Infinity;
    for(const side of SIDES){const hip=position(rig.legs[side].names.hip),goal=new THREE.Vector3(...goals[side].position),leg=rig.legs[side],reach=leg.L1+leg.L2-.015;
      const horizontal=Math.hypot(goal.x-hip.x,goal.z-hip.z);
      if(horizontal>=reach){if(goals[side].contact){const error=Error('native_contact_outside_leg_reach');error.details={side,horizontal,reach,hip:hip.toArray(),goal:goal.toArray()};throw error;}continue;}
      const vertical=Math.sqrt(reach*reach-horizontal*horizontal);
      lower=Math.max(lower,goal.y-vertical-hip.y);upper=Math.min(upper,goal.y+vertical-hip.y);
    }
    if(lower>upper)fail('native_support_constraints_conflict');
    const dy=seatLocked?0:Math.max(lower,Math.min(upper,0));
    if(Math.abs(dy)>1e-6){nativeAdapter.apply(move(captureNativePose(nodes),[0,dy,0]));}
    return dy;
  }
  function interpolate(frames,time) {
    const last=frames.at(-1),at=Math.min(frames.length-1,time/last.time*(frames.length-1)),i=Math.floor(at),j=Math.min(i+1,frames.length-1),k=at-i;
    const a=frames[i],b=frames[j],lerp=(x,y)=>x.map((v,n)=>v+(y[n]-v)*k);
    return {travel:lerp(a.travel,b.travel),seatWeight:a.seatWeight+(b.seatWeight-a.seatWeight)*k,
      feet:Object.fromEntries(SIDES.map(s=>[s,{position:lerp(a.feet[s].position,b.feet[s].position),rotation:new THREE.Quaternion().fromArray(a.feet[s].rotation).slerp(new THREE.Quaternion().fromArray(b.feet[s].rotation),k).toArray(),contact:a.feet[s].contact&&b.feet[s].contact}]))};
  }
  function sceneFootsteps(context,data) {
    // A source walk-to-seat is redirected to the actual chair. Its old planted
    // feet cannot stay at the old scene coordinates while the pelvis approaches
    // the new seat. Gather each foot with a real lift, one at a time; upper body
    // and source time are untouched.
    const first=data.samples[0].points.pelvis,initial=Object.fromEntries(SIDES.map(s=>[s,new THREE.Vector3(...data.frames[0].feet[s].position)]));
    const anchors=Object.fromEntries(SIDES.map(s=>[s,initial[s].clone()]));let swing=null,nextSide='L';
    const desired=(index,side)=>{
      const sample=data.samples[index],frame=data.frames[index],hip=sample.points.pelvis.clone().add(new THREE.Vector3(...frame.travel)).addScaledVector(context.seatShift,frame.seatWeight);
      const p=initial[side].clone().add(hip.clone().sub(first));p.y=footY[side];
      if(frame.seatWeight>.7&&context.chair){const center=context.chair.box.getCenter(new THREE.Vector3()),seated=new THREE.Vector3(center.x+(side==='L'?1.14:-1.14),footY[side],center.z+4.5);p.lerp(seated,smooth((frame.seatWeight-.7)/.3));}
      return p;
    };
    for(let i=0;i<data.frames.length;i++){
      const frame=data.frames[i],time=frame.time;
      if(swing&&time>=swing.end){anchors[swing.side]=swing.to.clone();nextSide=swing.side==='L'?'R':'L';swing=null;}
      if(!swing){
        const distances=Object.fromEntries(SIDES.map(s=>[s,anchors[s].distanceTo(desired(i,s))]));
        const side=distances[nextSide]>.65?nextSide:SIDES.find(s=>distances[s]>1.5);
        if(side){const future=Math.min(data.frames.length-1,i+Math.ceil(.42/(data.frames[1].time-data.frames[0].time))),target=desired(future,side);
          swing={side,from:anchors[side].clone(),to:target,start:time,end:time+.42};}
      }
      for(const side of SIDES){const p=anchors[side].clone(),moving=swing?.side===side;
        if(moving){const u=(time-swing.start)/(swing.end-swing.start);p.lerp(swing.to,smooth(u));p.y+=.65*Math.sin(Math.PI*u)**2;}
        frame.feet[side]={...frame.feet[side],position:p.toArray(),contact:!moving};
      }
    }
  }
  function* inspectRoute(context,checkpoint,repeat=1){
    if(context.def.lifecycle.contactMode!=='root-motion')return;
    const obstacles=['table','chair','box','platform'].map(id=>({id,object:propsObject()?.objects?.[id]})).filter(row=>row.object?.visible)
      .map(row=>({...row,box:new THREE.Box3().setFromObject(row.object).expandByVector(new THREE.Vector3(1.1,0,1.1))}));
    if(!obstacles.length)return;
    const insideXZ=(p,box)=>p.x>box.min.x&&p.x<box.max.x&&p.z>box.min.z&&p.z<box.max.z;
    let outgoing=context.entryHip.clone(),outgoingYaw=context.entryYaw;
    const initiallyInside=new Set(obstacles.filter(o=>insideXZ(outgoing,o.box)).map(o=>o.id));
    const seatedContact=new Set();
    for(const phase of context.plan){const data=context.phases.get(phase.id),count=phase.phase==='loop'?repeat:1;
      const at=index=>data.samples[index].points.pelvis.clone().add(new THREE.Vector3(...data.frames[index].travel)).addScaledVector(context.seatShift,data.frames[index].seatWeight);
      for(let cycle=0;cycle<count;cycle++){
        const rotation=new THREE.Quaternion().setFromAxisAngle(UP,outgoingYaw-data.samples[0].yaw),offset=outgoing.clone().sub(at(0).applyQuaternion(rotation));
        for(let i=0;i<data.samples.length;i++){
          const p=at(i).applyQuaternion(rotation).add(offset);
          for(const obstacle of obstacles){
            const inside=insideXZ(p,obstacle.box);
            if(!inside){initiallyInside.delete(obstacle.id);seatedContact.delete(obstacle.id);continue;}
            const authorizedSeat=obstacle.id==='chair'&&context.def.requires.props.includes('chair')&&data.frames[i].seatWeight>.45;
            if(authorizedSeat)seatedContact.add(obstacle.id);
            // A rise starts over the seat it actually occupied. Permit only
            // the upward/front exit from that established contact until clear;
            // this does not authorize approaching through the chair's back.
            const local=context.chair?p.clone().applyMatrix4(context.chair.inverse):null;
            const leavingSeat=obstacle.id==='chair'&&seatedContact.has(obstacle.id)&&local
              &&local.z>=context.chair.local.getCenter(new THREE.Vector3()).z-.15
              &&p.y>=context.chair.box.max.y+seatOffset-.35;
            if(!initiallyInside.has(obstacle.id)&&!authorizedSeat&&!leavingSeat){const error=Error('native_route_blocked_by_'+obstacle.id);error.details={obstacle:obstacle.id,phase:phase.id,cycle,sourceTime:data.samples[i].time,pelvis:p.toArray()};throw error;}
          }
          if(i%12===0)yield* checkpoint();
        }
        outgoing=at(data.samples.length-1).applyQuaternion(rotation).add(offset);outgoingYaw=data.samples.at(-1).yaw+(outgoingYaw-data.samples[0].yaw);
      }
    }
  }
  function calibratedRaw(context,id,t) {
    const sampled=raw(id,t),phase=context.phases.get(id),frame=interpolate(phase.frames,t);
    let pose=worldTransform(sampled.pose,context.matrix);
    pose=move(pose,[frame.travel[0]+context.seatShift.x*frame.seatWeight,context.seatShift.y*frame.seatWeight,frame.travel[2]+context.seatShift.z*frame.seatWeight]);
    nativeAdapter.apply(pose);
    const sourceLinks=captureSourceLinks(id);
    const goals=structuredClone(frame.feet);
    if(context.keyboard){
      nativeAdapter.apply(move(captureNativePose(nodes),[0,-(context.keyboardDrop??1.2),0]));
      bone('上半身').quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),context.keyboardLean??.65));update();
    }
    const supportShift=supportProjection(goals,{seatLocked:context.def.lifecycle.entrySupport==='seated'&&context.def.lifecycle.exitSupport==='seated'||frame.seatWeight>.95&&context.def.lifecycle.middleSupport==='seated'}),diagnostics=solveFeet(goals);
    context.maximumSupportCorrection=Math.max(context.maximumSupportCorrection??0,Math.abs(supportShift));
    if(context.tableLean){const spec=context.plan.find(p=>p.id===id),weight=spec.phase==='start'?smooth(t/spec.duration):spec.phase==='end'?1-smooth(t/spec.duration):1;
      bone('上半身').quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),context.tableLean*weight));update();}
    if(context.keyboard)calibrateKeyboard(context,id,t);
    syncSourceLinks(sourceLinks);
    const output=captureNativePose(nodes);if(!finiteNativePose(output))fail('native_nonfinite_scene_pose');
    return {pose:output,diagnostics,frame};
  }
  function captureSourceLinks(id) {
    const allowed=new Set(['腰','上半身','上半身2','上半身1','首','頭',...['左','右'].flatMap(p=>['足','ひざ','足首','腕','ひじ','手首'].map(n=>p+n))]);
    const used=new Set(),links=[];for(const row of nativeAdapter.rows.get(id).retarget.mapping){
      if(!allowed.has(row.bone.name)||used.has(row.source))continue;used.add(row.source);
      const node=source.getObjectByName(nativeAdapter.rows.get(id).clip.data.bones[row.source].name);if(node)links.push({node,target:row.bone,
        sourceQ:node.getWorldQuaternion(new THREE.Quaternion()),targetQ:row.bone.getWorldQuaternion(new THREE.Quaternion())});
    }return links;
  }
  function syncSourceLinks(links) {
    const goals=links.map(row=>({...row,q:row.target.getWorldQuaternion(new THREE.Quaternion()).multiply(row.targetQ.clone().invert()).multiply(row.sourceQ)}));
    for(const row of goals){const parent=row.node.parent?.getWorldQuaternion(new THREE.Quaternion())??new THREE.Quaternion();row.node.quaternion.copy(parent.invert().multiply(row.q));row.node.updateMatrixWorld(true);}
    source.updateMatrixWorld(true);
  }
  function* fitTable(context,checkpoint) {
    if(context.def.lifecycle.contactMode!=='table-contact'||context.keyboard)return;
    const phase=context.plan.find(p=>p.phase==='loop')??context.plan[0],base=calibratedRaw(context,phase.id,phase.duration*.5).pose;
    let best={score:Infinity,angle:0};
    for(let i=0;i<=44;i++){
      const angle=-.55+i*.025;nativeAdapter.apply(base);bone('上半身').quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),angle));update();
      const table=context.table;
      for(const key of ['左ひじ','右ひじ']){const p=position(key),local=p.clone().applyMatrix4(table.inverse);
        const outside=Math.max(0,table.local.min.x-local.x,local.x-table.local.max.x)+Math.max(0,table.local.min.z-local.z,local.z-table.local.max.z);
        const score=Math.abs(p.y-table.box.max.y)+outside;if(score<best.score)best={score,angle,elbow:key};}
      yield* checkpoint();
    }
    if(best.score>.2)fail('native_table_support_unreachable');
    context.tableLean=best.angle;context.tableFit=best;
  }
  function rotateToward(node,child,target) {
    const origin=node.getWorldPosition(new THREE.Vector3()),direction=child.getWorldPosition(new THREE.Vector3()).sub(origin);
    const desired=target.clone().sub(origin);if(direction.lengthSq()<1e-9||desired.lengthSq()<1e-9)return;
    const delta=new THREE.Quaternion().setFromUnitVectors(direction.normalize(),desired.normalize());
    const world=node.getWorldQuaternion(new THREE.Quaternion()).premultiply(delta),parent=node.parent.getWorldQuaternion(new THREE.Quaternion());
    node.quaternion.copy(parent.invert().multiply(world));update();
  }
  function wristGoal(side,target) {
    const prefix=side==='L'?'左':'右',upper=bone(prefix+'腕'),elbow=bone(prefix+'ひじ'),wrist=bone(prefix+'手首');
    const a=upper.getWorldPosition(new THREE.Vector3()),b=elbow.getWorldPosition(new THREE.Vector3()),c=wrist.getWorldPosition(new THREE.Vector3()),orientation=wrist.getWorldQuaternion(new THREE.Quaternion());
    const l1=a.distanceTo(b),l2=b.distanceTo(c),ray=target.clone().sub(a),d=ray.length();
    if(d>l1+l2-.015)fail('native_keyboard_arm_unreachable');ray.normalize();
    let pole=b.clone().sub(a).addScaledVector(ray,-b.clone().sub(a).dot(ray));
    if(pole.length()<1e-5)pole=new THREE.Vector3(side==='L'?.1:-.1,0,1).addScaledVector(ray,-ray.z);
    pole.normalize();const cosine=Math.max(-1,Math.min(1,(l1*l1+d*d-l2*l2)/(2*l1*Math.max(d,1e-6))));
    const goal=a.clone().addScaledVector(ray,l1*cosine).addScaledVector(pole,l1*Math.sqrt(1-cosine*cosine));
    rotateToward(upper,elbow,goal);rotateToward(elbow,wrist,target);
    wrist.quaternion.copy(wrist.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(orientation));update();
    return wrist.getWorldPosition(new THREE.Vector3()).distanceTo(target);
  }
  function calibrateKeyboard(context,id,t) {
    const laptop=propsObject()?.objects?.laptop;if(!laptop?.visible)fail('native_keyboard_disappeared');laptop.updateMatrixWorld(true);
    for(const side of SIDES){const prefix=side==='L'?'左':'右',tip=bone(prefix+'人指３')??bone(prefix+'中指１'),wrist=bone(prefix+'手首');
      const key=new THREE.Vector3(side==='L'?.65:-.65,.27,.3).applyMatrix4(laptop.matrixWorld);
      const originalTip=tip.getWorldPosition(new THREE.Vector3()),originalWrist=wrist.getWorldPosition(new THREE.Vector3());
      context.maximumArmError=Math.max(context.maximumArmError??0,wristGoal(side,originalWrist.add(key.sub(originalTip))));
    }
  }
  function entrySample(context,time) {
    const duration=context.entry.duration,u=Math.max(0,Math.min(1,time/duration)),blend=smooth(u),floor=context.def.lifecycle.contactMode==='floor-transfer';
    const result=context.entry.from.map((row,i)=>({p:row.p.clone().lerp(context.entry.to[i].p,blend),q:row.q.clone().slerp(context.entry.to[i].q,blend),s:row.s.clone().lerp(context.entry.to[i].s,blend)}));
    nativeAdapter.apply(result);
    if(floor){const current=physical(),targetY=context.entry.startHip.y+(context.entry.endHip.y-context.entry.startHip.y)*smooth(u/.62);
      nativeAdapter.apply(move(captureNativePose(nodes),[0,targetY-current.pelvis.y,0]));}
    const feet=Object.fromEntries(SIDES.map(side=>{
      const progress=floor?smooth((u-.64)/.36):blend,a=context.entry.feetFrom[side],b=context.entry.feetTo[side];
      return [side,{position:a.clone().lerp(b,progress).toArray(),rotation:context.entry.rotations[side],contact:floor?u<.64:true}];}));
    const diagnostics=solveFeet(feet);if(Object.values(diagnostics).some(d=>d.error>.15))fail('native_authored_entry_unreachable');
    return captureNativePose(nodes);
  }

  function* prepareSteps(def,plan,state,{cooperative=false,repeat=1}={}) {
    let saved=snapshot();const entrySaved=saved;let calculationVisible=true;
    let sliceStarted=performance.now(),maximumSliceMs=0,slices=0;
    function* checkpoint(force=false){
      if(!cooperative)return;
      const elapsed=performance.now()-sliceStarted;
      if(!force&&elapsed<4)return;
      slices++;
      const transaction=snapshot();restore(saved);calculationVisible=false;maximumSliceMs=Math.max(maximumSliceMs,performance.now()-sliceStarted);yield {slices,maximumSliceMs};
      sliceStarted=performance.now();saved=snapshot();calculationVisible=true;restore(transaction);
    }
    try {
      if(!def?.lifecycle||!plan?.length)fail('native_scene_contract_missing');
      for(const phase of def.phaseData??[]){const loaded=nativeAdapter.rows.get(phase.id);
        if(!phase.jsonSha256||loaded?.clip.data.verifiedSourcePayloadSha256!==phase.jsonSha256)fail('native_source_fingerprint_unverified:'+phase.id);
        if(phase.companion&&loaded?.ribbon?.clip.data.verifiedSourcePayloadSha256!==phase.companion.jsonSha256)fail('native_companion_fingerprint_unverified:'+phase.id);}
      if(state?.support!==def.lifecycle.entrySupport)fail('native_entry_support_mismatch');
      if(state.hands!=='free')fail('native_requires_free_hands');
      for(const id of def.requires.props??[])if(!propsObject()?.objects?.[id]?.visible)fail('native_missing_prop:'+id);
      const chair=surface('chair','seat'),table=surface('table','tabletop');
      if((def.lifecycle.entrySupport==='seated'||def.lifecycle.middleSupport==='seated'||def.lifecycle.exitSupport==='seated')&&!chair)fail('native_real_seat_required');
      const first=raw(plan[0].id,0),initialHip=new THREE.Vector3(...state.bones.pelvis),currentYaw=yaw(bone('腰').getWorldQuaternion(new THREE.Quaternion()));
      // Use the saved displayed pose for the outgoing facing, not the sampled source.
      nativeAdapter.apply(entrySaved.pose);const outgoingYaw=yaw(bone('腰').getWorldQuaternion(new THREE.Quaternion()));
      const rotation=new THREE.Quaternion().setFromAxisAngle(UP,outgoingYaw-currentYaw),matrix=new THREE.Matrix4().makeRotationFromQuaternion(rotation);
      const rawHip=first.points.pelvis.clone().applyQuaternion(rotation),shift=initialHip.clone().sub(rawHip);shift.y=0;
      const rawFeet=SIDES.map(s=>first.points[sideName(s)+'Ankle'].clone().applyQuaternion(rotation));
      shift.y=Math.max(...SIDES.map((s,i)=>footY[s]-rawFeet[i].y));
      const seatedEntry=def.lifecycle.entrySupport==='seated';
      if(seatedEntry){shift.y=chair.box.max.y+seatOffset-rawHip.y;const center=chair.box.getCenter(new THREE.Vector3());shift.x=center.x-rawHip.x;shift.z=center.z-rawHip.z;}
      matrix.setPosition(shift);
      const context={def,plan,state:structuredClone(state),matrix,seatShift:new THREE.Vector3(),phases:new Map(),chair,table,
        entryPose:entrySaved.pose,entryHip:initialHip,entryYaw:outgoingYaw,groundTolerance:.08,seatTolerance:.35,maxLegError:0,sourceAmplitude:1,sourceSpeed:1};
      const moving=def.lifecycle.contactMode==='root-motion',extract=moving&&(def.phaseData?.every(p=>Math.abs(p.geometry.start.pelvisHeight-p.geometry.end.pelvisHeight)<.3)??false)
        &&!def.phaseData?.some(p=>p.sourceAsset.includes('/Turn_'))&&(def.sourceRootMovement?.maximumTravelCm??0)===0;
      let minimumHip=Infinity,minimumHipPoint=null,maximumHip=-Infinity;
      for(const phase of plan){const samples=[],count=Math.max(8,Math.min(2000,Math.ceil(phase.duration*24)));
        for(let i=0;i<=count;i++){const at=phase.duration*i/count,sampled=raw(phase.id,at),pose=worldTransform(sampled.pose,matrix);nativeAdapter.apply(pose);const points=physical();
          if(points.pelvis.y<minimumHip){minimumHip=points.pelvis.y;minimumHipPoint=points.pelvis.clone();}maximumHip=Math.max(maximumHip,points.pelvis.y);
          samples.push({time:at,points,yaw:yaw(bone('腰').getWorldQuaternion(new THREE.Quaternion())),rotations:Object.fromEntries(SIDES.map(s=>[s,bone(rig.legs[s].names.ankle).getWorldQuaternion(new THREE.Quaternion()).toArray()]))});yield* checkpoint();}
        context.phases.set(phase.id,{samples,frames:[]});
      }
      if(!seatedEntry){const samples=[...context.phases.values()].flatMap(p=>p.samples);
        const correction=Math.max(...SIDES.map(side=>footY[side]-Math.min(...samples.map(s=>s.points[sideName(side)+'Ankle'].y))));
        context.matrix.elements[13]+=correction;minimumHip+=correction;maximumHip+=correction;minimumHipPoint.y+=correction;
        for(const sample of samples)for(const point of Object.values(sample.points))point.y+=correction;
      }
      let supportHip=minimumHip,supportPoint=minimumHipPoint;
      if(def.lifecycle.middleSupport==='seated'||def.lifecycle.exitSupport==='seated'){
        const stable=plan.find(p=>p.phase==='loop')??(def.lifecycle.exitSupport==='seated'?plan.at(-1):null);
        if(stable){const samples=context.phases.get(stable.id).samples;supportPoint=samples[Math.floor(samples.length/2)].points.pelvis;supportHip=supportPoint.y;}
      }
      if(def.lifecycle.contactMode==='floor-transfer')context.seatShift.set(0,seatOffset-minimumHip,0);
      else if(!seatedEntry&&chair&&(def.lifecycle.middleSupport==='seated'||def.lifecycle.exitSupport==='seated')){
        const center=chair.box.getCenter(new THREE.Vector3());context.seatShift.set(center.x-supportPoint.x,chair.box.max.y+seatOffset-supportHip,center.z-supportPoint.z);
      }
      for(const phase of plan){const data=context.phases.get(phase.id),minimum=Object.fromEntries(SIDES.map(s=>[s,Math.min(...data.samples.map(f=>f.points[sideName(s)+'Ankle'].y))]));
        let travel=new THREE.Vector3(),velocity=new THREE.Vector3(),anchors={},lastContact={},maximumSeatWeight=0;
        const seatArrival=moving&&def.lifecycle.middleSupport==='seated'
          ?data.samples.reduce((lowest,sample)=>sample.points.pelvis.y<lowest.points.pelvis.y?sample:lowest).time:null;
        for(let i=0;i<data.samples.length;i++){const s=data.samples[i],prev=data.samples[Math.max(0,i-1)],dt=s.time-prev.time;
          if(extract&&i){const motion=new THREE.Vector3();let weights=0;for(const side of SIDES){const key=sideName(side)+'Ankle',w=1-smooth((s.points[key].y-minimum[side])/.32);motion.addScaledVector(s.points[key].clone().sub(prev.points[key]),-w);weights+=w;}
            if(weights>.05){motion.divideScalar(weights);velocity.copy(motion).divideScalar(dt);}else motion.copy(velocity).multiplyScalar(dt);motion.y=0;travel.add(motion);}
          const seatWeight=seatedEntry?0:context.seatShift.lengthSq()>0?smooth((maximumHip-s.points.pelvis.y)/Math.max(.1,maximumHip-supportHip)):0;
          maximumSeatWeight=Math.max(maximumSeatWeight,seatWeight);
          // Once a walk-to-seat has reached the actual chair, its later rise
          // and walk stay relative to that chair. Removing this XZ correction
          // with the sit blend would pull the pelvis back toward the game's
          // old chair while one foot was still planted in the real scene.
          const attainedTravel=travel.clone();
          if(moving&&def.lifecycle.middleSupport==='seated'){
            // Distribute scene placement over the approach rather than waiting
            // until the hips drop: a nearby chair cannot be reached by walking
            // the game's full distance then pulling the pelvis back in half a
            // second. Source joint curves/amplitude/time remain untouched.
            const routeWeight=seatArrival>0?smooth(s.time/seatArrival):maximumSeatWeight;
            attainedTravel.x+=context.seatShift.x*(routeWeight-seatWeight);
            attainedTravel.z+=context.seatShift.z*(routeWeight-seatWeight);
            if(context.chair&&s.time<seatArrival){
              const placed=s.points.pelvis.clone().add(attainedTravel).addScaledVector(context.seatShift,seatWeight);
              const local=placed.clone().applyMatrix4(context.chair.inverse),center=context.chair.local.getCenter(new THREE.Vector3());
              const front=center.z+(context.chair.local.max.z-center.z+1.12)*(1-smooth((seatWeight-.45)/.55));
              if(local.z<front){local.z=front;const corrected=local.applyMatrix4(context.chair.part.matrixWorld);
                attainedTravel.x+=corrected.x-placed.x;attainedTravel.z+=corrected.z-placed.z;}
            }
          }
          const feet={};for(const side of SIDES){const key=sideName(side)+'Ankle',p=s.points[key].clone().add(travel).addScaledVector(context.seatShift,seatWeight);
            const contact=s.points[key].y-minimum[side]<.16&&!(def.lifecycle.contactMode==='floor-transfer'&&seatWeight>.9);
            if(contact){if(!lastContact[side])anchors[side]=p.clone();p.x=anchors[side].x;p.z=anchors[side].z;p.y=footY[side];}
            else p.y=Math.max(p.y,footY[side]);
            lastContact[side]=contact;feet[side]={position:p.toArray(),rotation:s.rotations[side],contact};}
          data.frames.push({time:s.time,travel:attainedTravel.toArray(),seatWeight,feet});
        }
        if(moving&&def.lifecycle.middleSupport==='seated')sceneFootsteps(context,data);
      }
      context.keyboard=def.requires.props?.includes('laptop')&&def.lifecycle.contactMode==='table-contact';
      yield* inspectRoute(context,checkpoint,repeat);
      yield* fitTable(context,checkpoint);
      // Inspect endpoints and the entire sampled support path on the actual
      // retargeted skeleton. Unreachable leg goals fail before body ownership.
      for(const phase of plan){const frames=context.phases.get(phase.id).frames;
        for(let i=0;i<frames.length;i+=(moving&&def.lifecycle.middleSupport==='seated'?1:Math.max(1,Math.floor(frames.length/24)))){const result=calibratedRaw(context,phase.id,frames[i].time);
          context.maxLegError=Math.max(context.maxLegError,...Object.values(result.diagnostics).map(d=>d.error));
          if(context.maxLegError>.12){const error=Error('native_leg_target_unreachable');error.details={id:phase.id,time:frames[i].time,maxLegError:context.maxLegError,legs:result.diagnostics};throw error;}yield* checkpoint();}
      }
      let preparedPlan=plan;
      if(def.lifecycle.entrySeconds>0){
        const target=calibratedRaw(context,plan[0].id,0).pose,end=physical();nativeAdapter.apply(entrySaved.pose);const start=physical();
        context.entry={id:'scene-entry:'+def.groupId,duration:def.lifecycle.entrySeconds,from:cloneNativePose(entrySaved.pose),to:target,startHip:start.pelvis,endHip:end.pelvis,
          feetFrom:Object.fromEntries(SIDES.map(s=>[s,start[sideName(s)+'Ankle']])),feetTo:Object.fromEntries(SIDES.map(s=>[s,end[sideName(s)+'Ankle']])),
          rotations:Object.fromEntries(SIDES.map(s=>[s,bone(rig.legs[s].names.ankle).getWorldQuaternion(new THREE.Quaternion()).toArray()]))};
        for(let i=0;i<=24;i++){entrySample(context,context.entry.duration*i/24);yield* checkpoint();}
        preparedPlan=[{id:context.entry.id,phase:'entry',sourcePhase:'authored-entry',duration:context.entry.duration,synthetic:true},...plan];
      }
      const result={accepted:true,plan:preparedPlan,diagnostics:{sourceMatched:true,maxLegError:context.maxLegError,maximumSupportCorrection:context.maximumSupportCorrection??0,phaseCount:preparedPlan.length,
        entrySupport:def.lifecycle.entrySupport,exitSupport:def.lifecycle.exitSupport,extractRootFromPlantedFeet:extract,
        seatSurfaceMeasured:!!chair,tableFit:context.tableFit??null,keyboardTargets:!!context.keyboard,
        maximumSliceMs:Math.max(maximumSliceMs,performance.now()-sliceStarted),slices,
        clothingClearanceAccepted:false,visualAccepted:false}};
      preparedContexts.set(result,{context,state:structuredClone(state)});return result;
    } catch(error){return {accepted:false,reason:error.message,...(error.details?{diagnostics:error.details}:{})};}
    // A cancelled generator may still be suspended after restoring the live display.
    // In that case a successor can already have drawn a newer frame; never restore
    // the old checkpoint over it when iterator.return() unwinds this generator.
    finally {if(calculationVisible)restore(saved);}
  }
  function sceneMatches(a,b){
    if(!b||a.support!==b.support||a.hands!==b.hands||a.activityToken!==b.activityToken)return false;
    const distance=(x,y)=>Array.isArray(x)&&Array.isArray(y)?Math.hypot(...x.map((v,i)=>v-y[i])):Infinity;
    const orientation=(x,y)=>!x&&!y?0:Array.isArray(x)&&Array.isArray(y)&&x.length===4&&y.length===4?2*Math.acos(Math.min(1,Math.abs(x.reduce((n,v,i)=>n+v*y[i],0)))):Infinity;
    if(Math.abs(Math.atan2(Math.sin((a.root?.yaw??0)-(b.root?.yaw??0)),Math.cos((a.root?.yaw??0)-(b.root?.yaw??0))))>.02)return false;
    if(distance(a.bones?.pelvis,b.bones?.pelvis)>.2)return false;
    for(const key of ['leftAnkle','rightAnkle'])if(distance(a.bones?.[key],b.bones?.[key])>.12)return false;
    for(const id of new Set([...Object.keys(a.props??{}),...Object.keys(b.props??{})])){
      const p=a.props?.[id],q=b.props?.[id];if(!p||!q){if(p?.visible||q?.visible)return false;continue;}
      if(p.visible!==q.visible||p.attachment!==q.attachment)return false;
      const ap=p.worldTransform?.position??p.position,bp=q?.worldTransform?.position??q?.position;
      if(ap&&distance(ap,bp)>.03)return false;
      if(orientation(p.worldTransform?.quaternion??p.quaternion,q?.worldTransform?.quaternion??q?.quaternion)>.02)return false;
      if(p.scale&&distance(p.scale,q?.scale)>.01)return false;
      if(Math.abs((p.openness??1)-(q?.openness??1))>.01)return false;
    }
    return true;
  }
  function validatePrepared(prepared,state){
    const found=preparedContexts.get(prepared);if(!found||!prepared.accepted)return {accepted:false,reason:'native_prepared_token_invalid'};
    if(!sceneMatches(found.state,state))return {accepted:false,reason:'native_prepared_scene_changed'};
    return {accepted:true};
  }
  function activatePrepared(prepared,state){
    const result=validatePrepared(prepared,state);if(!result.accepted)return result;
    active=preparedContexts.get(prepared).context;lastEvidence=null;return {accepted:true};
  }
  function preparePlan(def,plan,state,options={}){const iterator=prepareSteps(def,plan,state,options);let next;do{next=iterator.next();}while(!next.done);if(next.value.accepted)activatePrepared(next.value,state);return next.value;}
  async function preparePlanAsync(def,plan,state,{isCurrent=()=>true,repeat=1}={}){
    const iterator=prepareSteps(def,plan,state,{cooperative:true,repeat});let next;
    try{do{if(!isCurrent()){iterator.return();return {accepted:false,reason:'native_preparation_cancelled'};}next=iterator.next();if(!next.done)await new Promise(resolve=>setTimeout(resolve,0));}while(!next.done);return next.value;}
    catch(error){iterator.return();return {accepted:false,reason:error.message};}
  }
  function sample(id,time) {if(active?.entry?.id===id)return entrySample(active,time);if(!active?.phases.has(id))fail('native_scene_phase_not_prepared');return calibratedRaw(active,id,time).pose;}
  function align(current,incoming) {
    // Scene-calibrated seated/standing targets already share the same support
    // frame. A second post-IK root alignment would move the feet and seat away
    // from the furniture that was actually measured.
    if(active?.def.lifecycle.contactMode!=='root-motion')return pose=>cloneNativePose(pose);
    const saved=snapshot();try {
      nativeAdapter.apply(current);const a=position('腰'),aYaw=yaw(bone('腰').getWorldQuaternion(new THREE.Quaternion()));
      nativeAdapter.apply(incoming);const b=position('腰'),bYaw=yaw(bone('腰').getWorldQuaternion(new THREE.Quaternion()));
      const q=new THREE.Quaternion().setFromAxisAngle(UP,aYaw-bYaw),shift=a.clone().sub(b.clone().applyQuaternion(q));shift.y=0;
      const matrix=new THREE.Matrix4().makeRotationFromQuaternion(q).setPosition(shift);return pose=>worldTransform(pose,matrix);
    } finally {restore(saved);}
  }
  function resolveReturnPose({current,entry,lifecycle}) {
    const saved=snapshot();try {
      nativeAdapter.apply(current);const attained=physical(),currentRoot=mesh.getWorldPosition(new THREE.Vector3());
      nativeAdapter.apply(entry);const original=physical();let result=cloneNativePose(entry);
      if(lifecycle.entrySupport==='standing'){
        const attainedCenter=attained.leftAnkle.clone().add(attained.rightAnkle).multiplyScalar(.5),originalCenter=original.leftAnkle.clone().add(original.rightAnkle).multiplyScalar(.5);
        const offset=attainedCenter.sub(originalCenter);offset.y=0;result=move(result,offset.toArray());
      }
      nativeAdapter.apply(result);
      const goals=Object.fromEntries(SIDES.map(s=>{const p=attained[sideName(s)+'Ankle'].clone();p.y=footY[s];return [s,{position:p.toArray(),rotation:bone(rig.legs[s].names.ankle).getWorldQuaternion(new THREE.Quaternion()).toArray(),contact:true}];}));
      supportProjection(goals,{seatLocked:lifecycle.entrySupport==='seated'});
      const diagnostics=solveFeet(goals);if(Object.values(diagnostics).some(d=>d.error>.12))fail('native_return_support_unreachable');
      result=captureNativePose(nodes);return result;
    } finally {restore(saved);}
  }
  function measureState(player=null) {
    if(!active)return null;const points=physical(),chair=surface('chair','seat'),table=surface('table','tabletop');
    const contacts=Object.fromEntries(SIDES.map(s=>[s,Math.abs(points[sideName(s)+'Ankle'].y-footY[s])<=.12]));
    const seatGap=chair?points.pelvis.y-(chair.box.max.y+seatOffset):null;
    const seatSupported=!!chair&&Math.abs(seatGap)<=.35&&inside(points.pelvis,chair,.15);
    const floorSupported=active.def.lifecycle.contactMode==='floor-transfer'&&Math.abs(points.pelvis.y-seatOffset)<.35;
    const support=seatSupported?'seated':floorSupported?'floor-seated':contacts.L||contacts.R?'standing':'airborne';
    const tablePoints=table?['leftElbow','rightElbow','leftWrist','rightWrist'].map(key=>({key,gap:Math.abs(points[key].y-table.box.max.y),inside:inside(points[key],table,0)})):[];
    const terminal=player&&['complete-held','cancelled-held'].includes(player.state);
    const tableContact=tablePoints.some(p=>p.inside&&p.gap<=.2);
    lastEvidence={support,contacts,seatSupported,seatGap,floorSupported,tableContact,tablePoints,sourceAmplitude:1,sourceSpeed:1,
      evidence:'actual PMX ankle targets and actual seat/table geometry; no cloth collision certification',terminal:!!terminal,
      root:{position:mesh.getWorldPosition(new THREE.Vector3()).toArray(),yaw:yaw(mesh.getWorldQuaternion(new THREE.Quaternion()))}};
    return {...lastEvidence};
  }
  function validateTerminal(player) {
    const evidence=measureState(player);if(!evidence)return {ok:false,reason:'native_scene_not_prepared'};
    if(!['complete-held','cancelled-held'].includes(player?.state))return {ok:false,reason:'native_route_not_complete',evidence};
    const required=player.cancelled&&player.terminalRoute==='return-entry'?active.def.lifecycle.entrySupport:active.def.lifecycle.exitSupport;
    if(evidence.support!==required)return {ok:false,reason:'native_terminal_support_mismatch',evidence};
    return {ok:true,evidence};
  }
  return {preparePlan,preparePlanAsync,validatePrepared,activatePrepared,sample,align,resolveReturnPose,measureState,validateTerminal,
    snapshot:()=>({activeId:active?.def.id??null,evidence:lastEvidence,sourceSpeed:1,sourceAmplitude:1})};
}
