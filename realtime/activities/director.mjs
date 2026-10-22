import { ACTIVITY_LIBRARY, ACTIVITY_SEQUENCES } from '../../preview/core/activity-library.js';

/** One cancellable owner for an activity sequence. No timers or hidden callbacks. */
export class ActivityDirector {
  constructor(body){this.body=body;this.time=0;this.wall=null;this.paused=false;this.sequence=null;this.generation=0;this.speed=1;this.events=[];}
  record(type,data={}){this.events.push({type,at:this.time,...data});if(this.events.length>80)this.events.shift();}
  play(id){if(!Object.hasOwn(ACTIVITY_LIBRARY,id))return false;const ok=this.body.play(id,{speed:this.speed});if(ok){this.sequence=null;this.generation++;this.paused=false;this.body.pause(false);this.record('activity',{id});}return ok;}
  playSequence(id){
    const def=ACTIVITY_SEQUENCES[id],steps=def?.steps?.map(s=>typeof s==='string'?{activity:s,rest:.3}:s);
    if(!steps?.length||!steps.every(s=>Object.hasOwn(ACTIVITY_LIBRARY,s.activity)))return false;
    if(!this.body.play(steps[0].activity,{speed:this.speed}))return false;
    this.paused=false;this.body.pause(false);this.sequence={id,steps,index:0,generation:++this.generation,phase:'playing',due:0};this.record('sequence',{id});return true;
  }
  pause(){this.paused=!this.paused;this.body.pause(this.paused);this.record(this.paused?'pause':'resume');return this.paused;}
  stop(){this.sequence=null;this.generation++;this.paused=false;this.body.pause(false);this.body.stop();this.record('stop');}
  reset(){this.sequence=null;this.generation++;this.paused=false;this.body.reset();this.time=0;this.wall=null;this.record('reset');}
  tick(wall){
    const dt=this.wall===null?0:Math.min(.1,Math.max(0,wall-this.wall));this.wall=wall;if(!this.paused)this.time+=dt;
    const s=this.sequence;
    if(s&&!this.paused&&s.generation===this.generation){
      const state=this.body.snapshot();
      if(s.phase==='playing'&&state.done){s.phase='rest';s.due=this.time+(s.steps[s.index].rest??.35);}
      if(s.phase==='rest'&&this.time>=s.due){
        if(++s.index>=s.steps.length){this.record('sequence-ended',{id:s.id});this.sequence=null;}
        else if(this.body.play(s.steps[s.index].activity,{speed:this.speed})){s.phase='playing';this.record('step',{id:s.steps[s.index].activity,index:s.index});}
        else{this.record('sequence-rejected',{id:s.steps[s.index].activity});this.stop();}
      }
    }
    return{now:this.time,dt:this.paused?0:dt,paused:this.paused};
  }
  snapshot(){return{time:this.time,paused:this.paused,speed:this.speed,sequence:this.sequence?{id:this.sequence.id,step:this.sequence.index+1,total:this.sequence.steps.length,phase:this.sequence.phase}:null,events:this.events.slice()};}
}
