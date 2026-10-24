import * as THREE from 'three';

const EPS = 1e-4;
const clone = pose => pose.map(r => ({p:r.p.clone(),q:r.q.clone(),s:r.s.clone()}));
const log = q => {
  const value=q.clone().normalize(); if(value.w<0)value.set(-value.x,-value.y,-value.z,-value.w);
  const n=Math.hypot(value.x,value.y,value.z);
  return n<1e-10?new THREE.Vector3(2*value.x,2*value.y,2*value.z):new THREE.Vector3(value.x,value.y,value.z).multiplyScalar(2*Math.atan2(n,value.w)/n);
};
const exp = v => {const a=v.length();return a<1e-10?new THREE.Quaternion(v.x/2,v.y/2,v.z/2,1).normalize():new THREE.Quaternion().setFromAxisAngle(v.clone().multiplyScalar(1/a),a);};
const diff = (a,b,dt) => a.map((r,i)=>({p:b[i].p.clone().sub(r.p).multiplyScalar(1/dt),
  q:log(r.q.clone().invert().multiply(b[i].q)).multiplyScalar(1/dt),s:b[i].s.clone().sub(r.s).multiplyScalar(1/dt)}));
const finite = pose => pose.every(r=>[...r.p,...r.q,...r.s].every(Number.isFinite)&&Math.abs(r.q.length()-1)<1e-6);

/** Local-pose inertial residual. These are newly chosen transition equations,
 * not recovered game formulas. r(0),r'(0) preserve the actual displayed pose and
 * its measured tangent. The residual reaches zero value/velocity/acceleration.
 * This is kinematic continuity, not a foot/contact/collision solver. */
export class NativePoseBridge {
  constructor({current,velocity,incoming,incomingFuture,duration=.4,derivativeStep=EPS}) {
    if(!finite(current)||!finite(incoming)||!finite(incomingFuture)||current.length!==incoming.length||velocity.length!==current.length||!(duration>0))throw Error('Invalid bridge pose');
    this.duration=duration;
    this.rows=current.map((r,i)=>{
      const base=incoming[i], next=incomingFuture[i], v=velocity[i];
      const d0=log(base.q.clone().invert().multiply(r.q));
      // Numerically differentiate the relative quaternion in the SAME tangent
      // chart. Subtracting angular vectors directly would be wrong for large
      // orientation differences around different axes.
      const predicted=r.q.clone().multiply(exp(v.q.clone().multiplyScalar(derivativeStep)));
      const d1=log(next.q.clone().invert().multiply(predicted)).sub(d0).multiplyScalar(1/derivativeStep);
      return {p:r.p.clone().sub(base.p),pv:v.p.clone().sub(next.p.clone().sub(base.p).multiplyScalar(1/derivativeStep)),
        q:d0,qv:d1,s:r.s.clone().sub(base.s),sv:v.s.clone().sub(next.s.clone().sub(base.s).multiplyScalar(1/derivativeStep))};
    });
  }
  apply(incoming,seconds) {
    const u=Math.max(0,Math.min(1,seconds/this.duration)),T=this.duration;
    // Quintic Hermite bases for a value and first derivative at the start,
    // with zero second derivative there and value/velocity/acceleration at end.
    const h0=1-10*u**3+15*u**4-6*u**5,h1=T*(u-6*u**3+8*u**4-3*u**5);
    return incoming.map((r,i)=>{const d=this.rows[i];return {p:r.p.clone().addScaledVector(d.p,h0).addScaledVector(d.pv,h1),
      q:r.q.clone().multiply(exp(d.q.clone().multiplyScalar(h0).addScaledVector(d.qv,h1))).normalize(),
      s:r.s.clone().addScaledVector(d.s,h0).addScaledVector(d.sv,h1)};});
  }
}

/** A bounded kinematic stop from the CURRENT pose. It never teleports to Stand2.
 * Angular displacement is capped by lengthening/shortening the stop clock,
 * never by replacing the initial velocity. It does not claim physical support. */
