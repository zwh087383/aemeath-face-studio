import * as THREE from 'three';
import {nativeHairSource} from './native-hair-binding.js';

// Same handedness change as CUE4Parse's glTF mesh writer: (X,Y,Z) -> (X,Z,Y).
const convert = t => ({
  p: new THREE.Vector3(t.p[0], t.p[2], t.p[1]),
  q: new THREE.Quaternion(t.q[0], t.q[2], t.q[1], -t.q[3]).normalize(),
  s: new THREE.Vector3(t.s[0], t.s[2], t.s[1]),
});

/** One decoded full-pose clip. Time is explicit; neither host owns a separate clock. */
export class NativeClip {
  constructor(data) {
    if (data.schema !== 1 || data.additive || !(data.duration > 0) ||
        data.frames.length !== data.frameCount || data.frameCount < 1) throw Error('Unsupported native clip');
    this.data = data;
    this.indices = new Map(data.bones.map((b, i) => [b.name, i]));
    if (this.indices.size !== data.bones.length) throw Error('Duplicate source bone names');
    this.rest = data.bones.map((b, i) => {
      if (!Number.isInteger(b.parent) || b.parent >= i || b.parent < -1) throw Error('Source skeleton must be topologically ordered');
      if (![...b.p,...b.q,...b.s].every(Number.isFinite)) throw Error('Nonfinite bind pose');
      return convert(b);
    });
    this.frames = data.frames.map(frame => {
      if (frame.length !== data.bones.length) throw Error('Incomplete animation frame');
      return frame.map(t => {
        if (![...t.p, ...t.q, ...t.s].every(Number.isFinite)) throw Error('Nonfinite animation');
        return convert(t);
      });
    });
    this.local = this.rest.map(t => ({ p:t.p.clone(), q:t.q.clone(), s:t.s.clone() }));
    this.world = this.rest.map(() => ({ p:new THREE.Vector3(), q:new THREE.Quaternion(), s:new THREE.Vector3() }));
    this.updateWorld();
    this.restWorld = this.world.map(t => ({p:t.p.clone(), q:t.q.clone(), s:t.s.clone()}));
    this.time = 0;
  }
  updateWorld() {
    for (let i=0; i<this.local.length; i++) {
      const t=this.local[i], w=this.world[i], parent=this.data.bones[i].parent;
      if (parent<0) { w.p.copy(t.p);w.q.copy(t.q);w.s.copy(t.s); }
      else {
        const p=this.world[parent];
        w.p.copy(t.p).multiply(p.s).applyQuaternion(p.q).add(p.p);
        w.q.copy(p.q).multiply(t.q).normalize();w.s.copy(p.s).multiply(t.s);
      }
    }
  }
  sample(seconds) {
    if (!Number.isFinite(seconds)) throw Error('Invalid playback time');
    this.time=Math.max(0,Math.min(this.data.duration,seconds));
    const at=this.time/this.data.duration*(this.frames.length-1), a=Math.floor(at), b=Math.min(a+1,this.frames.length-1), f=at-a;
    for (let i=0;i<this.local.length;i++) {
      const t=this.local[i],x=this.frames[a][i],y=this.frames[b][i];
      t.p.lerpVectors(x.p,y.p,f);t.q.slerpQuaternions(x.q,y.q,f);t.s.lerpVectors(x.s,y.s,f);
    }
    this.updateWorld();return this;
  }
  applyToGLTF(root) {
    this.gltfNodes ??= new Map();
    let nodes=this.gltfNodes.get(root);
    if (!nodes) { nodes=this.data.bones.map(b=>root.getObjectByName(b.name));this.gltfNodes.set(root,nodes); }
    for(let i=0;i<nodes.length;i++) if(nodes[i]) {
      nodes[i].position.copy(this.local[i].p).multiplyScalar(.01);
      nodes[i].quaternion.copy(this.local[i].q);nodes[i].scale.copy(this.local[i].s);
    }
    root.updateMatrixWorld(true);root.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});
  }
}

