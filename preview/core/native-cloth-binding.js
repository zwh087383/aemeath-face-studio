import * as THREE from 'three';

// The MMD edit replaced the native skirt rig by a dense simulation grid. Its
// skirt surface is still the same mesh. Restore only those vertices' authored
// skinning in memory; never invent aliases between unrelated skeleton chains.
export const nativeSkirtTargetBone = name => /^(?:スカート_\d+_\d+|[左右]侧裙_\d+_\d+|[左右]裙[A-D])$/.test(name);
const nativeSkirtSourceBone = name => /^Bone_(?:Skirt\d+_[LRM]|Piao27\d+_[LR])$/.test(name);
const cellKey = (x,y,z) => `${x},${y},${z}`;
const readVector = (attribute,index,size) => Array.from({length:size},(_,k)=>attribute.getComponent(index,k));
const equivalentWeights=(a,b)=>{
  const names=new Set([...a,...b].map(row=>row.name));
  let error=0;for(const name of names)error+=Math.abs((a.find(row=>row.name===name)?.weight??0)-(b.find(row=>row.name===name)?.weight??0));
  return error<1e-6;
};
const normalAt = (attribute,index,matrix) => attribute ? new THREE.Vector3().fromBufferAttribute(attribute,index).applyMatrix3(matrix).normalize() : null;

function sourceSurface(root) {
  root.updateMatrixWorld(true);
  const rootInv=root.matrixWorld.clone().invert(), rows=[];
  root.traverse(mesh=>{
    if(!mesh.isSkinnedMesh)return;
    const {geometry,skeleton}=mesh, position=geometry.getAttribute('position'),
      index=geometry.getAttribute('skinIndex'), weight=geometry.getAttribute('skinWeight'),
      uv=geometry.getAttribute('uv'), normal=geometry.getAttribute('normal');
    if(!position||!index||!weight||!uv||!normal)return;
    const transform=rootInv.clone().multiply(mesh.matrixWorld), normals=new THREE.Matrix3().getNormalMatrix(transform);
    for(let i=0;i<position.count;i++) {
      const influences=[];
      for(let k=0;k<index.itemSize;k++) {
        const value=weight.getComponent(i,k),bone=skeleton.bones[index.getComponent(i,k)];
        if(value>1e-7&&bone)influences.push({name:bone.name,bone,weight:value});
      }
      if(!influences.some(row=>nativeSkirtSourceBone(row.name)))continue;
      if(influences.length>4)throw Error('Native skirt vertex has more than four influences');
      const total=influences.reduce((sum,row)=>sum+row.weight,0);
      if(!(total>0)||!Number.isFinite(total))throw Error('Invalid source skirt weights');
      for(const row of influences)row.weight/=total;
      rows.push({position:new THREE.Vector3().fromBufferAttribute(position,i).applyMatrix4(transform),
        normal:normalAt(normal,i,normals),uv:new THREE.Vector2().fromBufferAttribute(uv,i),influences});
    }
  });
  return rows;
}

function targetSurface(mesh, originalBones) {
  const {geometry}=mesh, position=geometry.getAttribute('position'), index=geometry.getAttribute('skinIndex'),
    weight=geometry.getAttribute('skinWeight'),uv=geometry.getAttribute('uv'),normal=geometry.getAttribute('normal');
  if(!position||!index||!weight||!uv||!normal||index.itemSize!==4||weight.itemSize!==4)
    throw Error('Skirt binding requires four-weight position, normal and UV attributes');
  const rows=[];
  for(let i=0;i<position.count;i++) {
    let skirt=false;
    for(let k=0;k<4;k++)if(weight.getComponent(i,k)>1e-7&&nativeSkirtTargetBone(originalBones[index.getComponent(i,k)]?.name??''))skirt=true;
    if(skirt)rows.push({index:i,position:new THREE.Vector3().fromBufferAttribute(position,i),
      normal:new THREE.Vector3().fromBufferAttribute(normal,i).normalize(),uv:new THREE.Vector2().fromBufferAttribute(uv,i)});
  }
  return rows;
}

