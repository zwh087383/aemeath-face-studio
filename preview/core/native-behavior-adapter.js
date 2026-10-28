import * as THREE from 'three';
import {NativeClip,NativeRetarget} from './native-motion.js';
import {NativeResourceLayer} from './native-resource-layer.js';
import {findNativeRibbonCompanion} from './native-companion.js';
import {applyNativePose,captureNativePose,cloneNativePose} from './native-behavior.js';

const captureBind=root=>{const rows=[];root.updateMatrixWorld(true);root.traverse(node=>{if(node.isBone&&!node.userData.nativeClothVirtual)rows.push({node,p:node.position.clone(),q:node.quaternion.clone(),s:node.scale.clone(),wq:node.getWorldQuaternion(new THREE.Quaternion())});});return rows;};
const restore=(rows,root)=>{for(const r of rows){r.node.position.copy(r.p);r.node.quaternion.copy(r.q);r.node.scale.copy(r.s);}root.updateMatrixWorld(true);};

/** Uses existing calibrated body/hair mapping and exact companion selection.
 * It never remaps a skirt chain. NativeClothBinding receives the composed
 * source pose AFTER the transition, once on the same explicit clock. */
export class NativeBehaviorAdapter {
  constructor({mesh,source,cloth=null,manifest}) {
    this.mesh=mesh;this.source=source;this.cloth=cloth;this.manifest=manifest;this.targetRest=captureBind(mesh);this.sourceRest=captureBind(source);
    this.targetContainer={p:mesh.position.clone(),q:mesh.quaternion.clone(),s:mesh.scale.clone()};
    this.sourceContainer={p:source.position.clone(),q:source.quaternion.clone(),s:source.scale.clone()};
    this.nodes=[source,mesh,...this.sourceRest.map(r=>r.node),...this.targetRest.map(r=>r.node)];
    this.rows=new Map();this.availableSourceNames=new Set();this.lastId=null;
  }
  resetBind(){
    for(const [root,r] of [[this.mesh,this.targetContainer],[this.source,this.sourceContainer]]){root.position.copy(r.p);root.quaternion.copy(r.q);root.scale.copy(r.s);}
    restore(this.targetRest,this.mesh);restore(this.sourceRest,this.source);
  }
  async load(ids,read) {
    // All I/O happens before touching either displayed skeleton. Different
    // groups may fetch concurrently; construction below is a synchronous
    // transaction, so no await can expose a reset/bind pose to the renderer.
    const pending=[...new Set(ids)].filter(id=>!this.rows.has(id));
    const reads=new Map();
    const fetch=id=>{if(!reads.has(id))reads.set(id,Promise.resolve().then(()=>read(id)));return reads.get(id);};
    const inputs=await Promise.all(pending.map(async id=>{
      const descriptor=this.manifest.clips.find(r=>r.id===id&&r.resourceKind==='body'&&r.status==='ready');
      if(!descriptor)throw Error('Native body is not ready: '+id);
      const companion=findNativeRibbonCompanion(descriptor,this.manifest.clips);
      const [bodyData,ribbonData]=await Promise.all([fetch(id),companion?fetch(companion.id):null]);
      return {id,descriptor,companion,bodyData,ribbonData};
    }));
    const displayed=captureNativePose(this.nodes),previousScale=this.sourceContainer.s.clone(),added=new Map();
    try {
      for(const {id,descriptor,companion,bodyData,ribbonData} of inputs) {
        // A concurrent load may have committed this ID while I/O was pending.
        if(this.rows.has(id))continue;
        this.resetBind();const clip=new NativeClip(bodyData);
        // Bind calibration is model-local, independent of where the actor was
        // standing when this lazy load finished. NativeRetarget stores world
        // bind positions and rotates its pelvis offset; capturing avatarRoot's
        // translation here would turn that scene offset into animated motion.
        // This synchronous scope changes no parent child-list and cannot yield
        // a detached display. The real parent is restored before any playback.
        const parent=this.mesh.parent;let retarget;
        try {this.mesh.parent=null;retarget=new NativeRetarget(clip,this.mesh);}
        finally {this.mesh.parent=parent;this.mesh.updateWorldMatrix(true,true);}
        const scale=retarget.scale*100;
        if((this.rows.size||added.size)&&Math.abs(this.sourceContainer.s.x-scale)>1e-6)
          throw Error('Native source scale mismatch: '+id);
        this.source.scale.setScalar(scale);this.sourceContainer.s.copy(this.source.scale);
        let ribbon=null;
        if(companion){const c=new NativeClip(ribbonData);const composition=c.data.sourceAdditiveType==='AAT_LocalSpaceBase'&&c.data.additiveBakedToFullPose?'replace':'additive';
          ribbon={descriptor:companion,clip:c,native:new NativeResourceLayer(c,this.source,{kind:'ribbon',native:true,bindPose:this.sourceRest,composition}),target:new NativeResourceLayer(c,this.mesh,{kind:'ribbon',bindPose:this.targetRest,composition})};}
        added.set(id,{descriptor,clip,retarget,ribbon});
      }
      for(const [id,row] of added)this.rows.set(id,row);
    } catch(error) {
      this.sourceContainer.s.copy(previousScale);
      throw error;
    } finally {
      applyNativePose(this.nodes,displayed);
      this.source.updateMatrixWorld(true);this.mesh.updateMatrixWorld(true);
      this.source.traverse(node=>{if(node.isSkinnedMesh)node.skeleton.update();});this.mesh.skeleton.update();
    }
    return this;
  }
  sample(id,time) {
    const row=this.rows.get(id);if(!row)throw Error('Unloaded native phase '+id);
    this.resetBind();row.clip.sample(time);row.clip.applyToGLTF(this.source);row.retarget.apply();
    if(row.ribbon){const at=Math.min(row.ribbon.clip.data.duration,time);row.ribbon.native.apply(at);row.ribbon.target.apply(at);}
    this.lastId=id;this.availableSourceNames=new Set([...row.clip.indices.keys(),...(row.ribbon?.clip.indices.keys()??[])]);
    return captureNativePose(this.nodes);
  }
  apply(pose) {
    applyNativePose(this.nodes,pose);this.source.updateMatrixWorld(true);this.mesh.updateMatrixWorld(true);
    this.source.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});this.mesh.skeleton.update();
    this.cloth?.apply({availableSourceNames:this.availableSourceNames});return this;
  }
  /** Preserve horizontal travel and yaw across phase changes and loop wraps.
   * Vertical motion stays in the source trajectory: this does not invent a
   * chair, seat height, landing or support. Both whole-model containers receive
   * the SAME world transform, so restored cloth remains in the composed pose. */
  alignment(current,incoming) {
    const pelvis=this.mesh.skeleton.bones.find(b=>b.name==='腰');
    const anchor=pose=>{this.apply(pose);const q=pelvis.getWorldQuaternion(new THREE.Quaternion()),forward=new THREE.Vector3(0,0,1).applyQuaternion(q);return {p:pelvis.getWorldPosition(new THREE.Vector3()),yaw:Math.atan2(forward.x,forward.z)};};
    const a=anchor(current),b=anchor(incoming),rotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),a.yaw-b.yaw);
    const shift=a.p.clone().sub(b.p.clone().applyQuaternion(rotation));shift.y=0;
    return pose=>{const result=cloneNativePose(pose);for(const i of [0,1]){result[i].p.applyQuaternion(rotation).add(shift);result[i].q.premultiply(rotation).normalize();}return result;};
  }
  stopOptions(){return {maxRotationRadians:.5,maxPositionDistance:.7,positionIndices:new Set([0,1,...this.nodes.map((n,i)=>n.name==='腰'?i:-1).filter(i=>i>=0)])};}
  snapshot(){const r=this.rows.get(this.lastId);return {id:this.lastId,companion:r?.ribbon?.descriptor.id??null,companionComposition:r?.ribbon?.target.composition??null,mapped:r?.retarget.mapping.length??0,nativeLongHairMapped:r?.retarget.snapshot().nativeLongHairMapped??0,cloth:this.cloth?.snapshot()??null};}
}

