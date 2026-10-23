// Original event-conditioned performance: wait for a speaker's self-correction,
// then acknowledge only an explicitly understood completion. No WAI state writes.
// Seconds, radians, and PMX model units (~20.5 character height). Not game curves.
export const REACTION_ID = 'repair-wait-ack';
export const REACTION_META = Object.freeze({
  id: REACTION_ID, name: '等你改完，再确认', source: 'authored-skill-forward-test',
  trigger: 'A response is being prepared when the speaker begins self-correction.',
  forbidden: ['unresolved understanding', 'VAD silence alone', 'speaking or locomotion owned by another layer'],
  mouthOwnership: 'Speech owns visemes, mouth opening and closures; this layer owns brows/eyes/corners only.',
  phases: ['prepare', 'arrest', 'wait', 'confirm', 'recover', 'cancelled', 'idle'],
  reuse: 'Native Stand2 + exact Rib_Stand2; existing arm IK and PMX morph aliases.',
});
const clamp = (x, lo=0, hi=1) => Math.max(lo, Math.min(hi, x));
export const smoother = x => { x=clamp(x); return x*x*x*(x*(x*6-15)+10); };
const ZERO = Object.freeze({arm:0,lift:0,forward:0,out:0,palm:0,curl:0,
  lean:0,twist:0,pitch:0,roll:0,browUp:0,browFocus:0,browSad:0,eyeWide:0,eyeSoft:0,smileR:0,smileL:0});
const PREPARE = {...ZERO,arm:1,lift:2.05,forward:2.35,out:-.55,palm:.45,curl:-.1,
  lean:.055,twist:-.025,pitch:-.025,browUp:.2,eyeWide:.12,smileR:.1,smileL:.1};
const WAIT = {...ZERO,arm:1,lift:1.28,forward:2.65,out:-.45,palm:1,curl:-.12,
  lean:-.028,twist:-.018,pitch:.022,roll:.025,browUp:.12,browFocus:.2,browSad:.08,eyeWide:.05};
const ACCEPT = {...WAIT,lift:1.1,forward:2.5,lean:.09,pitch:.115,roll:0,
  browUp:0,browFocus:0,browSad:0,eyeWide:0,eyeSoft:.22,smileR:.26,smileL:.23};
const mix = (a,b,t) => Object.fromEntries(Object.keys(ZERO).map(k=>[k,a[k]+(b[k]-a[k])*smoother(t)]));
const finite = value => Number.isFinite(value);
// A quintic Bezier with P0=start, P1=start+vT/5, P2=start+2vT/5,
// and P3=P4=P5=target preserves initial velocity, starts at zero acceleration,
// and arrives with zero velocity/acceleration. Keeping ALL six control points
// inside the channel's authored range bounds the entire curve by convexity.
export const REACTION_LIMITS=Object.freeze(Object.fromEntries(Object.keys(ZERO).map(k=>[
  k,Object.freeze([Math.min(ZERO[k],PREPARE[k],WAIT[k],ACCEPT[k]),Math.max(ZERO[k],PREPARE[k],WAIT[k],ACCEPT[k])])
])));
const continueValue=(start,velocity,target,age,duration)=>{
  if(age<=0)return start;if(age>=duration)return target;
  const u=age/duration,b=u-6*u**3+8*u**4-3*u**5;
  return start+(target-start)*smoother(u)+velocity*duration*b;
};

/** Pure state machine. Pausing freezes its explicit local clock, including recovery.
 * All commands carry correlation metadata; cancellation advances epoch immediately.
 * A controller receipt means acceptance only. Completed is emitted after recovery. */