const BODY = {
  '腰':'Bip001Pelvis','下半身':'Bip001Pelvis',
  '上半身':'Bip001Spine','上半身2':'Bip001Spine1','上半身1':'Bip001Spine2','首':'Bip001Neck','頭':'Bip001Head',
};
for(const [jp,side] of [['左','L'],['右','R']]) {
  for(const [target,source] of Object.entries({
    '肩':'Clavicle','腕':'UpperArm','ひじ':'Forearm','手首':'Hand',
    '足':'Thigh','ひざ':'Calf','足首':'Foot','つま先':'Toe0',
    '足D':'Thigh','ひざD':'Calf','足首D':'Foot','足先EX':'Toe0',
    '腕捩1':'UpArmTwist','腕捩2':'UpArmTwist1','腕捩3':'UpArmTwist2',
    '手捩1':'ForeTwist','手捩2':'ForeTwist1','手捩3':'ForeTwist1',
  })) BODY[jp+target]='Bip001'+side+source;
  for(const [finger,n] of [['親指',0],['人指',1],['中指',2],['薬指',3],['小指',4]]) {
    for(let k=0;k<3;k++) BODY[jp+finger+String.fromCharCode(0xff10+k+(n===0?0:1))]=`Bip001${side}Finger${n}${k===0?'':k}`;
  }
}

const CHILD = {
  '左腕':'左ひじ','左ひじ':'左手首','右腕':'右ひじ','右ひじ':'右手首',
  '左足':'左ひざ','左ひざ':'左足首','右足':'右ひざ','右ひざ':'右足首',
  '左足D':'左ひざD','左ひざD':'左足首D','右足D':'右ひざD','右ひざD':'右足首D',
};
function basis(forward, across) {
  const x=forward.clone().normalize(), z=new THREE.Vector3().crossVectors(x,across).normalize(), y=new THREE.Vector3().crossVectors(z,x).normalize();
  if(z.lengthSq()<.5)throw Error('Degenerate hand calibration');
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,z));
}

/** Bind-pose calibrated rotation retarget. Target bone lengths are never changed.
 * MMD grant/IK/physics must be OFF in this isolated host; duplicate D legs are
 * explicitly driven. Exact-name and audited rebuilt-hair aliases retain native timing.
 */