function buildCorrespondence(source,target,{maxPositionError,maxUVError,minNormalDot}) {
  const range=rows=>{let min=Infinity,max=-Infinity;for(const row of rows){min=Math.min(min,row.position.x);max=Math.max(max,row.position.x);}return max-min;};
  let scale=range(target)/range(source);
  if(!(scale>0)||!Number.isFinite(scale))throw Error('Degenerate skirt surface scale');
  const cell=Math.max(.025,maxPositionError*4), bins=new Map();
  const makeBins=()=>{
    bins.clear();
    for(const row of source){row.scaled=row.position.clone().multiplyScalar(scale);const p=row.scaled,
      key=cellKey(Math.floor(p.x/cell),Math.floor(p.y/cell),Math.floor(p.z/cell));
      const values=bins.get(key)??[];values.push(row);bins.set(key,values);}
  };
  const find=(row,strict)=>{
    const p=row.position,bx=Math.floor(p.x/cell),by=Math.floor(p.y/cell),bz=Math.floor(p.z/cell);
    let best=null,bestScore=Infinity;const samePosition=[],edited=[];
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++) {
      const values=bins.get(cellKey(bx+x,by+y,bz+z));if(!values)continue;
      for(const candidate of values) {
        const distance=p.distanceTo(candidate.scaled),uvError=row.uv.distanceTo(candidate.uv),
          normalDot=row.normal.dot(candidate.normal);
        if(distance<=Math.min(.0001,maxPositionError*.05))samePosition.push(candidate);
        if(distance>(strict?maxPositionError:cell)||uvError>maxUVError)continue;
        if(Math.abs(normalDot)<minNormalDot){
          if(distance<=Math.min(.0001,maxPositionError*.05))edited.push({source:candidate,distance,uvError,normalDot,editedNormal:true});
          continue;
        }
        // Position is the identity test, UV distinguishes duplicated seam points.
        // Reversed normals are permitted only on this same surface (MMD backs).
        const score=distance+uvError*.05+(1-Math.abs(normalDot))*.00001;
        if(score<bestScore){best={source:candidate,distance,uvError,normalDot};bestScore=score;}
      }
    }
    if(best)return best;
    // The PMX edit changed normals on a small set of duplicated skirt points.
    // Permit this only for virtually exact position + matching UV, AND when
    // every native vertex at that position has identical original skinning.
    // A seam with different weights remains an error, never a guessed layer.
    if(edited.length&&samePosition.every(candidate=>equivalentWeights(candidate.influences,edited[0].source.influences)))
      return edited.sort((a,b)=>a.uvError-b.uvError||a.distance-b.distance)[0];
    return null;
  };
  makeBins();let dot=0,length=0,coarse=0;
  for(const row of target){const match=find(row,false);if(match){dot+=row.position.dot(match.source.position);length+=match.source.position.lengthSq();coarse++;}}
  if(coarse!==target.length||!(length>0))throw Error(`Skirt surface correspondence incomplete: ${coarse}/${target.length}`);
  scale=dot/length;makeBins();
  const matches=target.map(row=>{const match=find(row,true);if(!match)throw Error(`No same-surface native skirt vertex for target ${row.index}`);return {target:row,...match};});
  return {scale,matches};
}

/** In-memory native skirt skinning. Construct once in both models' bind pose,
 * before renderer compilation. The host applies body and ribbon to source first.
 * A missing source track restores original weights instead of using stale bones.
 */
