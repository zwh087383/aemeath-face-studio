import {MODEL_ACTIONS,validateCommands} from './catalog.mjs';
import {mathematicalFace} from '../parallel-duplex/director.mjs';

const same=(a,b)=>!!a&&!!b&&a.connectionId===b.connectionId&&a.responseId===b.responseId&&a.epoch===b.epoch;
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const copy=x=>x==null?x:structuredClone(x);

/** The model owns selection, sequence, repetition and command replacement.
 * This centre owns execution only. There is deliberately no text classifier,
 * per-turn action counter, emotion threshold, cooldown, or semantic expiry.
 * The single musculoskeletal lane avoids two clips writing the same bones.
 * Queue duration never holds up speech completion/history ACK.
 */
export class ModelActionDirector {
  constructor({session,clock=()=>performance.now()/1000,onDecision=()=>{}}={}) {
    if(!session?.motion||!session?.face)throw Error('missing_controllers');
    Object.assign(this,{session,clock,onDecision});
    this.connectionId=null;this.turn=null;this.owner=null;this.context=null;
    this.pending=[];this.running=null;this.seen=new Set();this.serial=0;
    this.decisions=[];this.rows=[];this.counts={received:0,started:0,completed:0,cancelled:0,rejected:0};
    this.cancelled=false;this.paused=false;this.elapsed=0;this.lastWall=null;this.mode='listening';
    this.faceState=mathematicalFace(null);
  }
  record(type,fields={}) {
    const event={type,atMs:this.clock()*1000,turnId:this.turn?.turnId??null,...fields};
    this.decisions.push(event);if(this.decisions.length>160)this.decisions.shift();
    try{this.onDecision(copy(event));}catch{/* diagnostics do not control audio */}
    return event;
  }
  reject(reason,fields={}) {this.counts.rejected++;this.record('rejected',{reason,...fields});return {accepted:false,reason};}
  setConnection(connectionId) {
    if(!id(connectionId))return false;
    if(this.connectionId===connectionId)return true;
    if(this.turn)this.cancel({turnId:this.turn.turnId,reason:'connection_replaced'});
    this.connectionId=connectionId;this.turn=null;this.owner=null;return true;
  }
  beginTurn(context) {
    if(context?.connectionId!==this.connectionId||!id(context.turnId))return false;
    if(this.turn?.turnId===context.turnId)return !this.cancelled;
    if(this.turn)this.cancel({turnId:this.turn.turnId,reason:'new_turn'});
    this.turn=copy(context);this.owner=null;this.context=null;this.pending=[];this.running=null;
    this.seen.clear();this.rows=[];this.counts={received:0,started:0,completed:0,cancelled:0,rejected:0};
    this.cancelled=false;this.paused=false;this.userPaused=false;this.elapsed=0;this.lastWall=this.clock();this.mode='waiting';
    this.record('turn_started');return true;
  }
  updateContext(event) {
    if(this.cancelled||event?.connectionId!==this.connectionId||event.turnId!==this.turn?.turnId)
      return this.reject('stale_context');
    if(!Number.isSafeInteger(event.contextGeneration)||event.authority!=='mathematical'
        ||event.source!=='wai.state_bus/runtime_soul')return this.reject('invalid_context');
    if(this.context&&event.contextGeneration<this.context.contextGeneration)return this.reject('older_context');
    if(this.context&&event.contextGeneration>this.context.contextGeneration)this.clear('context_replaced');
    this.context=copy(event);this.faceState=mathematicalFace(event);
    this.session.face.setPreset(this.faceState.preset,this.faceState.strength);
    return {accepted:true,reason:'mathematical_state_updated'};
  }
  bindOwner(owner,{turnId}={}) {
    if(this.cancelled||turnId!==this.turn?.turnId||!same(owner,this.session.owner))return false;
    if(this.owner&&!same(this.owner,owner))this.clear('playback_owner_replaced');
    this.owner=copy(owner);return true;
  }
  subtitle(){return true;} // No keyword/stance gate. The model owns meaning.
  offerPlan(event) {
    if(this.cancelled||event?.connectionId!==this.connectionId||event.turnId!==this.turn?.turnId)
      return this.reject('stale_turn');
    if(event.sourceRole!=='planner'||event.outputFinal!==true||!id(event.planId)
        ||!id(event.plannerConnectionId)||!id(event.plannerResponseId))return this.reject('invalid_planner_identity');
    if(!this.context||event.contextGeneration!==this.context.contextGeneration)return this.reject('stale_context_generation');
    if(this.seen.has(event.planId))return this.reject('duplicate_packet');
    let command;try{command=validateCommands(event.command);}catch(e){return this.reject(e.message);}
    this.seen.add(event.planId);
    if(command.operation!=='append')this.clear('model_'+command.operation);
    for(const item of command.actions) {
      const row={...item,id:`model-cue-${++this.serial}`,planId:event.planId,status:'queued',
        receivedAt:this.clock()*1000,notBefore:this.elapsed+item.delay_ms/1000};
      this.pending.push(row);this.rows.push(row);this.counts.received++;
      this.record('queued',{cueId:row.id,action:row.action,planId:row.planId});
    }
    // UI history is bounded; the execution queue and per-turn count are not.
    if(this.rows.length>300)this.rows=this.rows.slice(-300);
    return {accepted:true,reason:'model_command_accepted',actions:command.actions.length};
  }
  retract() {
    if(!same(this.owner,this.session.owner))return;
    this.session.motion.abortPreparations?.(this.owner,this.clock());
    this.session.face.abortPreparation?.(this.owner);
    this.session.motion.retract(this.clock());this.session.face.clearCues();
  }
  clear(reason) {
    for(const row of [...this.pending,...(this.running?[this.running]:[])]) {
      row.status='cancelled';row.reason=reason;this.counts.cancelled++;
      this.record('action_cancelled',{cueId:row.id,action:row.action,reason});
    }
    this.pending=[];this.running=null;this.retract();
  }
  cancel({turnId,reason='barge_in'}={}) {
    if(turnId!==this.turn?.turnId||this.cancelled)return false;
    this.clear(reason);this.cancelled=true;this.mode='retracting';this.record('retracted',{reason});return true;
  }
  hasWork(){return !!this.running||this.pending.length>0;}
  advance(audio=this.session.audio.snapshot(),marker=this.session.audio.playbackMarker?.()) {
    const now=this.clock(),delta=this.lastWall===null?0:Math.max(0,now-this.lastWall);this.lastWall=now;
    const visualClock=this.paused?{...audio,status:'paused'}:audio;
    this.session.motion.advancePreparation?.(now,visualClock,marker);
    this.session.face.advancePreparation?.(now,visualClock,marker);
    if(!this.turn||this.cancelled)return;
    if(this.owner&&(!same(this.owner,this.session.owner)||['cancelled','fault'].includes(audio.status))) {
      this.cancel({turnId:this.turn.turnId,reason:'voice_owner_revoked'});return;
    }
    const paused=this.paused||audio.status==='paused';if(!paused)this.elapsed+=delta;
    const motion=this.session.motion.snapshot(),face=this.session.face.snapshot();
    const entries=[...(motion.gestures??[]),...(motion.reactions??[]),...(face.executedCues??[])];
    if(this.running) {
      const row=this.running,instance=entries.find(x=>x.id===row.id&&!x.recovering);
      const waiting=(this.session.motion.pending??[]).some(x=>x.id===row.id)
        ||(this.session.face.cues??[]).some(x=>x.id===row.id);
      if(instance?.age>0&&!row.displayedAt) {
        row.displayedAt=now*1000;row.status='playing';this.counts.started++;
        this.record('displayed',{cueId:row.id,action:row.action,reason:'actual_controller_instance'});
      }
      if(!instance&&!waiting&&!paused&&now*1000-row.admittedAt>50) {
        row.status=row.displayedAt?'completed':'execution_failed';row.completedAt=now*1000;
        if(row.displayedAt)this.counts.completed++;else this.counts.rejected++;
        this.record(row.status,{cueId:row.id,action:row.action});this.running=null;
      }
    }
    if(paused){this.mode='paused';return;}
    if(!this.owner){this.mode='waiting_owner';return;}
    const row=this.pending[0];
    if(!row){this.mode=this.running?'executing':audio.status==='playing'?'speaking':'listening';return;}
    let reason=this.running?'previous_action_running':this.elapsed<row.notBefore?'model_delay':null;
    const actor=this.context?.actorState;
    if(!reason&&(actor?.posture!=='standing'||actor?.hands!=='free'||actor?.activity!=='none'
        ||motion.support?.planted!==true))reason='execution_scene_unavailable';
    if(!reason&&(motion.gestures?.length||motion.reactions?.length||motion.queued
        ||motion.execution?.handoff||motion.interactionPose?.headBusy||motion.interactionPose?.armsBusy
        ||motion.interactionPose?.torsoBusy||(face.executedCues??[]).length))reason='body_recovery';
    const beforeVoice=!marker?.reached&&['buffering','playing'].includes(audio.status);
    const def=MODEL_ACTIONS[row.action];
    if(!reason&&beforeVoice&&(row.anchor==='voice'||def.kind!=='gesture'))reason='waiting_voice';
    if(reason){row.reason=reason;this.mode='queued';return;}
    if(!['buffering','playing','ended'].includes(audio.status))return;
    const prepared=beforeVoice&&row.anchor==='prepare'&&def.kind==='gesture';
    const clock=audio.status==='ended'?'wall':'audio';
    const cue={id:row.id,epoch:this.owner.epoch,kind:def.kind,[def.kind]:def.name,
      clock,at:clock==='wall'?now:audio.time,duration:def.duration,strength:.65};
    // One writer per controller. Do not use RealtimeScheduler's old semantic
    // cooldown/drop queue; it continues to own voice/epoch lifecycle unchanged.
    let accepted=false;
    try {
      if(prepared)accepted=this.session.motion.prepare(cue,this.owner,now)===true;
      else if(def.kind==='gesture')accepted=this.session.motion.enqueue(cue)===true;
      else if(def.name==='nod'&&this.session.motion.options?.continuity)
        accepted=this.session.motion.requestReaction({id:row.id,kind:'nod',strength:cue.strength,
          now,owner:this.owner,clock,audioAt:cue.at,reason:'model_command'})===true;
      else accepted=this.session.face.enqueue(cue)===true;
    }catch{/* Optional visual failure cannot cancel voice. */}
    this.pending.shift();row.admittedAt=now*1000;row.prepared=prepared;
    if(!accepted){row.status='execution_failed';this.counts.rejected++;this.record('execution_failed',{cueId:row.id,action:row.action});}
    else {row.status='admitted';row.reason=null;this.running=row;
      this.record('admitted',{accepted:true,cueId:row.id,gesture:def.name,action:row.action,prepared,owner:copy(this.owner)});}
  }
  executionSnapshot(){return this.running?{accepted:true,prepared:this.running.prepared,phase:this.running.status}:null;}
  snapshot() {
    const r=this.running;
    return {turnId:this.turn?.turnId??null,connectionId:this.connectionId,owner:copy(this.owner),mode:this.mode,
      cancelled:this.cancelled,selected:r?{id:r.id,gesture:MODEL_ACTIONS[r.action].name}:null,
      execution:this.executionSnapshot(),
      pending:this.pending.length?{count:this.pending.length,next:this.pending[0].action,reason:this.pending[0].reason}:null,
      counts:{...this.counts},rows:copy(this.rows),face:copy(this.faceState),decisions:copy(this.decisions),
      policy:'model selects all actions; no per-turn count/cooldown/keyword/stance/expiry gate',
      scope:'conversation command queue; existing executable catalogue, not autonomous life planning'};
  }
}
