import {ParallelDuplexClient} from '../parallel-duplex/client.mjs';

/** Compatibility with the old audio client is scoped here. The actual ledger
 * remains intact: terminal-but-unreported calls retain their maximum charge. */
export class CharacterClient extends ParallelDuplexClient {
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
    const budget=message.budget??this.budget;
    const admissible=budget&&!budget.blocked&&!budget.channels?.listener?.frozen&&!budget.channels?.voice?.frozen;
    const audioView=admissible?{...message,budget:{...budget,unknown:0,unknownTerminalReserved:budget.unknown}}:message;
    super.message(audioView,generation);
    if(budget)this.budget=budget;
    // Confirmed server speech is sufficient to shift physical attention now;
    // do not wait for an additional backend sidecar event or semantic model.
    // The backend's matching character_attention packet is deduplicated by item.
    if(message.connectionId===this.connectionId&&message.type==='speech_started')
      this._visual(()=>this.director.message({type:'character_attention',connectionId:message.connectionId,
        itemId:message.itemId,reason:'user_speech_started',semanticUnderstanding:false}));
    if(message.connectionId===this.connectionId&&
      (message.type.startsWith('character_')||message.type==='activity_state'))this._visual(()=>this.director.message(message));
    if(message.connectionId===this.connectionId&&this.listenerResume&&['listener_resumed','listener_resume_failed','blocked','closed'].includes(message.type)){
      const pending=this.listenerResume;this.listenerResume=null;clearTimeout(pending.timer);
      if(message.type==='listener_resumed'&&message.ready!==false)pending.resolve(message);
      else pending.reject(Error(message.reason??message.code??'listener_resume_failed'));
    }
  }
  get canReconnect(){return this.blocked&&!this.hardBlocked&&this.blockReason==='session_input_limit'
    &&!this.budget?.blocked&&!this.budget?.channels?.listener?.frozen&&!this.budget?.channels?.voice?.frozen;}
  // Provisional VAD may be noise. Audio retains its original pause/resume guard;
  // body exit and support clocks continue until a real attention event arrives.
  provisionalPause(reason){return super.provisionalPause(reason);}
  async resumeInvalid(reason){await super.resumeInvalid(reason);this.director.pause(false);}
  cancel(reason='explicit_user_interrupt',remote=true){this.director.pause(false);return super.cancel(reason,remote);}
}