export function buildNativeBehaviorPlan(group,manifest) {
  if(group.kind!=='native-body-family'||!group.sourceFamily||!Array.isArray(group.memberIds))throw Error('Invalid source family');
  const rows=group.sources.filter(r=>group.memberIds.includes(r.id));
  if(rows.length!==group.memberIds.length)throw Error('Missing source-family member');
  const phases=['start','loop','single','end'];
  const phaseOf=item=>/^loop\d+$/.test(item.phase)?'loop':item.phase;
  if(rows.some(item=>!phases.includes(phaseOf(item))))throw Error('Unsupported native phase; inspect source before making a behavior plan');
  const output=[];
  for(const phase of phases){const candidates=rows.filter(r=>phaseOf(r)===phase).sort((a,b)=>a.phase.localeCompare(b.phase,undefined,{numeric:true})||a.id.localeCompare(b.id));for(const item of candidates){
    const actual=manifest.clips.find(r=>r.id===item.id&&r.status==='ready'&&r.resourceKind==='body');
    if(!actual||actual.sourceAsset!==item.sourceRef||actual.sourceAsset.replace(/\.uasset$/i,'').replace(/_(?:Start|Loop\d*|End)$/i,'')!==group.sourceFamily)throw Error('Foreign/missing source phase '+item.id);
    output.push({id:item.id,phase,sourcePhase:item.phase,duration:actual.duration,name:actual.name,sourceAsset:actual.sourceAsset});
  }}
  if(!output.length)throw Error('Empty native family');return output;
}