export class NativePoseStop {
  constructor(current,velocity,{duration=.4,maxRotationRadians=.5,maxPositionDistance=.7,positionIndices=null}={}) {
    if(!finite(current)||velocity.length!==current.length||velocity.some(v=>![...v.p,...v.q,...v.s].every(Number.isFinite))||!(duration>0)||!(maxRotationRadians>0)||!(maxPositionDistance>0))throw Error('Invalid stop pose');
    this.current=clone(current);this.velocity=velocity;this.positionIndices=positionIndices;
    const angular=Math.max(EPS,...velocity.map(v=>v.q.length()));
    const linear=Math.max(EPS,...velocity.filter((_,i)=>!positionIndices||positionIndices.has(i)).map(v=>v.p.length()));
    this.duration=Math.min(duration,2*maxRotationRadians/angular,2*maxPositionDistance/linear);
    if(!(this.duration>0)||!Number.isFinite(this.duration))throw Error('Unbounded stop velocity');
  }
  sample(seconds) {
    const u=Math.max(0,Math.min(1,seconds/this.duration));
    // v(t)=v0*(1-3u^2+2u^3); integral(0..t) reaches T/2.
    const at=this.duration*(u-u**3+.5*u**4);
    return this.current.map((r,i)=>{const v=this.velocity[i];return {p:r.p.clone().addScaledVector(v.p,at),
      q:r.q.clone().multiply(exp(v.q.clone().multiplyScalar(at))).normalize(),s:r.s.clone().addScaledVector(v.s,at)};});
  }
}

export function captureNativePose(nodes) {return nodes.map(node=>({p:node.position.clone(),q:node.quaternion.clone(),s:node.scale.clone()}));}
export function applyNativePose(nodes,pose) {
  if(nodes.length!==pose.length||!finite(pose))throw Error('Invalid applied native pose');
  for(let i=0;i<nodes.length;i++){nodes[i].position.copy(pose[i].p);nodes[i].quaternion.copy(pose[i].q);nodes[i].scale.copy(pose[i].s);}
}
export {clone as cloneNativePose, diff as nativePoseVelocity, finite as finiteNativePose};

/** Explicit-clock phase player. It knows exact source-directory member IDs;
 * caller supplies a sampler backed by real NativeClip/NativeRetarget layers.
 * No model, speech or WAI state is called. Every plan remains preview-only. */
