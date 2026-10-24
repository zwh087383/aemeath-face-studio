import {NativeBehaviorPlayer,cloneNativePose,nativePoseVelocity} from '/preview/core/native-behavior.js';
import {buildNativeBehaviorPlan} from '/preview/core/native-behavior-adapter.js';

/** Small explicit allowlist: only upright, empty-hand native clips in this demo.
 * All source trajectories, body amplitude and phase speed remain unchanged.
 */
export class IdleMotion {
  constructor({adapter,manifest,groups}){
    this.adapter=adapter;
    const stand=groups.find(g=>g.id==='native:8b2e802a90db3da3');
    const think=groups.find(g=>g.id==='native:ac884e85b5aef5d1');
    if(!stand||!think)throw Error('缺少本demo的原生站姿/思考来源组');
    this.stand=buildNativeBehaviorPlan(stand,manifest);
    this.think=buildNativeBehaviorPlan(think,manifest);
    this.mode='idle';this.desired='idle';this.checkpoint=null;this.transitions=[];this.clock=0;
    this.player=null;this.exitPending=false;this.serial=0;
  }
  async load(read){
    await this.adapter.load([...this.stand,...this.think].map(p=>p.id),read);
    this.replace(this.stand.map(p=>({...p,phase:'loop'})),'idle');
  }
  clearCheckpoint(){this.checkpoint=null;}
  replace(plan,mode){
    const previous=this.player?cloneNativePose(this.player.pose()):cloneNativePose(this.adapter.sample(plan[0].id,plan[0].offset??0));
    const velocity=this.player?cloneNativePose(this.player.velocityAt(this.player.time)):null;
    const segmentMap=new Map(), mapped=plan.map((p,i)=>{
      const key=p.id+'#'+i;segmentMap.set(key,p);return {...p,id:key,sourceId:p.id};
    });
    this.plan=plan;
    const next=new NativeBehaviorPlayer({plan:mapped,repeat:100000,
      sample:(key,t)=>{const p=segmentMap.get(key);return this.adapter.sample(p.id,t+(p.offset??0));},
      initialPose:previous,initialVelocity:velocity,align:(a,b)=>this.adapter.alignment(a,b),
      stopOptions:this.adapter.stopOptions(),bridgeSeconds:.45});
    const current=next.pose();
    const positionJump=Math.max(...previous.map((p,i)=>p.p.distanceTo(current[i].p)));
    const angleJump=Math.max(...previous.map((p,i)=>p.q.angleTo(current[i].q)));
    this.player=next;this.mode=mode;this.serial++;
    this.transitions.push({mode,at:this.clock,positionJump,angleJump,resumed:plan.some(p=>p.offset>0)});
    this.transitions=this.transitions.slice(-60);
    this.adapter.apply(next.pose());
  }
  saveCheckpoint(){
    if(this.mode!=='working'||this.exitPending)return;
    const p=this.plan[this.player.index];
    if(p.phase==='end')return;
    const offset=(p.offset??0)+Math.min(p.duration,this.player.time-this.player.origin);
    const original=this.think.find(x=>x.id===p.id);
    this.checkpoint={id:p.id,phase:original?.phase??p.phase,offset,
      originalDuration:original?.duration??p.duration};
  }
  workPlan(){
    const point=this.checkpoint;
    if(!point)return this.think;
    const index=this.think.findIndex(p=>p.id===point.id),original=this.think[index];
    if(!original)return this.think;
    const remainder=original.duration-point.offset;
    const rest=this.think.slice(index+1);
    if(original.phase==='loop')rest.unshift({...original});
    if(remainder>.05)rest.unshift({...original,phase:'single',offset:point.offset,duration:remainder});
    if(!rest.some(p=>p.phase==='loop')){
      const loop=this.think.find(p=>p.phase==='loop');if(loop)rest.unshift(loop);
    }
    return rest;
  }
  setMode(mode){
    this.desired=mode;
    if(mode==='working'){
      if(this.mode==='working'&&!this.exitPending)return;
      if(this.exitPending)return; // Finish the already chosen, native near-body exit first.
      this.replace(this.workPlan(),'working');return;
    }
    if(this.mode==='working'&&!this.exitPending){
      this.saveCheckpoint();
      this.exitPending=true;
      this.player.cancel({useEnd:true});
      this.mode='exiting';
    }else if(!this.exitPending&&this.mode!==mode){
      this.replace(this.stand.map(p=>({...p,phase:'loop'})),mode);
    }
    if(mode==='complete'||mode==='idle')this.clearCheckpoint();
  }
  advance(dt){
    this.clock+=dt;
    this.player.advance(dt);
    if(this.exitPending&&this.player.state==='cancelled-held'){
      this.exitPending=false;
      if(this.desired==='working')this.replace(this.workPlan(),'working');
      else this.replace(this.stand.map(p=>({...p,phase:'loop'})),this.desired);
    }
    this.adapter.apply(this.player.pose());
  }
  snapshot(){return {mode:this.mode,desired:this.desired,exitPending:this.exitPending,checkpoint:this.checkpoint,
    serial:this.serial,clock:this.clock,phase:this.player?.snapshot(),adapter:this.adapter.snapshot(),
    transitions:this.transitions.slice(-15),bodyAmplitude:1,sourceSpeed:1};}
}
