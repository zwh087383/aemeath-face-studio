/** Business fixtures and user input only. This runner never sends an action or
 * expression command. Failed attempts remain in the same finite batch. */
export async function runFirstStage(api,{resumeAfterSix=false}={}){
  const state={startedAt:new Date().toISOString(),resumeAfterSix,running:true,step:'starting',results:[],error:null};api.suiteState=state;
  const wait=async(predicate,label,seconds=100)=>{const end=performance.now()+seconds*1000;state.step=label;while(performance.now()<end){
    const s=api.state();if(s.renderFault)throw Error('render_fault:'+s.renderFault.message);
    if(s.blocked)throw Error('cloud_channel_blocked');const value=await predicate(s);if(value)return value;await new Promise(r=>setTimeout(r,250));}throw Error('deadline:'+label);};
  const turn=async(id)=>{const before=api.state().trials.length;state.step='input:'+id;await api.feed(id);
    const result=await wait(s=>s.trials[before]&&(s.trials[before].settledAt!==undefined||s.trials[before].error||s.trials[before].revoked)&&s.trials[before],'reply:'+id);
    state.results.push({fixture:id,turnId:result.id,status:result.error?'error':result.revoked?'revoked':'settled',metrics:result.metrics});await api.save();return result;};
  const activity=async(id)=>{state.step='activity:'+id;await api.activityStart(id);await wait(async()=>{const status=await api.refresh();return status.activity?.status==='running'||['failed','done'].includes(status.activity?.status);},'activity start:'+id,240);};
  const terminal=async(id)=>{const status=await wait(async()=>{const status=await api.refresh();return ['done','failed','dropped'].includes(status.activity?.status)&&status;},'activity terminal:'+id,260);state.results.push({activity:id,status:status.activity.status,artifactId:status.activity.artifactId});await api.save();};
  const barge=async(longId,shortId,generated)=>{
    const before=api.state().trials.length;await api.feed(longId);
    await wait(s=>{const t=s.trials[before];return t&&!t.revoked&&t.voiceAt!==undefined&&s.audio.status==='playing'&&s.audio.queuedSeconds>.7&&(!generated||t.outputDoneAt!==undefined);},generated?'生成结束后仍在播放':'正在播放中插话',65);
    await turn(shortId);const old=api.state().trials[before];state.results.push({fixture:longId,status:old.revoked?'barge_cancelled':'barge_not_confirmed',metrics:old.metrics});await api.save();
  };
  try{
    const status=await api.refresh();
    if(status.budget.turns!==(resumeAfterSix?6:0))throw Error('first_stage_turn_count_mismatch');
    const previousCases=Object.keys(status.cases??{});
    if(resumeAfterSix&&previousCases.some(id=>id!=='reading-complete'))throw Error('resume_activity_already_attempted');
    const previousReading=status.cases?.['reading-complete']?.events?.at(-1);
    if(previousReading&&!['done','failed','dropped'].includes(previousReading.status))throw Error('resume_activity_still_active');
    if(!api.state().ready)await api.connect();
    if(!resumeAfterSix)for(const id of ['emotion-happy','emotion-sad','emotion-serious','emotion-uncertain','memory-correct','memory-retrieve'])await turn(id);
    if(previousReading)state.results.push({activity:'reading-complete',status:previousReading.status,retainedEarlierAttempt:true});
    else{await activity('reading-complete');await terminal('reading-complete');}
    await activity('reading-inflight');
    const inFlight=await wait(async()=>{const s=await api.refresh();return s.activity?.actualModelRequestRunning?s:s.activity?.artifactId?'already_finished':false;},'等待真实阅读模型请求',50);
    state.results.push({check:'reading_inflight_window',observed:inFlight!=='already_finished'});
    await turn('background-inflight');await terminal('reading-inflight');
    await activity('reading-artifact');await wait(async()=>{const s=await api.refresh();return s.activity?.artifactId;},'等待实际阅读产物',65);
    await turn('background-artifact');await terminal('reading-artifact');
    await barge('barge-long-one','barge-stop-one',false);
    await barge('barge-long-two','barge-stop-two',true);
    await activity('reading-revoke');await api.activityRevoke();await terminal('reading-revoke');
    await activity('reading-failure');await terminal('reading-failure');
    state.step='completed';
  }catch(e){state.error=e.message;state.step='stopped_with_evidence';throw e;}
  finally{state.running=false;state.endedAt=new Date().toISOString();await api.save();}
  return state;
}

/** Finish the same batch after the retained 20-second-queue failure. The last
 * approved input is still used once; it no longer claims the missed second
 * barge-in window. Instead it checks activity-source revocation during speech. */
export async function finishFirstStage(api){
  const state={startedAt:new Date().toISOString(),running:true,step:'starting_final_cases',results:[],
    speciality:'Original generated-complete barge case failed before input; final input reused only as its first authorized send during source-revocation validation.'};api.suiteState=state;
  const wait=async(predicate,label,seconds=90)=>{state.step=label;const until=performance.now()+seconds*1000;
    while(performance.now()<until){const s=api.state();if(s.renderFault||s.blocked)throw Error(s.renderFault?.message??'client_blocked');
      const value=await predicate(s);if(value)return value;await new Promise(r=>setTimeout(r,250));}throw Error('deadline:'+label);};
  try{
    const initial=await api.refresh();if(initial.budget.turns!==11||initial.cases['reading-revoke']||initial.cases['reading-failure'])throw Error('final_cases_already_attempted_or_wrong_batch');
    if(!api.state().ready)await api.connect();
    await api.activityStart('reading-revoke');
    await wait(async()=>{const s=await api.refresh();return s.activity?.artifactId;},'最后一场阅读实际生成笔记',240);
    await new Promise(r=>setTimeout(r,6000)); // Observation time only; no motion commands.
    await api.feed('barge-stop-two');
    const voiced=await wait(s=>s.trials.at(-1)?.voiceAt!==undefined&&s.audio.status==='playing'&&s.trials.at(-1),'等待最后一条真实回复出声');
    await api.activityRevoke();
    const revoked=await wait(s=>s.trials.find(t=>t.id===voiced.id)?.revoked,'撤回来源后停止回复');
    state.results.push({activity:'reading-revoke',status:'source_revoked_during_voice',turnId:voiced.id,voiceStarted:true,revoked});await api.save();
    await api.activityStart('reading-failure');
    const failed=await wait(async()=>{const s=await api.refresh();return s.activity?.id==='reading-failure'&&s.activity.status==='failed'&&s.activity;},'明确抓取故障终止',260);
    state.results.push({activity:'reading-failure',status:failed.status,reason:failed.block?.reason,artifactId:failed.artifactId});
    state.step='completed_final_cases';
  }catch(e){state.error=e.message;state.step='stopped_with_evidence';throw e;}
  finally{state.running=false;state.endedAt=new Date().toISOString();await api.save();}
  return state;
}
