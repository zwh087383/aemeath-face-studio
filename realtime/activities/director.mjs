import { ACTIVITY_LIBRARY, ACTIVITY_SEQUENCES, sampleActivity } from '../../preview/core/activity-library.js';
import { activityPropNeed, heldPropSides, propAdmissionConflict } from '../../preview/core/activity-continuity.js';
import { partitionedDeskConflict } from '../../preview/core/activity-desk-layout.js';
import { ACTIVITY_PROP_LAYOUT } from '../../preview/core/activity-prop-layout.js';
import { qrotate, qconj, qeuler } from '../../preview/core/motion-math.js';
import { pulledOutDeskEntryFixture } from '../../preview/core/activity-seat-access.js';

const finite = (value, count) => Array.isArray(value) && value.length === count && value.every(Number.isFinite);
const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
const quaternionAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0))));

/** Explicit initial preview setup only. Existing physical objects and an active
 * person are never rearranged to make a recipe pass its admission checks. */
export function initializeEmptyActivityScene(body, props, definition) {
  if (!definition?.initialScene) return { initialized: false, reason: 'no_initial_scene' };
  if (Object.values(props.snapshot().props ?? {}).some(prop => prop.visible)
    || Object.values(body.sceneProps ?? {}).some(prop => prop?.visible))
    return { initialized: false, reason: 'existing_scene_preserved' };
  if (!body.done || body.activeId || body.bridge || body.queued)
    return { initialized: false, reason: 'existing_activity_preserved' };
  if (definition.initialScene.kind !== 'pulled-out-desk-entry')
    return { initialized: false, reason: 'unknown_initial_scene' };
  const fixture = pulledOutDeskEntryFixture(body.context, { retreat: definition.initialScene.chairRetreat,
    props: definition.steps[0].setupProps });
  props.update(fixture.sceneProps, { anchor: { position: [0, 0, 0], yaw: 0 }, time: body.now });
  body.setRenderedPropsSnapshot(props.snapshot());
  if (!body.adoptSupportedState({ pose: body.standing(fixture.initialRoot), sceneProps: body.sceneProps }))
    throw new Error('Initial standing fixture could not establish actual support');
  return { initialized: true, fixture };
}

