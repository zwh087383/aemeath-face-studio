/** Consumes authoritative WAI snapshots; never advances business completion. */
export class IdleScheduler {
  constructor(motion){this.motion=motion;this.session=null;this.generation=-1;this.revision=-1;this.mode='idle';this.events=[];this.last=null;this.localAttention=false;}
  attention(){this.localAttention=true;this.setMode('listening','检测到开口，先让出注意');}
  setMode(mode,reason){if(mode===this.mode)return;this.mode=mode;this.motion.setMode(mode);this.events.push({mode,reason,at:performance.now()});this.events=this.events.slice(-60);}
  accept(state){
    if(!state||!Number.isSafeInteger(state.revision)||!Number.isSafeInteger(state.generation))return false;
    if(this.session===state.sessionId&&(state.generation<this.generation||state.revision<this.revision))return false;
    if(this.session!==state.sessionId){this.motion.clearCheckpoint();this.localAttention=false;}
    if(state.generation!==this.generation)this.motion.clearCheckpoint();
    this.session=state.sessionId;this.generation=state.generation;this.revision=state.revision;this.last=state;
    if(state.engaged)this.localAttention=false;
    if(this.localAttention&&!state.engaged)return true; // Do not let a pre-ACK poll undo microphone attention.
    let mode='idle',reason='保持原生待机';
    if(state.engaged){mode='listening';reason='后台已确认用户到场';}
    else if(state.error||state.task?.status==='failed'){mode='idle';reason='活动已失效，收势后保持';}
    else if(state.task?.status==='paused'){mode='paused';reason='后台保存进度，身体自然退出';}
    else if(state.task?.status==='running'){mode='working';reason=state.provider==='artifact-ready'?'产物已保存，活动时段尚未结束':'WAI活动正在进行';}
    else if(state.task?.status==='done'){mode='complete';reason='WAI已确认成果和活动完成';}
    this.setMode(mode,reason);return true;
  }
  connectionLost(){this.localAttention=false;this.setMode('paused','后台连接不可用，停止新的活动段落');}
  snapshot(){return {mode:this.mode,session:this.session,generation:this.generation,revision:this.revision,events:this.events.slice(-20)};}
}
