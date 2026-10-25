import {PreparedMotionController,PreparedFaceController} from '../early-action/preparation.mjs';
import {FaceController} from '../../preview/core/controller.js';
import {CooutputDriver} from '../qwen/cooutput-driver.mjs';
import {EXPRESSIONS,GESTURES} from '../qwen/functioncall-driver.mjs';

const same=(a,b)=>!!a&&!!b&&a.connectionId===b.connectionId&&a.responseId===b.responseId&&a.epoch===b.epoch;
const short=new Set(['nod','shake','tilt','glance','blink']);
const closed=new Set(['ended','cancelled','fault','idle']);

/** Only the clock differs from the existing preparation controller. The same
 * authored gesture instance, keyframes, solver, amplitude and rate are retained.
 * `marker.wallTime` is the AudioContext marker mapped to the monotonic wall clock.
 */
export class VoicedPreparationClock {
  constructor(start,cap){this.start=start;this.cap=cap;this.raw=0;this.velocity=1;this.release=null;this.lastWall=start;this.waitAge=0;}
  sample(now,audio,marker=null){
    if(!Number.isFinite(now)||now<this.lastWall)return this.raw;
    const delta=now-this.lastWall;
    if(!this.release){
      if(audio.status==='paused'){this.start+=delta;this.lastWall=now;return this.raw;}
      const releaseWall=marker?.reached?Math.max(this.lastWall,Math.min(now,marker.wallTime??now)):now;
      this.waitAge+=releaseWall-this.lastWall;
      this.raw=this.cap*(1-Math.exp(-this.waitAge/this.cap));
      this.velocity=Math.exp(-this.waitAge/this.cap);
      if(marker?.reached)this.release={raw:this.raw,velocity:this.velocity,media:marker.mediaTime,wall:releaseWall};
    }
    if(this.release){
      if(audio.status==='ended'){this.raw+=delta;this.velocity=1;}
      else if(audio.status!=='paused'&&audio.status!=='buffering'){
        const x=Math.max(0,audio.time-this.release.media),tau=.08;
        this.raw=this.release.raw+x+(this.release.velocity-1)*tau*(1-Math.exp(-x/tau));
        this.velocity=1+(this.release.velocity-1)*Math.exp(-x/tau);
      }
    }
    this.lastWall=now;return this.raw;
  }
}

export class VoicedPreparedMotionController extends PreparedMotionController {
  prepare(cue,owner,now){
    const accepted=super.prepare(cue,owner,now);
    if(accepted){const p=this.preparations.get(cue.id);p.clock=new VoicedPreparationClock(now,p.clock.cap);}
    return accepted;
  }
  abortPreparations(owner,now=this.now){
    for(const [id,p] of this.preparations){
      if(!same(p.owner,owner))continue;
      this.pending=this.pending.filter(c=>c.id!==id);
      const g=this.gestures.find(g=>g.id===id);
      if(g&&!g.recovering)this.freeze(g,now,this.retractTime(g));
      this.preparations.delete(id);
    }
  }
  cancel(epoch,now=this.now){
    for(const p of [...this.preparations.values()])if(p.owner.epoch===epoch)this.abortPreparations(p.owner,now);
    return super.cancel(epoch,now);
  }
  advancePreparation(now,audio,marker=null){
    for(const [id,p] of this.preparations){
      if(p.owner.epoch!==this.epoch){this.preparations.delete(id);continue;}
      const g=this.gestures.find(g=>g.id===id);
      if(g?.recovering)continue;
      if(!g&&!this.pending.some(c=>c.id===id)){this.preparations.delete(id);continue;}
      p.clock.sample(now,audio,marker);
      if(!p.clock.release&&(closed.has(audio.status)||p.clock.waitAge>2.5)){
        this.pending=this.pending.filter(c=>c.id!==id);
        if(g)this.freeze(g,now,this.retractTime(g));
        p.expired=true;
      }
    }
  }
}

/** Preserve the authored face recipe and articulation ownership. The face may
 * converge during initial buffering/silent PCM, but not during explicit pause.
 * After release both its cue clock and displayed convergence follow playback.
 */
