import {VoicedPreparedMotionController,VoicedPreparedFaceController} from '../action-timing/prep-driver.mjs';

// Preserve every authored trajectory. This mode changes only preparation
// lifetime: a slow voice cannot silently expire an accepted model command.
export class ModelMotionController extends VoicedPreparedMotionController {
  advancePreparation(now,audio,marker=null) {
    for(const [id,p] of this.preparations) {
      if(p.owner.epoch!==this.epoch){this.preparations.delete(id);continue;}
      const g=this.gestures.find(g=>g.id===id);
      if(g?.recovering)continue;
      if(!g&&!this.pending.some(c=>c.id===id)){this.preparations.delete(id);continue;}
      if(['cancelled','fault','idle'].includes(audio.status)){this.abortPreparations(p.owner,now);continue;}
      // No-voice natural completion still releases the pending visual sequence.
      if(audio.status==='ended'&&!p.clock.release)p.clock.release={raw:p.clock.raw,velocity:p.clock.velocity,media:audio.time,wall:now};
      p.clock.sample(now,audio,marker);
    }
  }
}

export class ModelFaceController extends VoicedPreparedFaceController {
  update(now,dt,lip,idle,options={}) {
    if(options.paused)for(const cue of this.cues)if(cue.clock==='wall')cue.at+=Math.max(0,now-this.now);
    return super.update(now,dt,lip,idle,options);
  }
}
