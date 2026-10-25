import {AVATAR_CATALOG} from '../avatar/controller-bridge.mjs';
import {assertMotionAllowed} from '../../preview/core/character-motion-policy.js';

export const ACTION_INTENTS=Object.freeze(['none','greet','explain','listen','comfort','agree','disagree']);
const CANDIDATES=Object.freeze({
  greet:{gesture:'wave',kind:'gesture',parts:['arms','torso'],cooldown:4,early:true},
  explain:{gesture:'explain',kind:'gesture',parts:['arms','torso'],cooldown:3,early:true},
  comfort:{gesture:'comfort',kind:'gesture',parts:['arms','torso'],cooldown:4,early:false},
  agree:{gesture:'nod',kind:'action',parts:['head'],cooldown:1.5,early:false},
  disagree:{gesture:'shake',kind:'action',parts:['head'],cooldown:1.5,early:false},
});
const active=new Set(['buffering','playing','paused']);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const same=(a,b)=>!!a&&!!b&&a.connectionId===b.connectionId&&a.responseId===b.responseId&&a.epoch===b.epoch;
const clone=value=>value==null?value:structuredClone(value);
const uncertain=text=>/[“”「」『』"'《》]|如果|假如|假设|例如|比如|他说|她说|引用|这句话/.test(text);
const forbid=text=>/(不要|别|不必|无需|不用|不需要|禁止|不能|不许).{0,10}(挥|招呼|动作|动起来|点头|摇头|安慰)/.test(text);

/** Conservative local checks, not a second language model. Unknown means keep
 * still. A planner chooses a purpose; it cannot authorize its own execution. */
export function immediateIntentEvidence(intent,text){
  if(typeof text!=='string'||!text||text.length>8192||uncertain(text)||forbid(text))return false;
  if(intent==='greet')return /挥(一挥)?手|挥挥手|打个招呼|你好|嗨|哈喽|我回来啦|我来啦|早上好|晚上好|再见/.test(text);
  if(intent==='explain')return /解释|比较|对比|区别|为什么|怎么|如何|分析|说明|讲讲|讲一下/.test(text);
  return false;
}

/** Only a complete first reply sentence can confirm a stance. Quoted, uncertain,
 * hypothetical, contradictory or question-shaped statements deliberately fail. */
export function replyConfirms(intent,text){
  if(typeof text!=='string'||text.length>8192)return false;
  const match=text.trim().match(/^(.{1,200}?)[。！!？?]/u);
  if(!match||/[？?]$/.test(match[0])||uncertain(match[0])||/也许|可能|未必|不一定|但是|不过|然而/.test(match[0]))return false;
  const sentence=match[1].trim();
  if(intent==='agree')return /^(是的|对的|没错|确实如此|我同意|我赞同|可以的)(?:[，,\s]|$)/.test(sentence)
    &&!/(不是|不同意|不赞同|不对|不可以|不能|错误)/.test(sentence);
  if(intent==='disagree')return /^(不是的|不对|并不是|我不同意|我不赞同|我不建议|不建议|不能这样|不可以)(?:[，,\s]|$)/.test(sentence)
    &&!/不是不|不能不|不无|并非不/.test(sentence);
  if(intent==='comfort')return /我理解你|我能理解|我会陪着你|辛苦了|抱抱你|我在这里陪你/.test(sentence)
    &&!/不理解|别安慰|不要安慰|不用安慰/.test(sentence);
  return false;
}

/** Read-only display mapping from a trusted mathematical snapshot. These are
 * deliberately mild existing recipes; no model-provided emotion is consumed. */
export function mathematicalFace(context){
  const e=context?.emotion;
  if(context?.authority!=='mathematical'||context?.source!=='wai.state_bus/runtime_soul'
    ||!e||!finite(e.V)||e.V< -1||e.V>1||!finite(e.A)||e.A<0||e.A>1||!finite(e.S)||e.S<0||e.S>1)
    return {preset:'neutral',strength:.8,source:'missing_mathematical_snapshot',valid:false};
  const energy=context.effectiveEnergy;
  if(energy!==null&&energy!==undefined&&(!finite(energy)||energy<0||energy>1))
    return {preset:'neutral',strength:.8,source:'invalid_energy_snapshot',valid:false};
  const preset=e.V<-.25?'disappointed':e.S>.65?'concerned':energy!==null&&energy!==undefined&&energy<.25?'weary':e.V>.25?'smile':'neutral';
  return {preset,strength:preset==='neutral'?.8:Math.min(.7,.4+Math.abs(e.V)*.2+e.A*.08),
    source:context.source,authority:context.authority,revision:context.contextGeneration,valid:true,
    values:{V:e.V,A:e.A,S:e.S,effectiveEnergy:energy??null}};
}

/** Reply-scope admission and execution centre, not the still-unimplemented
 * autonomous life/activity director. Existing media scheduling, authored poses,
 * IK, near-body elbow constraints and retraction remain in their original owners.
 * Early preparation has one explicit reservation here; late cues enter the
 * existing LiveAvatarSession/RealtimeScheduler queue. No network or audio waits. */
export class ParallelActionDirector{
  constructor({session,clock=()=>performance.now()/1000,onDecision=()=>{}}={}){
    if(!session?.motion||!session?.face||typeof session.enqueue!=='function'||typeof clock!=='function')throw TypeError('invalid_director_dependencies');
    Object.assign(this,{session,clock,onDecision});this.connectionId=null;this.turn=null;this.owner=null;
    this.pending=null;this.selected=null;this.execution=null;this.mode='listening';this.decisions=[];
    this.seen=new Set();this.turnsSeen=new Set();this.connectionsSeen=new Set();this.cooldowns=new Map();this.lastWall=-Infinity;this.serial=0;this.context=null;
    this.faceState=mathematicalFace(null);this.bodySpent=false;this.cancelled=false;this.planConsumed=false;this.lastAdvance=null;
  }
  now(){const time=this.clock();if(!finite(time)||time<0||time<this.lastWall)throw Error('invalid_director_clock');this.lastWall=time;return time;}
  record(type,fields={}){
    const event={type,atMs:this.lastWall*1000,turnId:this.turn?.turnId??null,...fields};this.decisions.push(event);
    if(this.decisions.length>120)this.decisions.shift();try{this.onDecision(clone(event));}catch{/* telemetry never owns speech */}return event;
  }
  reject(reason,fields={}){this.record('rejected',{reason,...fields});return {accepted:false,reason};}
  setConnection(connectionId){
    this.now();if(!validId(connectionId))return false;
    if(this.connectionId===connectionId)return true;
    if(this.connectionsSeen.has(connectionId)||this.connectionsSeen.size>=64)return false;
    if(this.turn)this.cancel({turnId:this.turn.turnId,reason:'connection_replaced'});
    this.connectionsSeen.add(connectionId);this.connectionId=connectionId;this.turn=null;this.context=null;this.owner=null;this.seen.clear();this.turnsSeen.clear();this.mode='listening';return true;
  }
  beginTurn(context){
    this.now();if(!context||context.connectionId!==this.connectionId||!validId(context.turnId))return false;
    if(this.turn?.turnId===context.turnId)return !this.cancelled;
    if(this.turnsSeen.has(context.turnId)||this.turnsSeen.size>=1024)return false;
    if(this.turn)this.cancel({turnId:this.turn.turnId,reason:'new_turn'});
    this.turnsSeen.add(context.turnId);
    this.turn={turnId:context.turnId,text:typeof(context.text??context.userText)==='string'?(context.text??context.userText).slice(0,8192):'',
      started:this.lastWall,actorState:clone(context.actorState),transcript:'',sourceSegments:[]};
    this.owner=null;this.pending=null;this.selected=null;this.execution=null;this.context=null;this.bodySpent=false;this.cancelled=false;this.planConsumed=false;this.lastAdvance=this.lastWall;
    this.mode='waiting';this.faceState=mathematicalFace(null);this.session.face.setPreset(this.faceState.preset,this.faceState.strength);
    this.record('turn_started',{reason:'trusted_dialogue_turn'});return true;
  }
  updateContext(event){
    this.now();if(!event||this.cancelled||event.connectionId!==this.connectionId||event.turnId!==this.turn?.turnId)return this.reject('stale_context');
    if(!Number.isSafeInteger(event.contextGeneration)||event.contextGeneration<0)return this.reject('invalid_context_generation');
    if(this.context&&event.contextGeneration<this.context.contextGeneration)return this.reject('older_context');
    if(event.authority!=='mathematical'||event.source!=='wai.state_bus/runtime_soul')return this.reject('untrusted_context_authority');
    if(this.context&&event.contextGeneration===this.context.contextGeneration){
      if(JSON.stringify(event)!==JSON.stringify(this.context))return this.reject('conflicting_same_generation_context');
      return {accepted:true,reason:'same_context'};
    }
    // A changed turn context invalidates an unvoiced reservation before its next
    // clock advance. The original controller performs the close-body retraction.
    if(this.execution?.prepared&&this.owner){
      this.session.motion.abortPreparations?.(this.owner,this.lastWall);
      this.execution.phase='retract';this.execution.contextRevoked=true;
      this.record('retracted',{reason:'admitted_context_replaced',owner:clone(this.owner)});
    }
    this.context=clone(event);if(typeof event.userText==='string')this.turn.text=event.userText.slice(0,8192);
    if(event.actorState)this.turn.actorState=clone(event.actorState);
    this.faceState=mathematicalFace(event);this.session.face.setPreset(this.faceState.preset,this.faceState.strength);
    if(this.pending&&this.pending.contextGeneration!==event.contextGeneration){this.record('rejected',{reason:'candidate_context_replaced',planId:this.pending.planId});this.pending=null;}
    this.record('emotion_context',{displayMapping:clone(this.faceState),reason:'read_only_mathematical_state'});return {accepted:true};
  }
  bindOwner(owner,{turnId}={}){
    this.now();if(this.cancelled||turnId!==this.turn?.turnId||owner?.connectionId!==this.connectionId||!validId(owner?.responseId)
      ||!Number.isSafeInteger(owner?.epoch)||owner.epoch<1||!same(owner,this.session.owner))return false;
    if(this.owner&&same(this.owner,owner))return true;
    if(this.owner){this.session.motion.abortPreparations?.(this.owner,this.lastWall);this.session.face.abortPreparation?.(this.owner);}
    this.owner=owner;this.record('owner_bound',{owner:clone(owner)});return true;
  }
  offerPlan(event){
    this.now();
    if(!event||this.cancelled||!this.turn||event.connectionId!==this.connectionId||event.turnId!==this.turn.turnId)return this.reject('stale_plan');
    if(event.sourceRole!=='planner'||event.outputFinal!==true||!validId(event.plannerConnectionId)||!validId(event.plannerResponseId)||!validId(event.planId))return this.reject('invalid_planner_identity');
    let parsed;try{parsed=JSON.parse(event.arguments);}catch{return this.reject('incomplete_arguments');}
    if(typeof event.arguments!=='string'||event.arguments.length>128||!/^\s*\{\s*"intent"\s*:\s*"[a-z]+"\s*\}\s*$/.test(event.arguments)
      ||!parsed||Object.keys(parsed).join(',')!=='intent'||parsed.intent!==event.intent||!ACTION_INTENTS.includes(event.intent))return this.reject('invalid_plan');
    if(!this.context||event.contextGeneration!==this.context.contextGeneration)return this.reject('context_not_current');
    const key=`${event.plannerConnectionId}:${event.plannerResponseId}:${event.planId}`;
    if(this.seen.has(key)||this.seen.size>=1024||this.planConsumed)return this.reject('duplicate_or_excess_plan');
    if(!finite(event.expiresInMs)||event.expiresInMs<=0||event.expiresInMs>3500)return this.reject('invalid_expiry');
    this.seen.add(key);this.planConsumed=true;
    const candidate={intent:event.intent,planId:event.planId,plannerConnectionId:event.plannerConnectionId,plannerResponseId:event.plannerResponseId,
      sourceRole:'planner',contextGeneration:event.contextGeneration,receivedAt:this.lastWall,expiresAt:this.lastWall+event.expiresInMs/1000};
    this.record('candidate',{...candidate,reason:'complete_planner_proposal'});
    if(['none','listen'].includes(candidate.intent)){
      this.selected={...candidate,gesture:'none',id:null};this.execution={accepted:true,prepared:false,bodyPrepared:false,phase:'keeping'};
      this.record('kept',{intent:candidate.intent,reason:'no_extra_body_motion'});return {accepted:true,reason:'keep'};
    }
    if(forbid(this.turn.text))return this.reject('explicit_motion_prohibition',{intent:candidate.intent});
    const def=CANDIDATES[candidate.intent];assertMotionAllowed({id:def.gesture});
    if(!AVATAR_CATALOG[`${def.kind}:${def.gesture}`])return this.reject('candidate_not_in_validated_catalog');
    this.pending={...candidate,def,holdReason:null};
    return {accepted:true,reason:'candidate_awaiting_admission'};
  }
  subtitle({turnId,responseId,delta,providerResponseId,providerConnectionId,segmentIndex}={}){
    this.now();if(this.cancelled||turnId!==this.turn?.turnId||responseId!==this.owner?.responseId||typeof delta!=='string'||delta.length>8192)return false;
    if(this.turn.transcript.length+delta.length>8192)return false;
    this.turn.transcript+=delta;
    if(providerResponseId&&!this.turn.sourceSegments.some(s=>s.responseId===providerResponseId)&&this.turn.sourceSegments.length<8)this.turn.sourceSegments.push({responseId:providerResponseId,connectionId:providerConnectionId,index:segmentIndex});
    return true;
  }
  actorReason(def,state){
    const actor=this.turn.actorState;
    if(actor?.posture!=='standing'||actor?.hands!=='free'||actor?.activity!=='none')return 'unsupported_actor_state';
    if(!state?.support?.planted||!finite(state.support.error)||state.support.error>.03)return 'support_not_confirmed';
    if(!state.parts)return 'missing_actual_parts';
    const free=part=>part==='arms'?state.parts.arms?.L==='available'&&state.parts.arms?.R==='available':state.parts[part]==='available';
    if(def.parts.some(part=>!free(part))||state.recovering||state.queued>0||state.execution?.handoff)return 'waiting_for_body_release';
    if(def.parts.includes('arms')&&state.interactionPose?.handsSettled!==true)return 'waiting_for_hands_settle';
    return null;
  }
  hold(candidate,reason){if(candidate.holdReason!==reason){candidate.holdReason=reason;this.record('held',{planId:candidate.planId,intent:candidate.intent,reason});}return false;}
  admit(audio,marker){
    const p=this.pending;if(!p)return;
    if(this.lastWall>p.expiresAt){this.pending=null;return this.reject('candidate_expired',{intent:p.intent});}
    if(!this.owner||!same(this.owner,this.session.owner))return this.hold(p,'waiting_for_voice_owner');
    if(!active.has(audio.status)||this.session.snapshot?.().revoked){this.pending=null;return this.reject('audio_turn_closed');}
    if(audio.status==='paused')return this.hold(p,'explicit_pause');
    if(this.bodySpent){this.pending=null;return this.reject('one_body_action_per_turn');}
    if(!this.context||p.contextGeneration!==this.context.contextGeneration){this.pending=null;return this.reject('context_replaced');}
    const confirmation=p.def.early?immediateIntentEvidence(p.intent,this.turn.text):replyConfirms(p.intent,this.turn.transcript);
    if(!confirmation)return this.hold(p,p.def.early?'user_intent_not_clear':'waiting_for_reply_confirmation');
    if(!p.def.early&&!marker?.reached)return this.hold(p,'waiting_for_actual_voice');
    const energy=this.context.effectiveEnergy;
    if(finite(energy)&&energy<.2&&p.def.kind==='gesture'){this.pending=null;return this.reject('energy_incompatible_keep_still');}
    if((this.cooldowns.get(p.def.gesture)??-Infinity)>this.lastWall){this.pending=null;return this.reject('cross_turn_cooldown');}
    const state=this.session.motion.snapshot(),reason=this.actorReason(p.def,state);
    if(reason){
      if(reason==='unsupported_actor_state'||reason==='support_not_confirmed'||reason==='missing_actual_parts'){this.pending=null;return this.reject(reason);}
      if(this.lastWall-p.receivedAt>1.2){this.pending=null;return this.reject('body_release_deadline');}
      return this.hold(p,reason);
    }
    const cueId=`parallel:e${this.owner.epoch}:p${++this.serial}`,early=p.def.early&&!marker?.reached;
    const cue={id:cueId,kind:p.def.kind,[p.def.kind==='action'?'action':'gesture']:p.def.gesture,strength:.65};
    let accepted=false;
    if(early)accepted=this.session.motion.prepare(cue,this.owner,this.lastWall)===true;
    else accepted=this.session.enqueue({...cue,at:audio.time},this.owner)?.accepted===true;
    this.pending=null;
    if(!accepted)return this.reject('execution_admission_rejected',{intent:p.intent});
    this.bodySpent=true;this.selected={...p,def:undefined,id:cueId,gesture:p.def.gesture};
    this.execution={accepted:true,prepared:early,bodyPrepared:early,admittedAt:this.lastWall,startedAt:null,phase:early?'prepared':'queued',cooldown:p.def.cooldown};
    this.mode=early?'preparing':'speaking';
    this.record('admitted',{accepted:true,planId:p.planId,owner:clone(this.owner),intent:p.intent,gesture:p.def.gesture,cueId,prepared:early,sourceRole:p.sourceRole,plannerResponseId:p.plannerResponseId});
    return true;
  }
  advance(audio=this.session.audio.snapshot(),marker=this.session.audio.playbackMarker?.()){
    this.now();
    if(this.pending&&audio.status==='paused'&&this.lastAdvance!==null){const pause=this.lastWall-this.lastAdvance;this.pending.expiresAt+=pause;this.pending.receivedAt+=pause;}
    this.lastAdvance=this.lastWall;
    if(this.owner&&!same(this.owner,this.session.owner)&&!this.cancelled){this.cancel({turnId:this.turn?.turnId,reason:'playback_owner_replaced'});}
    this.session.motion.advancePreparation?.(this.lastWall,audio,marker);this.session.face.advancePreparation?.(this.lastWall,audio,marker);
    if(this.cancelled){
      const s=this.session.motion.snapshot();
      if(this.mode==='retracting'&&!s.gestures.length&&!s.reactions.length&&!s.execution?.handoff&&s.interactionPose?.handsSettled){this.mode='listening';this.record('settled',{reason:'actual_body_settled'});}
      return this.snapshot();
    }
    if(!this.turn)return this.snapshot();
    if(this.owner&&same(this.owner,this.session.owner)&&['cancelled','fault'].includes(audio.status)){this.cancel({turnId:this.turn.turnId,reason:'playback_revoked'});return this.snapshot();}
    this.admit(audio,marker);
    if(this.selected?.id&&this.execution){
      const state=this.session.motion.snapshot();
      const cue=[...state.gestures,...state.reactions,...this.session.face.snapshot().executedCues].find(c=>c.id===this.selected.id);
      if(cue?.age>0&&!cue.recovering&&this.execution.startedAt===null){
        this.execution.startedAt=this.lastWall;this.cooldowns.set(this.selected.gesture,this.lastWall+this.execution.cooldown);
        this.record('displayed',{cueId:this.selected.id,gesture:this.selected.gesture,reason:'controller_instance_has_progress'});
      }
      if(cue)this.execution.phase=cue.recovering?'retract':cue.phase??'executing';
      else if(this.execution.startedAt!==null)this.execution.phase='settled';
      else if(this.execution.prepared&&!this.session.motion.preparationSnapshot?.().some(p=>p.id===this.selected.id))this.execution.phase='settled_without_display';
      else if(!this.execution.prepared&&this.lastWall-this.execution.admittedAt>.3)this.execution.phase='settled_without_display';
    }
    if(marker?.reached&&audio.status==='playing')this.mode='speaking';
    if(audio.status==='ended'){this.pending=null;this.mode=['settled','settled_without_display'].includes(this.execution?.phase)||!this.selected?.id?'listening':'settling';}
    return this.snapshot();
  }
  cancel({turnId,reason='barge_in'}={}){
    this.now();if(turnId!==this.turn?.turnId||this.cancelled)return false;
    this.cancelled=true;this.pending=null;this.mode='retracting';
    if(this.owner){
      this.session.motion.abortPreparations?.(this.owner,this.lastWall);this.session.face.abortPreparation?.(this.owner);
    }
    this.record('retracted',{reason,owner:clone(this.owner)});return true;
  }
  snapshot(){return {turnId:this.turn?.turnId??null,connectionId:this.connectionId,owner:clone(this.owner),mode:this.mode,cancelled:this.cancelled,
    selected:clone(this.selected),execution:clone(this.execution),pending:this.pending?{intent:this.pending.intent,planId:this.pending.planId,reason:this.pending.holdReason,expiresAt:this.pending.expiresAt}:null,
    face:clone(this.faceState),bodySpent:this.bodySpent,cooldowns:Object.fromEntries(this.cooldowns),decisions:clone(this.decisions),
    scope:'reply-admission-centre; existing media scheduler retained; autonomous life/activity director not implemented',
    candidatePolicy:'verified authored upright-empty-hand subset; no automatic native-review assets or Stand2'};}
}
