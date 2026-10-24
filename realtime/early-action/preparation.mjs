import {MotionController} from '../../preview/core/motion-controller.js';
import {FaceController} from '../../preview/core/controller.js';
import {CooutputDriver} from '../qwen/cooutput-driver.mjs';
import {EXPRESSIONS, GESTURES} from '../qwen/functioncall-driver.mjs';
import {assertMotionAllowed} from '../../preview/core/character-motion-policy.js';

const short = new Set(['nod','shake','tilt','glance','blink']);
const same = (a,b) => a && b && a.connectionId === b.connectionId && a.responseId === b.responseId && a.epoch === b.epoch;

/** Seconds, monotonic. Approach the existing preparation boundary without ever
 * entering the stroke before playback. On release preserve phase AND speed;
 * the 80ms acceleration affects only this clock handoff, not the stroke keys.
 */
export class PreparationClock {
  constructor(start, cap) { this.start=start;this.cap=cap;this.raw=0;this.velocity=1;this.release=null;this.lastWall=start; }
  sample(now, audio) {
    if(!Number.isFinite(now)||now<this.lastWall) return this.raw;
    if(!this.release) {
      if(audio.status==='paused'){this.start+=now-this.lastWall;this.lastWall=now;return this.raw;}
      const elapsed=now-this.start;
      this.raw=this.cap*(1-Math.exp(-elapsed/this.cap));this.velocity=Math.exp(-elapsed/this.cap);
      if(audio.status==='playing')this.release={raw:this.raw,velocity:this.velocity,media:audio.time};
    } else if(audio.status==='ended') {
      this.raw+=now-this.lastWall;this.velocity=1;
    } else {
      const x=Math.max(0,audio.time-this.release.media),tau=.08;
      this.raw=this.release.raw+x+(this.release.velocity-1)*tau*(1-Math.exp(-x/tau));
      this.velocity=1+(this.release.velocity-1)*Math.exp(-x/tau);
    }
    this.lastWall=now;return this.raw;
  }
}

/** Uses the original solver/profile and original retraction. No bone writer,
 * changed amplitude, new keyframes or cloned gesture at the voice boundary.
 */
export class PreparedMotionController extends MotionController {
  constructor(options) { super(options);this.preparations=new Map(); }
  prepare(cue, owner, now) {
    if(!this.active||this.epoch!==owner.epoch||this.preparations.size>=4)return false;
    assertMotionAllowed({id:cue.gesture});
    const def=this.profile.gestures[cue.gesture];
    if(!def||def.internal)return false;
    const accepted=this.enqueue({...cue,epoch:owner.epoch,clock:'wall',at:now});
    if(accepted)this.preparations.set(cue.id,{owner:{...owner},clock:new PreparationClock(now,.9*def.prepareEnd)});
    return accepted;
  }
  start(cue, now) {
    super.start(cue,now);
    const preparation=this.preparations.get(cue.id),g=this.gestures.find(g=>g.id===cue.id);
    if(preparation&&g)preparation.clock.cap=.9*g.def.prepareEnd*g.stretch/g.rate;
  }
  clockOf(item) {
    const preparation=this.preparations?.get(item.id);
    return preparation ? item.at+preparation.clock.raw : super.clockOf(item);
  }
  advancePreparation(now,audio) {
    for(const [id,p] of this.preparations) {
      if(p.owner.epoch!==this.epoch){this.preparations.delete(id);continue;}
      const g=this.gestures.find(g=>g.id===id);
      if(g?.recovering)continue;
      if(!g&&!this.pending.some(c=>c.id===id)){this.preparations.delete(id);continue;}
      if(!p.clock.release&&now-p.clock.start>2.5){
        this.pending=this.pending.filter(c=>c.id!==id);
        if(g)this.freeze(g,now,this.retractTime(g));
        p.expired=true;continue;
      }
      p.clock.sample(now,audio);
    }
  }
  preparationSnapshot() {
    return [...this.preparations].map(([id,p])=>({id,owner:p.owner,raw:p.clock.raw,velocity:p.clock.velocity,
      released:!!p.clock.release,expired:!!p.expired,cap:p.clock.cap}));
  }
}