export class NativeClothBinding {
  constructor(sourceRoot,targetMesh,{maxPositionError=.002,maxUVError=.002,minNormalDot=.85}={}) {
    this.sourceRoot=sourceRoot;this.mesh=targetMesh;this.enabled=true;this.active=false;this.reason='Waiting for source tracks';
    if(!targetMesh?.isSkinnedMesh||!targetMesh.skeleton)throw Error('Native skirt target must be skinned');
    this.originalSkeleton=targetMesh.skeleton;
    this.originalAttributes={skinIndex:targetMesh.geometry.getAttribute('skinIndex'),skinWeight:targetMesh.geometry.getAttribute('skinWeight')};
    const originalBones=[...this.originalSkeleton.bones],source=sourceSurface(sourceRoot),target=targetSurface(targetMesh,originalBones);
    if(!source.length||!target.length)throw Error('No native or target skirt surface');
    const {scale,matches}=buildCorrespondence(source,target,{maxPositionError,maxUVError,minNormalDot});
    this.scale=scale;this.vertexIndices=Object.freeze(matches.map(row=>row.target.index));
    this.maxMatchError=Math.max(...matches.map(row=>row.distance));
    this.maxUVError=Math.max(...matches.map(row=>row.uvError));
    this.minimumAbsoluteNormalDot=Math.min(...matches.map(row=>Math.abs(row.normalDot)));
    this.editedNormalVertices=matches.filter(row=>row.editedNormal).length;
    const sourceBones=new Map();for(const row of matches)for(const influence of row.source.influences){
      const previous=sourceBones.get(influence.name);if(previous&&previous!==influence.bone)throw Error('Ambiguous source bone '+influence.name);
      sourceBones.set(influence.name,influence.bone);
    }
    const sourcePelvis=sourceRoot.getObjectByName('Bip001Pelvis'),targetPelvis=originalBones.find(bone=>bone.name==='下半身');
    if(!sourcePelvis?.isBone||!targetPelvis)throw Error('Skirt binding requires source and target pelvis anchors');
    this.sourcePelvis=sourcePelvis;this.targetPelvis=targetPelvis;
    sourceRoot.updateMatrixWorld(true);targetMesh.updateMatrixWorld(true);
    const sourceInv=sourceRoot.matrixWorld.clone().invert(),targetInv=targetMesh.matrixWorld.clone().invert();
    this.sourcePelvisRest=sourceInv.clone().multiply(sourcePelvis.matrixWorld);
    this.targetPelvisRestInv=targetInv.clone().multiply(targetPelvis.matrixWorld).invert();
    this.geometryTransform=new THREE.Matrix4().makeScale(scale,scale,scale);
    this.geometryTransformInv=this.geometryTransform.clone().invert();
    const originalCount=originalBones.length,newIndices=new Map(),virtual=[];
    this.rows=[...sourceBones].map(([name,bone],i)=>{
      const node=new THREE.Bone();node.name='NativeCloth::'+name;node.userData.nativeClothVirtual=true;
      node.matrixAutoUpdate=false;node.matrix.identity();newIndices.set(name,originalCount+i);virtual.push(node);
      return {name,source:bone,node,sourceRestInv:sourceInv.clone().multiply(bone.matrixWorld).invert()};
    });
    if(originalCount+virtual.length>65535)throw Error('Native skirt palette exceeds Uint16 indices');
    this.sourceBoneNames=Object.freeze(this.rows.map(row=>row.name));
    this.requiredSourceNames=new Set([...this.sourceBoneNames,'Bip001Pelvis']);
    // Prepare every change before touching the target. Renderer bindings retain
    // these same two BufferAttributes and one extended palette for all toggles.
    this.skinIndex=this.originalAttributes.skinIndex.clone();this.skinWeight=this.originalAttributes.skinWeight.clone();
    this.originalRows=matches.map(row=>({index:row.target.index,
      indices:readVector(this.originalAttributes.skinIndex,row.target.index,4),
      weights:readVector(this.originalAttributes.skinWeight,row.target.index,4)}));
    this.nativeRows=matches.map(row=>{
      const indices=[0,0,0,0],weights=[0,0,0,0];
      row.source.influences.forEach((influence,k)=>{indices[k]=newIndices.get(influence.name);weights[k]=influence.weight;});
      return {index:row.target.index,indices,weights};
    });
    this.extendedSkeleton=new THREE.Skeleton([...originalBones,...virtual],
      [...this.originalSkeleton.boneInverses.map(matrix=>matrix.clone()),...virtual.map(()=>targetMesh.bindMatrix.clone().invert())]);
    this.sourceInv=new THREE.Matrix4();this.targetInv=new THREE.Matrix4();this.sourcePelvisCurrentInv=new THREE.Matrix4();
    this.targetDelta=new THREE.Matrix4();this.prefix=new THREE.Matrix4();this.current=new THREE.Matrix4();
    this.missingSourceCount=0;
    // Commit once after all matching and matrix validation succeeded.
    for(const node of virtual)targetMesh.add(node);
    targetMesh.skeleton=this.extendedSkeleton;
    targetMesh.geometry.setAttribute('skinIndex',this.skinIndex);targetMesh.geometry.setAttribute('skinWeight',this.skinWeight);
    this.extendedSkeleton.update();
  }
  setEnabled(enabled) {
    this.enabled=Boolean(enabled);
    if(!this.enabled)this._activate(false,'Disabled');
    return this;
  }
  _activate(active,reason) {
    if(active!==this.active){
      for(const row of active?this.nativeRows:this.originalRows){this.skinIndex.setXYZW(row.index,...row.indices);this.skinWeight.setXYZW(row.index,...row.weights);}
      this.skinIndex.needsUpdate=true;this.skinWeight.needsUpdate=true;
    }
    this.active=active;this.reason=reason;
  }
  apply({availableSourceNames}={}) {
    if(!this.enabled){this._activate(false,'Disabled');return this;}
    const available=availableSourceNames instanceof Set?availableSourceNames:null;
    this.missingSourceCount=available?[...this.requiredSourceNames].filter(name=>!available.has(name)).length:this.requiredSourceNames.size;
    if(this.missingSourceCount){this._activate(false,`Missing source tracks: ${this.missingSourceCount}`);return this;}
    this.sourceRoot.updateMatrixWorld(true);this.mesh.updateMatrixWorld(true);
    this.sourceInv.copy(this.sourceRoot.matrixWorld).invert();this.targetInv.copy(this.mesh.matrixWorld).invert();
    this.sourcePelvisCurrentInv.copy(this.sourceInv).multiply(this.sourcePelvis.matrixWorld).invert();
    this.targetDelta.copy(this.targetInv).multiply(this.targetPelvis.matrixWorld).multiply(this.targetPelvisRestInv);
    // V = targetPelvisDelta * A * sourcePelvisRest * sourcePelvisCurrent^-1
    //   * sourceBoneCurrent * sourceBoneRest^-1 * A^-1.
    // Both pelvis motions are removed/applied once, including different bind
    // axes. Root display scale and arbitrary model parents cancel explicitly.
    this.prefix.copy(this.targetDelta).multiply(this.geometryTransform).multiply(this.sourcePelvisRest).multiply(this.sourcePelvisCurrentInv);
    for(const row of this.rows) {
      this.current.copy(this.sourceInv).multiply(row.source.matrixWorld);
      row.node.matrix.copy(this.prefix).multiply(this.current).multiply(row.sourceRestInv).multiply(this.geometryTransformInv);
      if(!row.node.matrix.elements.every(Number.isFinite)){this._activate(false,'Nonfinite source deformation');return this;}
      row.node.matrixWorldNeedsUpdate=true;
    }
    this._activate(true,'Native skirt surface weights and authored source tracks');
    this.mesh.updateMatrixWorld(true);this.extendedSkeleton.update();return this;
  }
  /** Reversible preview fallback; the shared GPU palette remains allocated. */
  restore(){this.setEnabled(false);return this;}
  snapshot(){return {enabled:this.enabled,active:this.active,matchedVertices:this.vertexIndices.length,
    sourceBones:this.rows.length,missingSourceCount:this.missingSourceCount,scale:this.scale,
    maxMatchError:this.maxMatchError,maxUVError:this.maxUVError,minimumAbsoluteNormalDot:this.minimumAbsoluteNormalDot,
    editedNormalVertices:this.editedNormalVertices,
    reason:this.reason,method:'same-position, UV and normal verified native surface skinning; pelvis-relative authored motion'};}
}