export class NativeRetarget {
  constructor(clip, mesh) {
    this.clip=clip;this.mesh=mesh;mesh.updateMatrixWorld(true);
    this.bones=new Map(mesh.skeleton.bones.map(b=>[b.name,b]));
    for(const name of ['腰','頭','上半身','上半身2','首',...Object.keys(CHILD),...Object.values(CHILD),
      ...['左','右'].flatMap(jp=>['手首','中指１','人指１','小指１'].map(n=>jp+n))]) {
      if(!this.bones.has(name))throw Error('Missing target bone '+name);
    }
    this.rest=new Map(mesh.skeleton.bones.map(b=>[b.name,{
      p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone(),
      wp:b.getWorldPosition(new THREE.Vector3()),wq:b.getWorldQuaternion(new THREE.Quaternion()),
    }]));
    const ratios=[];
    for(const [a,b,sa,sb] of [
      ['左足','左ひざ','Bip001LThigh','Bip001LCalf'],['右足','右ひざ','Bip001RThigh','Bip001RCalf'],
      ['上半身','上半身2','Bip001Spine','Bip001Spine1'],['首','頭','Bip001Neck','Bip001Head'],
    ]) ratios.push(this.rest.get(a).wp.distanceTo(this.rest.get(b).wp)/clip.restWorld[clip.indices.get(sa)].p.distanceTo(clip.restWorld[clip.indices.get(sb)].p));
    ratios.sort((a,b)=>a-b);this.scale=(ratios[1]+ratios[2])/2;
    const calibration=new Map();
    for(const [target,child] of Object.entries(CHILD)) {
      const a=clip.indices.get(BODY[target]),b=clip.indices.get(BODY[child]);
      calibration.set(target,new THREE.Quaternion().setFromUnitVectors(
        this.rest.get(child).wp.clone().sub(this.rest.get(target).wp).normalize(),
        clip.restWorld[b].p.clone().sub(clip.restWorld[a].p).normalize()));
    }
    for(const [jp,side] of [['左','L'],['右','R']]) {
      const tp=n=>this.rest.get(jp+n).wp, sp=n=>clip.restWorld[clip.indices.get('Bip001'+side+n)].p;
      const t=basis(tp('中指１').clone().sub(tp('手首')),tp('人指１').clone().sub(tp('小指１')));
      const s=basis(sp('Finger2').clone().sub(sp('Hand')),sp('Finger1').clone().sub(sp('Finger4')));
      const hand=s.multiply(t.invert());calibration.set(jp+'手首',hand);
      // Preserve palm roll, then account for the MMD edit's finger straightening.
      for(const [finger,offset] of [['親指',0],['人指',1],['中指',1],['薬指',1],['小指',1]]) {
        let correction=hand;
        for(let k=0;k<3;k++) {
          const name=jp+finger+String.fromCharCode(0xff10+k+offset);
          if(k<2) {
            const child=jp+finger+String.fromCharCode(0xff11+k+offset);
            const t=this.rest.get(child).wp.clone().sub(this.rest.get(name).wp).normalize().applyQuaternion(hand);
            const s=clip.restWorld[clip.indices.get(BODY[child])].p.clone().sub(clip.restWorld[clip.indices.get(BODY[name])].p).normalize();
            correction=new THREE.Quaternion().setFromUnitVectors(t,s).multiply(hand);
          }
          calibration.set(name,correction.clone());
        }
      }
      for(let k=1;k<=3;k++) {
        calibration.set(jp+'腕捩'+k,calibration.get(jp+'腕').clone());
        calibration.set(jp+'手捩'+k,calibration.get(jp+'ひじ').clone());
      }
    }
    const depth=b=>b.parent?1+depth(b.parent):0;
    this.mapping=[];
    for(const bone of mesh.skeleton.bones) {
      const hair=nativeHairSource(bone.name);
      const name=BODY[bone.name]??(clip.indices.has(bone.name)?bone.name:hair&&clip.indices.has(hair)?hair:null);
      if(!name)continue;
      const source=clip.indices.get(name);if(source===undefined)throw Error('Missing native bone '+name);
      this.mapping.push({bone,source,inv:clip.restWorld[source].q.clone().invert(),
        correction:(calibration.get(bone.name)??new THREE.Quaternion()).clone().multiply(this.rest.get(bone.name).wq)});
    }
    this.mapping.sort((a,b)=>depth(a.bone)-depth(b.bone));
    this.orderedBones=[...mesh.skeleton.bones].sort((a,b)=>depth(a)-depth(b));
    this.byBone=new Map(this.mapping.map(row=>[row.bone,row]));
    this.pelvis=clip.indices.get('Bip001Pelvis');
    this.pelvisOffset=this.rest.get('腰').wp.clone().sub(clip.restWorld[this.pelvis].p.clone().multiplyScalar(this.scale));
    this.q=new THREE.Quaternion();this.parentQ=new THREE.Quaternion();this.p=new THREE.Vector3();
    this.tmpPosition=new THREE.Vector3();this.tmpScale=new THREE.Vector3();
  }
  apply() {
    for(const [name,bone] of this.bones) {
      const r=this.rest.get(name);bone.position.copy(r.p);bone.quaternion.copy(r.q);bone.scale.copy(r.s);
    }
    const pelvis=this.clip.world[this.pelvis], delta=pelvis.q.clone().multiply(this.clip.restWorld[this.pelvis].q.clone().invert());
    this.p.copy(this.pelvisOffset).applyQuaternion(delta).add(pelvis.p.clone().multiplyScalar(this.scale));
    const waist=this.bones.get('腰');waist.parent.updateWorldMatrix(true,false);waist.position.copy(waist.parent.worldToLocal(this.p));
    this.mesh.updateMatrixWorld(true);
    // One parent-first pass avoids repeatedly traversing every descendant for
    // every mapped bone. Unmapped helper bones still inherit their parent's pose.
    for(const bone of this.orderedBones) {
      const row=this.byBone.get(bone);
      if(row) {
        this.q.copy(this.clip.world[row.source].q).multiply(row.inv).multiply(row.correction);
        bone.parent.matrixWorld.decompose(this.tmpPosition,this.parentQ,this.tmpScale);
        bone.quaternion.copy(this.parentQ.invert()).multiply(this.q).normalize();
      }
      bone.updateMatrix();bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld,bone.matrix);bone.matrixWorldNeedsUpdate=false;
    }
    this.mesh.skeleton.update();
  }
  snapshot() {
    const names=['腰','頭','左腕','左ひじ','左手首','右腕','右ひじ','右手首','左足','左ひざ','左足首','右足','右ひざ','右足首'];
    return {scale:this.scale,mapped:this.mapping.length,time:this.clip.time,
      nativeLongHairMapped:this.mapping.filter(row=>nativeHairSource(row.bone.name)).length,
      bones:Object.fromEntries(names.map(n=>[n,this.bones.get(n).getWorldPosition(new THREE.Vector3()).toArray()])),
      maxLengthError:Math.max(...[...this.bones].filter(([n])=>n!=='腰').map(([n,b])=>Math.abs(b.position.length()-this.rest.get(n).p.length()))),
    };
  }
}