/** One cancellable owner for an activity sequence. No timers or hidden callbacks. */
export class ActivityDirector {
  constructor(body){this.body=body;this.time=0;this.wall=null;this.paused=false;this.sequence=null;this.generation=0;this.speed=1;this.events=[];}
  record(type,data={}){this.events.push({type,at:this.time,...data});if(this.events.length>80)this.events.shift();}
  alreadyHeld(step){const def=ACTIVITY_LIBRARY[step.activity];return def.kind==='take_prop'&&heldPropSides(this.body.snapshot().pose?.props?.[def.propId]).length>0;}
  seatedDeskEntry(steps){
    const state=this.body.snapshot();
    if(steps[0]?.satisfiedWhen!=='already-seated-at-same-desk'||state.pose?.support!=='seated')return null;
    const failure=detail=>({reason:'seated-desk-entry-not-supported',detail});
    // This is a finite admission rule for the existing work position, not a
    // route planner. A seated character must never stand and walk into a desk
    // merely to reenact the recipe's fresh-scene introduction.
    if(!state.done||this.body.bridge||state.queued||state.stopMode)return failure('finish-current-seated-transfer');
    const pose=state.pose,root=state.root,velocity=this.body.velocity;
    if(!finite(root?.position,3)||!Number.isFinite(root.yaw)||!finite(pose.pelvis?.offset,3)
      ||!finite(velocity?.root?.position,3)||!finite(velocity?.pelvis?.offset,3))return failure('missing-actual-seat-state');
    if(Math.hypot(...velocity.root.position)>.03||Math.abs(velocity.root.yaw??Infinity)>.03
      ||Math.hypot(...velocity.pelvis.offset)>.03)return failure('seat-still-moving');
    const table=this.body.sceneProps?.table,chair=this.body.sceneProps?.chair;
    for(const [id,prop]of [['table',table],['chair',chair]]){
      const frame=prop?.worldTransform;
      if(!prop?.visible||!finite(frame?.position,3)||!finite(frame?.quaternion,4)
        ||Math.abs(Math.hypot(...frame.quaternion)-1)>.0001)return failure(`missing-actual-${id}-frame`);
      if(distance(qrotate(frame.quaternion,[0,1,0]),[0,1,0])>.04)return failure(`unsupported-${id}-tilt`);
    }
    const frame=table.worldTransform,inverse=qconj(frame.quaternion);
    const inDesk=point=>qrotate(inverse,point.map((value,index)=>value-frame.position[index]));
    const rootError=distance(inDesk(root.position),ACTIVITY_PROP_LAYOUT.table.position.map(value=>-value));
    const chairError=distance(inDesk(chair.worldTransform.position),ACTIVITY_PROP_LAYOUT.chair.position.map((value,index)=>value-ACTIVITY_PROP_LAYOUT.table.position[index]));
    const yawError=quaternionAngle(frame.quaternion,qeuler(0,root.yaw,0));
    const chairAngle=quaternionAngle(frame.quaternion,chair.worldTransform.quaternion);
    if(rootError>.08||chairError>.08||yawError>.04||chairAngle>.04)return failure('different-table-chair-work-position');
    const seated=sampleActivity('sit_down',ACTIVITY_LIBRARY.sit_down.duration,this.body.context);
    if(distance(pose.pelvis.offset,seated.pelvis.offset)>.15)return failure('pelvis-not-on-supported-seat');
    for(const side of ['L','R']){
      const foot=pose.feet?.[side],expected=qrotate(qeuler(0,root.yaw,0),seated.feet[side].position).map((value,index)=>value+root.position[index]);
      if(!foot?.contact||!finite(foot.position,3)||distance(foot.position,expected)>.12
        ||!(state.diagnostics?.legs?.[side]?.error<.03))return failure('feet-not-in-supported-work-position');
    }
    return {reason:'already-seated-at-same-desk',rootError,chairError,yawError,chairAngle};
  }
  admissionConflict(steps){
    const props=structuredClone(this.body.snapshot().pose?.props??{});
    for(const step of steps){
      const def=ACTIVITY_LIBRARY[step.activity],conflict=propAdmissionConflict(def,props);
      if(conflict)return{...conflict,activity:step.activity};
      const need=activityPropNeed(def);
      if(def.kind==='put_prop')delete props[def.propId];
      else if(need)props[need.id]={visible:true,attachment:need.sides.length===2?'both':need.sides[0]==='L'?'left':'right'};
    }
    return null;
  }
  physicalRejection(id,options={}){
    const seat=this.body.seatAccess?.(id);if(seat&&!seat.accepted)return seat;
    const route=this.body.routeAdmission?.(id,options);if(route&&!route.accepted)return route;
    return {reason:'activity-not-admitted'};
  }
  play(id,{context={}}={}){
    if(!Object.hasOwn(ACTIVITY_LIBRARY,id))return false;
    // A replacement at an acquisition/placement receipt keeps the established
    // physical desk layout unless explicitly changed. Omitting it must not
    // reinterpret the same measured back-of-desk source as a near-edge one.
    context={...(this.body.sampleContext?.deskLayout?{deskLayout:this.body.sampleContext.deskLayout}:{}),...context};
    const def=ACTIVITY_LIBRARY[id],props=this.body.snapshot().pose?.props??{},conflict=propAdmissionConflict(def,props);
    if(conflict){this.lastRejection={id,...conflict};return false;}
    if(def.kind==='take_prop'&&heldPropSides(props[def.propId]).length){this.lastRejection={id,reason:'already-held',requestedProp:def.propId};return false;}
    const ok=this.body.play(id,{speed:this.speed,context});
    if(ok){this.lastRejection=null;this.sequence=null;this.generation++;this.paused=false;this.body.pause(false);this.record('activity',{id,generation:this.generation});}
    else this.lastRejection={id,...this.physicalRejection(id,{speed:this.speed,context})};
    return ok;
  }
  playSequence(id,{context={}}={}){
    const def=ACTIVITY_SEQUENCES[id],steps=def?.steps?.map(s=>typeof s==='string'?{activity:s,rest:.3}:s);
    if(!steps?.length||!steps.every(s=>Object.hasOwn(ACTIVITY_LIBRARY,s.activity)))return false;
    const conflict=this.admissionConflict(steps);if(conflict){this.lastRejection={id,...conflict};return false;}
    if(steps.some(step=>step.context?.deskLayout==='partitioned')){
      const deskConflict=partitionedDeskConflict(this.body.sceneProps,this.body.snapshot().pose?.props);
      if(deskConflict){this.lastRejection={...deskConflict,propId:deskConflict.id,id};return false;}
    }
    const seatedEntry=this.seatedDeskEntry(steps);
    if(seatedEntry&&seatedEntry.reason!=='already-seated-at-same-desk'){this.lastRejection={id,...seatedEntry};return false;}
    if(def.initialScene&&(!this.body.sceneProps?.chair?.worldTransform||!this.body.sceneProps?.table?.worldTransform)){
      this.lastRejection={id,reason:'missing-measured-initial-scene',requiredScene:def.initialScene.kind};return false;
    }
    let index=0;const satisfied=[];let entrySetup;
    while(index<steps.length&&seatedEntry&&steps[index].satisfiedWhen===seatedEntry.reason){
      if(steps[index].setupProps)entrySetup={...entrySetup,...steps[index].setupProps};
      satisfied.push({index,reason:seatedEntry.reason,evidence:seatedEntry});index++;
    }
    while(index<steps.length&&this.alreadyHeld(steps[index]))satisfied.push({index:index++,reason:'already-held'});
    if(index>=steps.length)return false;
    const sceneSetupProps=entrySetup?{...entrySetup,...steps[index].setupProps}:steps[index].setupProps;
    const options={speed:this.speed,context:{...context,...steps[index].context,sceneSetupProps}};
    if(!this.body.play(steps[index].activity,options)){
      this.lastRejection={id,activity:steps[index].activity,...this.physicalRejection(steps[index].activity,options)};return false;
    }
    this.paused=false;this.body.pause(false);this.sequence={id,steps,index,generation:++this.generation,phase:'playing',due:0,context,
      bodyRevision:this.body.snapshot().revision};this.lastRejection=null;this.record('sequence',{id,generation:this.generation});
    for(const step of satisfied)this.record('step-satisfied',{id:steps[step.index].activity,index:step.index,generation:this.generation,reason:step.reason,...(step.evidence?{evidence:step.evidence}:{})});
    return true;
  }
  pause(){this.paused=!this.paused;this.body.pause(this.paused);this.record(this.paused?'pause':'resume');return this.paused;}
  stop(){this.sequence=null;this.generation++;this.paused=false;this.body.pause(false);this.body.stop();this.record('stop');}
  reset(){this.sequence=null;this.generation++;this.paused=false;this.body.reset();this.time=0;this.wall=null;this.record('reset');}
  tick(wall){
    const dt=this.wall===null?0:Math.min(.1,Math.max(0,wall-this.wall));this.wall=wall;if(!this.paused)this.time+=dt;
    const s=this.sequence;
    if(s&&!this.paused&&s.generation===this.generation){
      const state=this.body.snapshot();
      if(s.bodyRevision!==undefined&&state.revision!==s.bodyRevision){
        this.record('sequence-retired',{id:s.id,reason:'body-owner-changed',generation:s.generation});this.sequence=null;
        return{now:this.time,dt:this.paused?0:dt,paused:this.paused};
      }
      if(s.phase==='playing'&&state.done&&(state.activeId===undefined||state.activeId===s.steps[s.index].activity)){
        this.record('step-completed',{id:s.steps[s.index].activity,index:s.index,generation:s.generation,variant:state.variant??state.pose?.variant??'authored'});
        s.phase='rest';s.due=this.time+(s.steps[s.index].rest??.35);
      }
      if(s.phase==='rest'&&this.time>=s.due){
        s.index++;
        while(s.index<s.steps.length&&this.alreadyHeld(s.steps[s.index])){
          this.record('step-satisfied',{id:s.steps[s.index].activity,index:s.index,generation:s.generation,reason:'already-held'});s.index++;
        }
        if(s.index>=s.steps.length){this.record('sequence-ended',{id:s.id});this.sequence=null;}
        else if(this.body.play(s.steps[s.index].activity,{speed:this.speed,context:{...s.context,...s.steps[s.index].context,sceneSetupProps:s.steps[s.index].setupProps}})){s.phase='playing';s.bodyRevision=this.body.snapshot().revision;this.record('step',{id:s.steps[s.index].activity,index:s.index,generation:s.generation});}
        else{const id=s.steps[s.index].activity;this.lastRejection={id,...this.physicalRejection(id,{speed:this.speed,context:{...s.context,...s.steps[s.index].context}})};
          this.record('sequence-rejected',this.lastRejection);this.stop();}
      }
    }
    return{now:this.time,dt:this.paused?0:dt,paused:this.paused};
  }
  snapshot(){return{time:this.time,paused:this.paused,speed:this.speed,sequence:this.sequence?{id:this.sequence.id,step:this.sequence.index+1,total:this.sequence.steps.length,phase:this.sequence.phase}:null,events:this.events.slice(),lastRejection:this.lastRejection??null};}
}
