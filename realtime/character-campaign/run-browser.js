async page => {
 await page.waitForFunction(()=>window.characterCenter?.ready===true,null,{timeout:90000});
 await page.locator('[data-view="full"]').click();
 return await page.evaluate(async()=>{
  const api=window.characterCenter, now=()=>performance.now(), sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const post=async(url,data)=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(!r.ok)throw Error('http_'+r.status+':'+url);return r.json();};
  const spec=await(await fetch('/api/campaign/case')).json();
  const result=window.campaign={id:spec.id,phase:'starting',startedAt:new Date().toISOString(),turns:[],gaps:[],activities:[],samples:[],bodyEvents:[],interruptions:[],errors:[]};
  let timer, busy=false, lastTick=0;
  const compact=()=>{const {samples,bodyEvents,...rest}=result;return {...rest,sampleCount:samples.length,bodyEventCount:bodyEvents.length};};
  const seenBody=new Set();
  const observe=()=>{const s=api.state();for(const e of s.body.events){const key=`${e.id}:${e.type}:${e.at}`;if(!seenBody.has(key)){seenBody.add(key);result.bodyEvents.push(e);}}
    const actor=s.body.actorState;return {at:now(),ready:s.ready,blocked:s.blocked,audio:s.audio,activity:s.activity,
    body:{active:s.body.active,pending:s.body.pending,executor:s.body.executor,actorState:{posture:actor.posture,support:actor.support,hands:actor.hands,
      props:actor.props,phase:actor.phase,canYield:actor.canYield,bones:actor.bones,rotations:actor.rotations}},
    face:{time:s.face.time,math:s.face.math,attitude:s.face.attitude,reactions:s.face.reactions,last:s.face.last,weights:s.face.weights},
    renderFault:s.renderFault,mathSource:'actual_WAI_stream'};};
  let publishTail=Promise.resolve();
  const publish=()=>{const value=compact();publishTail=publishTail.catch(()=>{}).then(()=>post('/api/campaign/progress',value));return publishTail;};
  const wait=async(test,label,seconds=90)=>{result.phase=label;const until=now()+seconds*1000;while(now()<until){const s=api.state();
    if(s.renderFault)throw Error('render_fault:'+s.renderFault.message);if(s.blocked)throw Error('blocked_session');
    const found=await test(s);if(found)return found;await sleep(100);}throw Error('deadline:'+label);};
  const saveTurn=(index)=>{const t=api.state().trials[index];if(!t)return null;return {id:t.id,text:t.text,transcript:t.transcript,metrics:t.metrics,
    input:t.input,requestAt:t.requestAt,voiceAt:t.voiceAt,bodyStartedAt:t.bodyStartedAt,firstBodyAction:t.firstBodyAction,
    revoked:t.revoked,historySettled:t.historySettled,settledAt:t.settledAt,error:t.error};};
  const postFault=async()=>{await api.activityRevoke();result.interruptions.push({kind:'background_source_revoked',at:now(),state:observe()});};
  window.campaignTask=(async()=>{
   const status=await api.refresh();if(status.actionProvider!=='deepseek'||!status.cloudEnabled||status.budget.turns!==0)throw Error('wrong_or_used_case');
   api.recordStart();await api.connect();
   result.initialCondition=await post('/api/character-center/initial-state',{fixtureId:spec.id});
   timer=setInterval(async()=>{if(busy)return;busy=true;try{result.samples.push(observe());if(now()-lastTick>3000){lastTick=now();await publish();}}catch(e){result.errors.push('sample:'+e.message);}finally{busy=false;}},1000);
   for(let i=0;i<spec.turns.length;i++){
    const clip=spec.turns[i];const startCount=api.state().trials.length;result.phase='feeding:'+clip.id;await publish();
    await api.feed(clip.id);
    const t=await wait(s=>s.trials[startCount],'turn_admitted:'+clip.id,30);
    const nextBarge=spec.interruptions.find(x=>x.beforeTurn===i+1), cancel=spec.interruptions.find(x=>x.cancelTurn===i);
    if(nextBarge||cancel){
     const rule=nextBarge||cancel;
     try{
      await wait(s=>{const v=s.trials[startCount];return v?.voiceAt!==undefined&&s.audio.status==='playing'&&now()-v.voiceAt>=rule.voiceAgeMs;},'voice_for_interrupt:'+clip.id,45);
      result.interruptions.push({kind:cancel?'explicit_cancel':'spoken_barge_next_turn',at:now(),before:observe(),targetTurn:t.id});
      if(cancel){api.cancel();await sleep(500);}
     }catch(e){result.errors.push('missed_interrupt:'+e.message);}
    }
    if(!nextBarge) await wait(s=>{const v=s.trials[startCount];return v&&(v.settledAt!==undefined||v.revoked||v.error)&&v;},'reply_terminal:'+clip.id,85);
    result.turns.push({fixture:clip.id,index:i,...saveTurn(startCount)});await api.save();await publish();
    if(i===spec.turns.length-1)break;
    const activitySpec=spec.activities?.find(x=>x.afterTurn===i);
    if(activitySpec){
     try{await api.activityStart(activitySpec.caseId);result.activities.push({...activitySpec,requestedAt:now()});}
     catch(e){result.errors.push('activity_start:'+activitySpec.id+':'+e.message);}
    }
    const gap={afterTurn:i,targetSeconds:spec.gapsSeconds[i],startedAt:now(),speechInterrupted:!!nextBarge};result.gaps.push(gap);
    // A spoken barge-in is a separate dimension: short conversations deliberately enter while audio is playing.
    if(!nextBarge){
     result.phase='idle_gap:'+i;let revoked=false;
     while((now()-gap.startedAt)/1000<gap.targetSeconds){
      if(activitySpec?.fault==='source_revoked'&&!revoked&&now()-gap.startedAt>45000){await postFault();revoked=true;}
      if(api.state().renderFault||api.state().blocked)throw Error('idle_render_or_transport_fault');
      await sleep(250);
     }
    }
    gap.endedAt=now();gap.actualSeconds=(gap.endedAt-gap.startedAt)/1000;
   }
   await sleep(3500);result.phase='finishing';
  })().catch(e=>{result.errors.push(e.message);result.phase='stopped_with_evidence';}).finally(async()=>{
   if(timer)clearInterval(timer);
   try{result.finalBrowser=observe();await api.save();await api.close();}catch(e){result.errors.push('close:'+e.message);}
   try{const blob=await api.recordStop();if(blob){const v=await fetch('/api/campaign/video',{method:'POST',headers:{'Content-Type':'video/webm'},body:blob});result.video=await v.json();}}catch(e){result.errors.push('video:'+e.message);}
   try{result.runtimeEvidence=await(await fetch('/api/duplex/drain',{method:'POST'})).json();result.finalServer=await api.refresh();}catch(e){result.errors.push('drain:'+e.message);}
   // Refresh all turn records after late revocation/history receipts.
   result.finalTurns=api.state().trials.map((_,i)=>saveTurn(i));
   result.endedAt=new Date().toISOString();result.phase='finished';
   await post('/api/campaign/observations',result);await publish();
  });
  await publish();return {started:true,id:spec.id,plannedTurns:spec.turns.length,manualActionCommands:false};
 });
}
