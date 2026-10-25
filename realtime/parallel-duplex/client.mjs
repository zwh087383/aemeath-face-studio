import {DuplexClient} from '../duplex/client.mjs';
import {decodePcm24k} from '../qwen/input-audio.mjs';

const actionTypes=new Set(['action_context','action_plan','action_status','action_error','action_done']);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);
export const ACTOR_STATE=Object.freeze({posture:'standing',hands:'free',activity:'none'});
export function framePreflightVerdict(intervals,{hidden=false,timedOut=false}={}){
  const sorted=intervals.filter(Number.isFinite).sort((a,b)=>a-b);
  const p95=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]??null,max=sorted.at(-1)??null;
  return {valid:!hidden&&!timedOut&&sorted.length>=5&&p95<=100&&max<=250,p95,max,samples:sorted.length,hidden,timedOut};
}
export const attemptedFixtureIds=records=>new Set(records.filter(x=>x.sentPackets>0).map(x=>x.id));
export function replayTurnEvents(record,turn){
  const own=record.events.filter(e=>e.turnId===turn.id),start=own[0]?.serverMs??Infinity;
  const end=own.find(e=>e.type==='revoked')?.serverMs??own.at(-1)?.serverMs??-Infinity;
  return record.events.filter(e=>(e.turnId===turn.id||(['speech_started','speech_stopped'].includes(e.type)&&e.serverMs>=start&&e.serverMs<=end))
    &&!['delivery','settled','runtime_state','wai_submitted'].includes(e.type));
}

/** Keep the existing direct voice/segment/history protocol intact. The planner
 * has a separate identity and cannot masquerade as a voice segment or ACK.
 */
export class ParallelDuplexClient extends DuplexClient {
  constructor({director,...options}){
    super(options);this.director=director;this.actionMode='parallel';
  }
  message(message,generation=null){
    if(actionTypes.has(message.type)){
      super.message(message,generation);
      if(message.connectionId!==this.connectionId)return;
      const t=this.trials.find(t=>t.id===message.turnId);
      if(!t){this.emit('action_dropped',{reason:'unknown_turn',turnId:message.turnId});return;}
      (t.actionEvents??=[]).push({at:this.now(),...structuredClone(message)});
      if(t.revoked||t!==this.current||this.blocked){this.emit('action_dropped',{reason:'revoked_or_stale_turn',turnId:t.id});return;}
      if(message.type==='action_context'){
        t.actionContext=structuredClone(message);this._visual(()=>this.director.updateContext(message),t);
      }else if(message.type==='action_plan'){
        if(!validId(message.planId)||!validId(message.plannerConnectionId)||!validId(message.plannerResponseId)
            ||message.sourceRole!=='planner'||message.outputFinal!==true){
          this.emit('action_dropped',{reason:'invalid_planner_identity',turnId:t.id});return;
        }
        t.firstActionPlanAt??=this.now();
        const admission=this._visual(()=>this.director.offerPlan(message),t);
        (t.actionPlans??=[]).push({at:this.now(),event:structuredClone(message),admission});
      }
      return;
    }
    super.message(message,generation);
    if(message.type==='ready'&&this.ready&&message.connectionId===this.connectionId){
      this.actionMode=message.actionMode??'parallel';this._visual(()=>this.director.setConnection(this.connectionId));
    }
    if(message.connectionId!==this.connectionId)return;
    const t=this.trials.find(t=>t.id===message.turnId);
    if(message.type==='turn_started'&&t===this.current){
      t.actionEvents=[];t.actionPlans=[];t.renderFrames=[];t.renderTrace=[];t.directorDecisions=[];
      this._visual(()=>this.director.beginTurn({connectionId:this.connectionId,turnId:t.id,text:t.text,
        actorState:{...ACTOR_STATE},emotion:null,effectiveEnergy:null}),t);
    }
    if(message.type==='settled'&&t)t.historySettled=true;
  }
  _visual(callback,t=this.current){
    try{return callback();}catch(error){
      if(t)(t.visualErrors??=[]).push({at:this.now(),code:'director_failure'});
      this.emit('visual_error',{code:'director_failure',turnId:t?.id});return {accepted:false,reason:'director_failure'};
    }
  }
  directMessage(message,t){
    // No legacy cooutput tools belong to P's speech connection. A stray tool
    // must not bypass the director or poison an otherwise valid audio stream.
    if(message.type==='tool'){
      this.directSegment(t,message);
      (t.rejectedVoiceTools??=[]).push({at:this.now(),reason:'voice_tool_disabled_in_parallel'});
      return true;
    }
    const beforeFrames=t.frames,handled=super.directMessage(message,t);
    if(!handled)return false;
    if(message.type==='response_created'&&!t.revoked&&t===this.current&&t.owner&&!t.directorBound){
      this._visual(()=>this.director.bindOwner(t.owner,{turnId:t.id}),t);t.directorBound=true;
      // Super's cancel path remains responsible for session/audio cancellation.
      t.driver={cancel:()=>this._visual(()=>this.director.cancel({turnId:t.id,reason:'voice_owner_revoked'}),t)};
    }
    if(message.type==='audio'&&!message.revoked&&!t.revoked&&t===this.current&&t.owner&&t.firstVoicedFrame===undefined){
      const pcm=decodePcm24k(message.pcm),index=pcm.findIndex(value=>Math.abs(value)>=256/32768);
      if(index>=0){
        t.firstVoicedFrame=beforeFrames+index;t.firstVoicedPcmAt=this.now();
        t.voiceMarkerSet=this.session.audio.setPlaybackMarker(t.firstVoicedFrame/24000);
      }
    }
    if(message.type==='subtitle'&&!message.revoked&&!t.revoked&&t===this.current){
      this._visual(()=>this.director.subtitle({turnId:t.id,responseId:t.owner?.responseId,
        providerResponseId:message.responseId,providerConnectionId:message.providerConnectionId,
        segmentIndex:message.segmentIndex,delta:message.delta}),t);
    }
    return true;
  }
  cancel(reason='explicit_user_interrupt',remote=true){
    const t=this.current;if(t&&!t.revoked&&t.settledAt===undefined)this._visual(()=>this.director.cancel({turnId:t.id,reason}),t);
    return super.cancel(reason,remote);
  }
  snapshot(){
    const base=super.snapshot();return {...base,actionMode:this.actionMode,director:this._visual(()=>this.director.snapshot())};
  }
}
