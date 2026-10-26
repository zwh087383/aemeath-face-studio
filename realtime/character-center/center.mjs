/** Long-lived display authority. Voice/history remain owned by DuplexClient. */
export class CharacterCenter {
  constructor({face,body,onEvent=()=>{},clock=()=>performance.now()/1000}){
    Object.assign(this,{face,body,onEvent,clock});this.events=[];this.pending=[];this.revoked=new Map();this.latestRevision=0;this.faceRevision=0;this.seenCommands=new Set();
    this.versions=new Map();this.sequence=0;this.connectionId=null;this.turnId=null;this.voiceOwner=null;
    this.activity=null;this.paused=false;this.played=new Set();this.lastMath=null;
  }
  record(type,fields={}){const event={type,at:this.clock(),...fields};this.events.push(event);if(this.events.length>3000)this.events.shift();this.onEvent(event);return event;}
  setConnection(id){this.connectionId=id;}
  beginTurn({turnId}){this.turnId=turnId;this.voiceOwner=null;this.paused=false;}
  bindOwner(owner){this.voiceOwner=owner;}
  updateContext(){} offerPlan(){return {accepted:false,reason:'legacy_plan_disabled'};} subtitle(){}
  owner(e){
    const key=e.sourceKey,version=String(e.sourceVersion);
    let state=this.versions.get(key);
    if(!state||state.version!==version){state={version,index:++this.sequence};this.versions.set(key,state);}
    state.semanticRevision=e.semanticRevision;state.turnId=e.turnId;state.activityId=e.activityId;
    return {sourceKey:key,sourceScope:e.sourceScope,sourceVersion:state.index,sourceRevision:version,
      semanticRevision:e.semanticRevision,turnId:e.turnId,activityId:e.activityId,requestId:e.commandId??e.requestId};
  }
  current(owner){return owner.semanticRevision>(this.revoked.get(owner.sourceKey)??-1)&&this.versions.get(owner.sourceKey)?.index===owner.sourceVersion
    &&(!owner.turnId||owner.turnId===this.turnId);}
  message(e){
    if(e.connectionId&&this.connectionId&&e.connectionId!==this.connectionId)return false;
    if(e.type==='character_math'){
      this.lastMath=e;const accepted=this.face.setMathematical(e.state,e.mathRevision);
      this.record('math_target',{revision:e.mathRevision,accepted});return accepted;
    }
    if(e.type==='activity_state'){this.activity=e;this.record('activity_state',{activity:e});return true;}
    if(e.type==='character_revoke'){
      if(e.sourceKey){this.revoked.set(e.sourceKey,this.latestRevision);this.pending=this.pending.filter(x=>x.event.sourceKey!==e.sourceKey);}
      this.cancel({turnId:e.turnId,sourceKey:e.sourceKey,reason:e.reason});return true;
    }
    if(!['character_expression','character_actions'].includes(e.type))return false;
    if(!Number.isSafeInteger(e.semanticRevision)||!e.sourceKey||!e.requestId||!e.command)return false;
    if(e.semanticRevision<(this.versions.get(e.sourceKey)?.semanticRevision??-1))return false;
    const commandKey=e.commandId??`${e.requestId}:${e.type}:${e.callId??'one'}`;
    if(this.seenCommands.has(commandKey))return false;this.seenCommands.add(commandKey);
    if(e.semanticRevision<=(this.revoked.get(e.sourceKey)??-1)||e.turnId&&e.turnId!==this.turnId){this.record('stale_drop',{requestId:e.requestId});return false;}
    this.latestRevision=Math.max(this.latestRevision,e.semanticRevision);
    const owner=this.owner(e),entry={event:structuredClone(e),owner,received:this.clock()};
    if(e.mediaAnchor?.kind==='segment_end'){
      if(!e.turnId||!Number.isInteger(e.mediaAnchor.segmentIndex))return false;
      if(e.type==='character_expression')this.pending=this.pending.filter(x=>!(x.event.type===e.type
        &&x.event.turnId===e.turnId&&x.event.mediaAnchor.segmentIndex===e.mediaAnchor.segmentIndex
        &&x.event.command.mode===e.command.mode));
      this.pending.push(entry);this.record('waiting_playback',{requestId:e.requestId,anchor:e.mediaAnchor});
    }else this.apply(entry);
    return true;
  }
  apply({event:e,owner,received}){
    if(!this.current(owner))return false;
    let accepted;
    if(e.type==='character_actions')accepted=this.body.submit(e.command,owner);
    else{
      const cmd=e.command,source=e.sourceKey;
      const command={id:`${source}:${cmd.kind}`,kind:cmd.kind,strength:cmd.strength,source,
        revision:++this.faceRevision,evidenceId:cmd.evidenceRef,renew:true};
      if(cmd.mode==='attitude')accepted=this.face.setAttitude(command);
      else if(cmd.mode==='reaction')accepted=this.face.react({...command,id:e.requestId+':'+e.semanticRevision});
      else{const current=this.face.attitude;accepted=current?this.face.clearAttitude({id:current.id,source:current.source,revision:command.revision}):true;}
    }
    this.record(e.type==='character_actions'?'body_target':'face_target',{
      requestId:e.requestId,turnId:e.turnId,sourceKey:e.sourceKey,semanticRevision:e.semanticRevision,
      command:e.command,received,accepted,owner});return accepted;
  }
  advance(audio,trial){
    if(!trial||trial.revoked)return;
    for(const segment of trial.segments??[]){
      if(!segment.result||segment.result.status!=='completed'||!segment.result.audioDone)continue;
      const end=(segment.startFrame+segment.frames)/24000;
      if(audio.epoch!==trial.owner?.epoch||audio.time+1e-4<end||!['playing','ended'].includes(audio.status))continue;
      const key=`${trial.id}:${segment.index}`;
      if(!this.played.has(key)){this.played.add(key);this.record('segment_played',{turnId:trial.id,index:segment.index,frames:segment.frames,playedFrame:segment.startFrame+segment.frames,providerConnectionId:segment.connectionId,responseId:segment.responseId});}
      const due=this.pending.filter(x=>x.event.mediaAnchor.turnId===trial.id&&x.event.mediaAnchor.segmentIndex===segment.index
        &&x.event.mediaAnchor.providerConnectionId===segment.connectionId&&x.event.mediaAnchor.responseId===segment.responseId);
      this.pending=this.pending.filter(x=>!due.includes(x));for(const entry of due)this.apply(entry);
    }
  }
  cancel({turnId=null,sourceKey=null,reason='user_interrupt'}={}){
    this.pending=this.pending.filter(x=>!(sourceKey?x.owner.sourceKey===sourceKey:turnId?x.owner.turnId===turnId:true));
    const matches=[...this.versions].filter(([key,state])=>sourceKey?key===sourceKey:turnId?state.turnId===turnId:true);
    for(const [key,state] of matches){
      // Semantic attitude intentionally survives voice cancellation. Its source
      // remains visible until a new decision or its documented fade policy.
      this.face.cancel({source:key,revision:this.faceRevision});
    }
    // Body cancellation never snaps posture, support or held props to neutral.
    if(sourceKey){const version=this.versions.get(sourceKey);if(version)this.body.cancel({sourceKey,sourceVersion:version.index},reason);}
    else this.body.cancel(null,reason);
    this.record('cancel',{turnId,sourceKey,reason});
  }
  hasWork(){return !!this.body.snapshot().active||!!this.body.snapshot().pending?.length;}
  pause(value){this.paused=value;this.body.pause(value);}
  snapshot(){return {math:this.lastMath,face:this.face.snapshot(),body:this.body.snapshot(),pending:this.pending,activity:this.activity,events:this.events.slice(-100)};}
}
