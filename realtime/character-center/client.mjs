import {ParallelDuplexClient} from '../parallel-duplex/client.mjs';

/** Compatibility with the old audio client is scoped here. The actual ledger
 * remains intact: terminal-but-unreported calls retain their maximum charge. */
export class CharacterClient extends ParallelDuplexClient {
  _hasBodyWork(){const body=this.director.body;return !!(body?.active||body?.pending?.length||body?.faceActive?.length||this.director.pending?.length);}
  _currentBodyHold(hold){return !!hold&&this.bodyHold===hold&&hold.connectionId===this.connectionId&&hold.generation===this.generation
    &&hold.turnId===(this.current?.id??null);}
  async connect(...args){
    if(!this.socket||this.socket.readyState>=2){this.cancel('new_connection',false);this.playbackStateSequence=0;this.lastPlaybackState=null;}
    return super.connect(...args);
  }
  ensureListener(){
    if(!this.ready||this.blocked)return Promise.reject(Error('listener_session_unavailable'));
    if(this.listenerResume)return this.listenerResume.promise;
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const timer=setTimeout(()=>{this.listenerResume=null;reject(Error('listener_resume_timeout'));},15000);
    this.listenerResume={promise,resolve,reject,timer};
    if(!this.send({type:'listener_resume'})){clearTimeout(timer);this.listenerResume=null;reject(Error('listener_resume_send_failed'));}
    return promise;
  }
  message(message,generation=null){
    // Release only this server input's confirmation. A newer local packet may
    // arrive while resume() is awaiting WebAudio; its hold must still be able
    // to expire as noise after this older server input has stopped.
    if(message.connectionId===this.connectionId&&message.type==='speech_stopped'
        &&this.bodyHold?.serverSpeechPending===message.itemId)delete this.bodyHold.serverSpeechPending;
    const budget=message.budget??this.budget;
    const admissible=budget&&!budget.blocked&&!budget.channels?.listener?.frozen&&!budget.channels?.voice?.frozen;
    const audioView=admissible?{...message,budget:{...budget,unknown:0,unknownTerminalReserved:budget.unknown}}:message;
    super.message(audioView,generation);
    if(budget)this.budget=budget;
    if(message.connectionId===this.connectionId&&message.type==='speech_started'&&this.bodyHold)
      this.bodyHold.serverSpeechPending=message.itemId;
    if(message.connectionId===this.connectionId&&message.type==='turn_started')
      this.director.pause(!!this.manualPaused||!!this.bodyHold);
    if(message.connectionId===this.connectionId&&
      (message.type.startsWith('character_')||message.type==='activity_state'))this.director.message(message);
    if(message.connectionId===this.connectionId&&this.listenerResume&&['listener_resumed','listener_resume_failed','blocked','closed'].includes(message.type)){
      const pending=this.listenerResume;this.listenerResume=null;clearTimeout(pending.timer);
      if(message.type==='listener_resumed'&&message.ready!==false)pending.resolve(message);
      else pending.reject(Error(message.reason??message.code??'listener_resume_failed'));
    }
  }
  get canReconnect(){return this.blocked&&!this.hardBlocked&&this.blockReason==='session_input_limit'
    &&!this.budget?.blocked&&!this.budget?.channels?.listener?.frozen&&!this.budget?.channels?.voice?.frozen;}
  provisionalPause(reason){
    const audioAccepted=super.provisionalPause(reason);
    // A delivered voice turn can still own a moving body, queued steps, or a
    // model request whose actions have not arrived. Listen before any of those
    // advances; do not rewrite the already delivered voice/history record.
    if(!this.bodyHold&&(audioAccepted||this.current||this._hasBodyWork())){
      const body=this.director.body;
      this.bodyHold={at:this.now(),turnId:this.current?.id??null,connectionId:this.connectionId,generation:this.generation,
        priorPaused:!!this.director.paused,inputRevision:0};
      this.director.pause(true);
      this.emit('body_provisional_pause',{turnId:this.bodyHold.turnId,reason,accepted:true,audioPauseAccepted:audioAccepted,
        activeAction:body?.active?.action??null,activeActionId:body?.active?.id??null,
        pendingActions:(body?.pending?.length??0)+(this.director.pending?.length??0)});
    }
    if(this.bodyHold)this.bodyHold.inputRevision++;
    return audioAccepted||!!this.bodyHold;
  }
  async resumeInvalid(reason='invalid_turn_resumed'){
    const hold=this.bodyHold;if(hold?.resuming||hold?.serverSpeechPending)return;
    const revision=hold?.inputRevision;
    if(hold)hold.resuming=true;
    try{
      if(!this.manualPaused&&!hold?.priorPaused)await super.resumeInvalid(reason);
      // An asynchronous audio resume must not unpause a newer user's hold.
      if(!this._currentBodyHold(hold))return;
      if(hold.inputRevision!==revision){
        // Super may have resumed audio while another local packet arrived.
        // Reinstate both pauses without waiting for another input packet.
        super.provisionalPause('local_voice_activity');this.director.pause(true);return;
      }
      this.bodyHold=null;this.director.pause(!!this.manualPaused||hold.priorPaused);
      this.emit('body_pause_resumed',{turnId:hold.turnId,reason,pausedMs:this.now()-hold.at});
    }finally{if(hold)hold.resuming=false;}
  }
  cancel(reason='explicit_user_interrupt',remote=true){
    const t=this.current,hold=this.bodyHold,hadWork=this._hasBodyWork();
    const bodyOnly=!t||t.revoked||t.settledAt!==undefined;
    // Parent cancellation intentionally protects a settled history entry.
    // Retire its visual lease separately, including commands still in flight.
    if(bodyOnly&&(t||hold||hadWork))this._visual(()=>this.director.cancel({turnId:t?.id??hold?.turnId??null,reason}));
    this.bodyHold=null;this.director.pause(!!this.manualPaused||!!hold?.priorPaused);
    const audioCancelled=super.cancel(reason,remote);
    if(bodyOnly&&t&&remote)this.send({type:'cancel',turnId:t.id});
    if(hold||hadWork)this.emit('body_interruption_cancelled',{turnId:t?.id??hold?.turnId??null,reason,
      historyPreserved:t?.settledAt!==undefined,hadBodyHold:!!hold});
    return audioCancelled||!!hold||hadWork;
  }
  setManualPause(value){
    this.manualPaused=!!value;
    if(this.bodyHold)this.bodyHold.priorPaused=this.manualPaused;
    this.director.pause(this.manualPaused||!!this.bodyHold);
    if(this.manualPaused)this.session.pause();
    else if(!this.bodyHold)void this.session.resume();
    return this.manualPaused;
  }
  reportPlaybackState(){
    const t=this.current,a=this.session.audio.snapshot();
    if(this.localReplay||!this.ready||!t?.owner||t.revoked||this.session.owner!==t.owner||a.epoch!==t.owner.epoch)return false;
    if(!['buffering','playing','paused','ended','cancelled'].includes(a.status)||!Number.isFinite(a.time))return false;
    const frame=Math.max(0,Math.min(t.frames,Math.round(a.time*24000)));
    const segment=t.segments?.findLast(s=>s.startFrame<=frame);if(!segment)return false;
    if(frame>segment.startFrame+segment.frames)return false;
    const state={turnId:t.id,segmentIndex:segment.index,providerConnectionId:segment.connectionId,
      responseId:segment.responseId,playedFrame:frame,status:a.status,sourceActive:!!a.sourceActive};
    const signature=[state.turnId,state.segmentIndex,state.responseId,state.status,state.sourceActive].join(':');
    const at=this.now(),last=this.lastPlaybackState,keepAlive=a.status!=='ended'||this._hasBodyWork();
    if(last?.signature===signature&&(!keepAlive||at-last.at<250))return false;
    const sequence=(this.playbackStateSequence??0)+1;
    if(!this.send({type:'character_playback_state',...state,sequence}))return false;
    this.playbackStateSequence=sequence;this.lastPlaybackState={signature,at};return true;
  }
  sync(){
    super.sync();
    const hold=this.bodyHold;
    if(this._currentBodyHold(hold)&&!hold.serverSpeechPending&&this.now()-this.lastLoudAt>1800)
      void this.resumeInvalid('unconfirmed_noise_resumed');
    this.reportPlaybackState();
  }
}
