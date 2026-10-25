import {ParallelDuplexClient} from '../parallel-duplex/client.mjs';

/** The independent visual tail must stop on new input even after voice/history
 * completed. Do not revoke already delivered history to clean up a gesture. */
export class ModelDuplexClient extends ParallelDuplexClient {
  cancel(reason='explicit_user_interrupt',remote=true) {
    const t=this.current;
    if(t)this._visual(()=>this.director.cancel({turnId:t.id,reason}),t);
    if(t?.settledAt!==undefined&&t.owner===this.session.owner) {
      this.session.cancel(reason,t.owner);
      this.emit('visual_tail_cancelled',{turnId:t.id,reason,historyPreserved:true});return true;
    }
    return super.cancel(reason,remote);
  }
  provisionalPause(reason) {
    const t=this.current;
    if(t&&!t.revoked&&this.director.hasWork())this.director.paused=true;
    return super.provisionalPause(reason);
  }
  async resumeInvalid(reason) {
    if(!this.current?.revoked)this.director.paused=false;
    return super.resumeInvalid(reason);
  }
  sync() {
    super.sync();
    // Same local-noise fallback as the audio client, including natural-end tails.
    if(this.director.paused&&!this.director.userPaused&&!this.current?.serverSpeechPending
        &&this.now()-this.lastLoudAt>1800)this.director.paused=false;
  }
}
