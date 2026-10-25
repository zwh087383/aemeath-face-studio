/** Native provider tool -> existing audio-clock scheduler. No subtitle parsing. */
export const EXPRESSIONS = ['neutral','smile','happy','curious','focus','surprise','shy','playful'];
export const GESTURES = ['none','nod','shake','tilt','glance','blink','explain','wave','shrug','chest','bow_smile','laugh','curious','shy','explain_firm','surprise','think','greet','listen','comfort','look_up','agree'];
const short = new Set(['nod','shake','tilt','glance','blink']);
export class FunctionCallDriver {
  constructor(session, owner, {leadSeconds=.06, legacyBufferZero=false}={}) {
    if(!Number.isFinite(leadSeconds)||leadSeconds<0||leadSeconds>.2)throw new RangeError('invalid_tool_lead');
    this.session=session;this.owner=owner;this.calls=new Set();this.revoked=false;
    this.leadSeconds=leadSeconds;this.legacyBufferZero=legacyBufferZero;
  }
  cancel() { this.revoked=true; }
  accept(event) {
    if(this.revoked || this.session.owner !== this.owner) return {accepted:false,reason:'revoked_or_stale_owner'};
    if(event.name!=='perform_avatar' || typeof event.callId!=='string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(event.callId)
      || typeof event.arguments!=='string' || event.arguments.length>4096) return {accepted:false,reason:'invalid_tool'};
    if(this.calls.has(event.callId)) return {accepted:false,reason:'duplicate_call'};
    let p;try{p=JSON.parse(event.arguments);}catch{return {accepted:false,reason:'invalid_json'};}
    if(!p || Array.isArray(p) || Object.keys(p).sort().join(',')!=='expression,gesture,intent,strength'
      || !EXPRESSIONS.includes(p.expression) || !GESTURES.includes(p.gesture)
      || typeof p.strength!=='number' || !Number.isFinite(p.strength) || p.strength<.35 || p.strength>1
      || typeof p.intent!=='string' || !p.intent.length || p.intent.length>80) return {accepted:false,reason:'invalid_plan'};
    const audio=this.session.audio.snapshot();
    if(!['buffering','playing','paused'].includes(audio.status)) return {accepted:false,reason:'audio_turn_closed'};
    this.calls.add(event.callId);
    // Buffering also means a mid-stream underrun: retain the current media head.
    // The legacy switch exists only for labelled offline comparison in the lab.
    // Never loosen the scheduler's ownership or stale-cue checks.
    const at=audio.status==='buffering'
      ? (this.legacyBufferZero?0:audio.time)
      : audio.time+this.leadSeconds;
    const prefix=`fc:${event.callId}`;
    const face=this.session.enqueue({id:prefix+':face',kind:'expression',preset:p.expression,strength:p.strength,at},this.owner);
    let motion=null;
    if(p.gesture!=='none') motion=this.session.enqueue({id:prefix+':motion',kind:short.has(p.gesture)?'action':'gesture',
      [short.has(p.gesture)?'action':'gesture']:p.gesture,strength:p.strength,at},this.owner);
    return {accepted:face.accepted===true && (!motion || motion.accepted===true),plan:p,at,face,motion,
      reason:'scheduler_admission_is_not_render_confirmation'};
  }
}