export class SkillReaction {
  constructor({sessionId='skill-lab',epoch=1}={}) {
    this.sessionId=sessionId; this.epoch=epoch; this.time=0; this.paused=false;
    this.phase='idle'; this.stageAt=0; this.active=null; this.seen=new Set();
    this.receipts=[]; this.from={...ZERO}; this.velocity={...ZERO};
    this.durations={};
  }
  receipt(ok,reason) {const r={ok,reason,time:this.time,epoch:this.epoch};this.receipts.push(r);if(this.receipts.length>30)this.receipts.shift();return r;}
  start(command={}) {
    const c={sessionId:this.sessionId,epoch:this.epoch,turnId:'turn-1',source:'offline-test-event',
      dedupeKey:'repair-1',expiresAt:this.time+18,cancelId:'turn-1',...command};
    if(c.sessionId!==this.sessionId||c.epoch!==this.epoch)return this.receipt(false,'stale-context');
    if(!finite(c.expiresAt)||c.expiresAt<=this.time||!c.dedupeKey||!c.turnId||!c.source||!c.cancelId)return this.receipt(false,'invalid-or-expired');
    if(this.phase!=='idle')return this.receipt(false,'busy');
    if(this.seen.has(c.dedupeKey))return this.receipt(false,'duplicate');
    this.active=c;this.seen.add(c.dedupeKey);this.phase='prepare';this.stageAt=this.time;
    return this.receipt(true,'accepted-not-yet-performed');
  }
  valid(c={}) {return this.active&&c.sessionId===this.sessionId&&c.epoch===this.epoch&&c.turnId===this.active.turnId&&c.cancelId===this.active.cancelId;}
  command(extra={}) {return {...this.active,...extra};}
  captureTransition(maxDuration) {
    const p=this.pose(),ahead=this.pose(.000001);
    this.from=p;this.velocity={};this.durations={};
    for(const k of Object.keys(ZERO)){
      let velocity=(ahead[k]-p[k])/.000001;if(Math.abs(velocity)<1e-8)velocity=0;
      const [lo,hi]=REACTION_LIMITS[k],room=velocity>0?hi-p[k]:p[k]-lo;
      this.velocity[k]=velocity;
      this.durations[k]=velocity===0?maxDuration:Math.min(maxDuration,Math.max(0,room)*2.5/Math.abs(velocity));
    }
  }
  continueTo(target,age) {return Object.fromEntries(Object.keys(ZERO).map(k=>[k,
    continueValue(this.from[k],this.velocity[k],target[k],age,this.durations[k])
  ]));}
  correction(command={}) {
    if(!this.valid(command))return this.receipt(false,'stale-context');
    if(this.phase!=='prepare')return this.receipt(false,'wrong-phase');
    this.captureTransition(.52);this.phase='arrest';this.stageAt=this.time;
    return this.receipt(true,'waiting-for-understood-completion');
  }
  confirm(command={}) {
    if(!this.valid(command))return this.receipt(false,'stale-context');
    if(command.understood!==true)return this.receipt(false,'understanding-not-confirmed');
    if(command.speakerCompleted!==true||command.partnerVoicing!==false)return this.receipt(false,'speaker-not-finished');
    if(!['arrest','wait'].includes(this.phase))return this.receipt(false,'wrong-phase');
    this.captureTransition(.36);this.phase='confirm';this.stageAt=this.time;
    return this.receipt(true,'confirmation-started');
  }
  interrupt(command={}) {
    // Empty payload is the trusted local cancel button/expiry. External owners
    // must provide the complete identity, including session and turn.
    if(Object.keys(command).length&&!this.valid(command))return this.receipt(false,'stale-context');
    if(this.phase==='idle'||this.phase==='cancelled')return this.receipt(false,'nothing-active');
    this.captureTransition(.9);
    this.phase='cancelled';this.stageAt=this.time;this.epoch++;
    return this.receipt(true,'cancelled-old-epoch-revoked');
  }
  pause(value=true) {this.paused=Boolean(value);return this.snapshot();}
  advance(dt) {
    if(!finite(dt)||dt<0)throw Error('Expected finite nonnegative seconds');
    if(this.paused)return this.snapshot();
    const targetTime=this.time+dt;
    const completion=['confirm','recover'].includes(this.phase)?this.stageAt+1.8:this.phase==='cancelled'?this.stageAt+.9:Infinity;
    const expiry=this.active&&this.phase!=='cancelled'?this.active.expiresAt:Infinity;
    // Crossing several boundaries in one delayed frame must preserve chronology:
    // an already completed performance cannot turn into a later expiry cancel.
    if(completion<=targetTime+1e-9&&completion<=expiry){
      const cancelled=this.phase==='cancelled';this.time=completion;this.phase='idle';this.active=null;
      this.receipt(true,cancelled?'returned-after-cancel':'performed-and-completed');this.time=targetTime;return this.snapshot();
    }
    if(expiry<=targetTime){this.time=expiry;this.interrupt();return this.advance(targetTime-expiry);}
    this.time=targetTime;
    const age=this.time-this.stageAt;
    if(this.phase==='arrest'&&age+1e-9>=.52){this.phase='wait';this.stageAt+=.52;}
    if(this.phase==='confirm'&&age+1e-9>=.78)this.phase='recover';
    return this.snapshot();
  }
  pose(offset=0) {
    const age=Math.max(0,this.time-this.stageAt+offset);
    if(this.phase==='idle')return {...ZERO};
    if(this.phase==='prepare')return mix(ZERO,PREPARE,age/.68);
    if(this.phase==='arrest')return this.continueTo(WAIT,age);
    if(this.phase==='wait')return {...WAIT};
    if(this.phase==='confirm'||this.phase==='recover') {
      if(age<.36)return this.continueTo(ACCEPT,age);
      const soften={...ACCEPT,pitch:.018,lean:.04,eyeSoft:.12};
      if(age<.78)return mix(ACCEPT,soften,(age-.36)/.42);
      return mix(soften,ZERO,(age-.78)/1.02);
    }
    if(this.phase==='cancelled')return this.continueTo(ZERO,age);
    return {...ZERO};
  }
  snapshot() {return {id:REACTION_ID,sessionId:this.sessionId,epoch:this.epoch,time:this.time,phase:this.phase,
    stageAge:this.time-this.stageAt,paused:this.paused,active:this.active?{...this.active}:null,
    pose:this.pose(),receipts:this.receipts.map(r=>({...r}))};}
}

export function reactionFace(pose) {
  return {B_Up_Add:pose.browUp,S_20:pose.browFocus,B_Sad:pose.browSad,E_Stare:pose.eyeWide,
    E_Sad:pose.eyeSoft,M_Smile_R:pose.smileR,M_Smile_L:pose.smileL};
}

/** Deterministic review script; automatic events are only this demo, not runtime logic. */
export function reviewAt(time,{complete=true}={}) {
  if(!finite(time)||time<0)throw Error('Invalid review time');
  const c=new SkillReaction();c.start();
  for(const [at,event] of [[.64,'correction'],...(complete?[[2.65,'confirm']]:[])]) {
    if(time<at)break;c.advance(at-c.time);c[event](c.command({understood:true,speakerCompleted:true,partnerVoicing:false}));
  }
  c.advance(time-c.time);return c;
}