export class VoicedPreparedFaceController extends PreparedFaceController {
  prepare(cue,owner,now){
    const accepted=super.prepare(cue,owner,now);
    if(accepted)Object.assign(this.preparation,{lastWall:now,age:0,paused:false});
    return accepted;
  }
  abortPreparation(owner){
    if(!same(this.preparation?.owner,owner))return;
    this.cues=this.cues.filter(c=>c.id!==this.preparation.id);this.preparation=null;
  }
  cancel(epoch){if(this.preparation?.owner.epoch===epoch)this.abortPreparation(this.preparation.owner);return super.cancel(epoch);}
  advancePreparation(now,audio,marker=null){
    const p=this.preparation;if(!p)return;
    const cue=this.cues.find(c=>c.id===p.id);
    if(!cue||p.owner.epoch!==this.epoch||!this.active){this.preparation=null;return;}
    p.paused=audio.status==='paused';
    if(!p.released){
      const boundary=marker?.reached?Math.max(p.lastWall,Math.min(now,marker.wallTime??now)):now;
      if(!p.paused)p.age+=Math.max(0,boundary-p.lastWall);
      cue.at=now-p.age;
      if(marker?.reached&&!p.paused){cue.clock='audio';cue.at=marker.mediaTime-p.age;p.released=true;}
      else if(closed.has(audio.status)||p.age>2.5){this.abortPreparation(p.owner);return;}
    }
    p.lastWall=now;
  }
  update(now,dt,lip,idle,options={}){
    const preparing=this.preparation&&!this.preparation.released&&this.active;
    const status=this.status;
    if(preparing&&!this.preparation.paused)this.status='playing';
    try{return FaceController.prototype.update.call(this,now,dt,lip,idle,preparing
      ?{...options,paused:this.preparation.paused,mouthMode:'closed'}:options);}
    finally{this.status=status;}
  }
}

/** Every group passes the same validated two-field command to this adapter.
 * P's source role translation is trusted only at the bridge; this driver still
 * checks the current response identity and epoch. Partial arguments never enter.
 */
export class VoicedActionDriver {
  constructor(session,owner,{clock=()=>performance.now()/1000}={}){
    this.session=session;this.owner=owner;this.clock=clock;this.calls=new Set();this.revoked=false;this.pendingShort=null;
    this.fallback=new CooutputDriver(session,owner,'D',{leadSeconds:0});
  }
  cancel(){
    this.revoked=true;this.pendingShort=null;this.fallback.cancel();
    this.session.motion.abortPreparations(this.owner,this.clock());this.session.face.abortPreparation(this.owner);
  }
  advance(marker){
    if(this.revoked||!this.pendingShort||!marker?.reached)return;
    const pending=this.pendingShort;this.pendingShort=null;
    if(this.session.owner===this.owner&&!this.session.snapshot?.().revoked){
      this.shortAdmission=this.session.enqueue({...pending,at:this.session.audio.snapshot().time},this.owner);
    }
  }
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
    if(s.audio.playbackMarker()?.reached)return {...this.fallback.accept(event),prepared:false};
    const at=this.clock(),prefix=`early:e${this.owner.epoch}:c1`;
    let face=false,motion=p.gesture==='none';
    try{
      face=s.face.prepare({id:prefix+':face',kind:'expression',preset:p.expression,strength:.65},this.owner,at);
      if(p.gesture!=='none'){
        if(short.has(p.gesture)){this.pendingShort={id:prefix+':motion',kind:'action',action:p.gesture,strength:.65};motion=true;}
        else motion=s.motion.prepare({id:prefix+':motion',kind:'gesture',gesture:p.gesture,strength:.65},this.owner,at);
      }
    }catch{return {accepted:false,reason:'preparation_failed',plan:p};}
    return {accepted:face&&motion,prepared:face,bodyPrepared:motion&&p.gesture!=='none'&&!short.has(p.gesture),shortDeferred:!!this.pendingShort,plan:p,id:prefix,at};
  }
}