export class NativeBehaviorPlayer {
  constructor({plan,sample,initialPose,initialVelocity=null,bridgeSeconds=.4,repeat=1,align=null,stopOptions={}}) {
    if(!Array.isArray(plan)||!plan.length||plan.some(p=>!(p.duration>0)||!p.id))throw Error('Invalid native behavior plan');
    this.plan=plan;this.sampler=sample;this.initialPose=clone(initialPose);this.bridgeSeconds=bridgeSeconds;this.repeat=Math.max(1,Math.floor(repeat));this.aligner=align;this.stopOptions=stopOptions;
    if(initialVelocity&&(initialVelocity.length!==initialPose.length||initialVelocity.some(v=>![...v.p,...v.q,...v.s].every(Number.isFinite))))throw Error('Invalid entry velocity');
    this.initialVelocity=initialVelocity?.map(v=>({p:v.p.clone(),q:v.q.clone(),s:v.s.clone()}))??initialPose.map(()=>({p:new THREE.Vector3(),q:new THREE.Vector3(),s:new THREE.Vector3()}));
    this.epoch=0;this.reset();
  }
  reset() {
    this.epoch++;this.time=0;this.paused=false;this.cancelled=false;this.events=[];this.index=0;this.cycle=0;this.state='playing';
    this.stop=null;this.stopAt=null;this.displayed=clone(this.initialPose);this.startSegment(0,0,this.initialPose,this.initialVelocity);
    return this.snapshot();
  }
  currentPlan() {return this.plan[this.index];}
  rawSample(plan,t){const pose=this.sampler(plan.id,Math.max(0,Math.min(plan.duration,t)));if(!finite(pose))throw Error('Nonfinite native behavior pose');return pose;}
  sampleAt(plan,t) {return this.poseTransform(this.rawSample(plan,t));}
  startSegment(index,origin,current,velocity) {
    if(index!==this.index)this.cycle=0;
    this.index=index;this.origin=origin;const plan=this.currentPlan();
    const raw=this.rawSample(plan,0);this.poseTransform=this.aligner?.(current,raw)??(pose=>pose);
    const incoming=this.poseTransform(raw),future=this.sampleAt(plan,EPS);
    this.bridge=new NativePoseBridge({current,velocity,incoming,incomingFuture:future,duration:Math.min(this.bridgeSeconds,plan.duration*.45)});
    this.events.push({type:'phase',id:plan.id,phase:plan.phase,at:origin,automaticEligible:false});
  }
  evaluate(time) {
    if(this.stop)return this.stop.sample(Math.max(0,time-this.stopAt));
    const local=Math.max(0,time-this.origin),incoming=this.sampleAt(this.currentPlan(),local);
    return this.bridge.apply(incoming,local);
  }
  velocityAt(time) {
    const local=time-(this.stop?this.stopAt:this.origin);
    if(local>EPS)return diff(this.evaluate(time-EPS),this.evaluate(time),EPS);
    return diff(this.evaluate(time),this.evaluate(time+EPS),EPS);
  }
  boundary(time) {
    const outgoing=this.evaluate(time),velocity=this.velocityAt(time),entry=this.currentPlan();
    let next=this.index+1;
    if(entry.phase==='loop'&&++this.cycle<this.repeat)next=this.index;
    if(next<this.plan.length)this.startSegment(next,time,outgoing,velocity);
    else {this.stop=new NativePoseStop(outgoing,velocity,this.stopOptions);this.stopAt=time;this.state='settling';this.events.push({type:'kinematic-stop',at:time,reason:'Source endpoint; support and semantic exit unapproved'});}
  }
  advance(seconds) {
    if(!Number.isFinite(seconds)||seconds<0)throw Error('Nonmonotonic native clock');
    if(this.paused)return this.snapshot();
    const target=this.time+seconds;
    let guard=0;
    while(!this.stop&&target>=this.origin+this.currentPlan().duration&&guard++<10000)this.boundary(this.origin+this.currentPlan().duration);
    if(guard>=10000)throw Error('Native phase iteration limit');
    this.time=target;this.displayed=this.evaluate(target);
    if(this.stop&&target>=this.stopAt+this.stop.duration)this.state=this.cancelled?'cancelled-held':'complete-held';
    return this.snapshot();
  }
  cancel({epoch=this.epoch,useEnd=false}={}) {
    if(epoch!==this.epoch)return {accepted:false,reason:'Stale epoch'};
    if(this.cancelled)return {accepted:false,reason:'Already cancelled'};
    const current=this.evaluate(this.time),velocity=this.velocityAt(this.time);this.cancelled=true;
    const end=this.plan.findIndex(p=>p.phase==='end');
    // Direct End is opt-in PREVIEW only. No low-motion or source endpoint flag
    // silently authorizes an arbitrary-phase End or a physical contact change.
    const enterEnd=useEnd&&end>=0&&this.index!==end;
    if(enterEnd){this.stop=null;this.startSegment(end,this.time,current,velocity);this.state='cancel-exit-preview';}
    else {this.stop=new NativePoseStop(current,velocity,this.stopOptions);this.stopAt=this.time;this.state='cancel-settling';}
    this.events.push({type:'cancel',at:this.time,epoch:this.epoch,route:enterEnd?'same-source-End-preview':'bounded-kinematic-stop',supportVerified:false});
    this.displayed=this.evaluate(this.time);return {accepted:true,...this.snapshot()};
  }
  pause(value=true){this.paused=Boolean(value);return this.snapshot();}
  seek(time){if(!Number.isFinite(time)||time<0)throw Error('Invalid seek');const pause=this.paused;this.reset();this.advance(time);this.pause(pause);return this.snapshot();}
  pose(){return this.displayed;}
  snapshot(){return {time:this.time,state:this.state,epoch:this.epoch,paused:this.paused,cancelled:this.cancelled,id:this.currentPlan().id,
    phase:this.currentPlan().phase,phaseTime:this.time-this.origin,stopSeconds:this.stop?.duration??null,events:this.events.slice(-30),automaticEligible:false};}
}