/** The shared face controller normally freezes while buffering. Only an admitted
 * preparatory face cue may converge before FIRST playback; media pauses after
 * release retain the existing freeze contract. Articulation stays closed.
 */
export class PreparedFaceController extends FaceController {
  constructor(){super();this.preparation=null;}
  prepare(cue,owner,now){
    if(!this.active||this.epoch!==owner.epoch)return false;
    const accepted=this.enqueue({...cue,epoch:owner.epoch,clock:'wall',at:now,duration:4});
    if(accepted)this.preparation={id:cue.id,owner:{...owner},start:now,released:false};
    return accepted;
  }
  advancePreparation(now,audio){
    const p=this.preparation;if(!p)return;
    const cue=this.cues.find(c=>c.id===p.id);
    if(!cue||p.owner.epoch!==this.epoch||!this.active){this.preparation=null;return;}
    if(!p.released&&audio.status==='playing'){
      const age=now-p.start;cue.clock='audio';cue.at=audio.time-age;p.released=true;
    }else if(!p.released&&now-p.start>2.5){
      this.cues=this.cues.filter(c=>c.id!==p.id);this.preparation=null;
    }
  }
  update(now,dt,lip,idle,options={}){
    if(this.preparation&&!this.preparation.released&&this.active&&this.status==='paused'){
      const status=this.status;this.status='playing';
      try{return super.update(now,dt,lip,idle,{...options,paused:false,mouthMode:'closed'});}
      finally{this.status=status;}
    }
    return super.update(now,dt,lip,idle,options);
  }
}

export class EarlyActionDriver {
  constructor(session,owner,{early=false,clock=()=>performance.now()/1000}={}){
    this.session=session;this.owner=owner;this.early=early;this.clock=clock;
    this.fallback=new CooutputDriver(session,owner,'D');this.calls=new Set();this.revoked=false;
  }
  cancel(){this.revoked=true;this.fallback.cancel();}
  accept(event){
    const s=this.session,a=s.audio.snapshot();
    if(this.revoked||s.owner!==this.owner||!same(event.owner??this.owner,this.owner)||event.responseId!==this.owner.responseId||s.snapshot?.().revoked)
      return {accepted:false,reason:'revoked_or_stale_owner'};
    if(!['buffering','playing','paused'].includes(a.status))return {accepted:false,reason:'audio_closed'};
    if(event.name!=='perform_avatar'||!/^[-A-Za-z0-9_.:]{1,100}$/.test(event.callId??'')||typeof event.arguments!=='string'||event.arguments.length>1024)
      return {accepted:false,reason:'invalid_tool'};
    let p;try{p=JSON.parse(event.arguments);}catch{return {accepted:false,reason:'invalid_json'};}
    if(!p||Array.isArray(p)||Object.keys(p).sort().join(',')!=='expression,gesture'||!EXPRESSIONS.includes(p.expression)||!GESTURES.includes(p.gesture))
      return {accepted:false,reason:'invalid_plan'};
    if(this.calls.has(event.callId)||this.calls.size>=1)return {accepted:false,reason:'duplicate_or_excess_call'};
    this.calls.add(event.callId);
    if(!this.early||a.status!=='buffering'||a.time>0)return {...this.fallback.accept(event),prepared:false};
    const at=this.clock(),prefix=`early:e${this.owner.epoch}:c1`;
    let face=false,motion=false;
    try{
      face=s.face.prepare({id:prefix+':face',kind:'expression',preset:p.expression,strength:.65},this.owner,at);
      if(p.gesture!=='none'){
        if(short.has(p.gesture))motion=s.enqueue({id:prefix+':motion',kind:'action',action:p.gesture,strength:.65,at:0},this.owner).accepted;
        else motion=s.motion.prepare({id:prefix+':motion',kind:'gesture',gesture:p.gesture,strength:.65},this.owner,at);
      }
    }catch{return {accepted:false,reason:'preparation_failed',plan:p};}
    return {accepted:face,prepared:face,bodyPrepared:motion&&!short.has(p.gesture),plan:p,id:prefix,at};
  }
}
