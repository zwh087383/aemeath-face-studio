import {FunctionCallDriver} from './functioncall-driver.mjs';

// Compact calls are expanded locally, without asking the model for log prose.
// The existing scheduler and authored motion trajectories remain untouched.
export class CooutputDriver extends FunctionCallDriver {
  constructor(session, owner, group) { super(session, owner); this.group = group; this.localCalls = new Map(); }
  accept(event) {
    if (this.group === 'A') return {accepted:false, reason:'unexpected_baseline_tool'};
    if (typeof event.callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(event.callId))
      return {accepted:false, reason:'invalid_tool'};
    // MotionController remembers cue IDs across epochs. A saved provider call
    // must have a new trusted local execution ID on replay, while duplicates
    // within the same response still map to the same ID and are rejected.
    if (!this.localCalls.has(event.callId)) this.localCalls.set(event.callId, `e${this.owner.epoch}.c${this.localCalls.size + 1}`);
    const localCallId = this.localCalls.get(event.callId);
    const local = {...event, callId:localCallId};
    const accept = value => ({...super.accept(value), providerCallId:event.callId, localCallId});
    if (this.group !== 'D') return accept(local);
    let plan;
    try { plan = JSON.parse(event.arguments); } catch { return {accepted:false, reason:'invalid_json'}; }
    if (!plan || Array.isArray(plan) || Object.keys(plan).sort().join(',') !== 'expression,gesture')
      return {accepted:false, reason:'invalid_compact_fields'};
    return accept({...local, arguments:JSON.stringify({...plan, strength:.65,
      intent:'本地默认强度；模型仅选择表情和动作'})});
  }
}
