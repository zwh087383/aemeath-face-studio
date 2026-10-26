/** Measurement only. Never changes playback, model decisions, or history. */
export function captureOwnedVoice(client, now = performance.now()) {
  const t=client.current, session=client.session, a=session.audio.snapshot();
  if(!t||t.revoked||!t.owner||session.owner!==t.owner||a.epoch!==t.owner.epoch)return false;
  const marker=session.audio.playbackMarker();
  if(!marker?.reached)return false;
  if(t.voiceAt!==undefined&&t.voiceAt>=t.requestAt)return false;
  if(t.voiceAt!==undefined)t.invalidVoiceMeasurement=t.voiceAt;
  t.voiceAt=now-(session.audio.context.currentTime-marker.contextTime)*1000;
  t.voiceMeasurement='owned_audio_context_voiced_marker';
  return true;
}

export function compactReport(report){
  return {...report,evidencePolicy:'Full provider/session events remain in duplex session JSON; repeated actor geometry omitted from client report.',
    events:report.events.map(e=>{
      if(e.type==='character_math'){const {actorState,...state}=e.state;return {...e,state};}
      if(e.type==='character_actor'){const {bones,rotations,props,...actorState}=e.actorState;return {...e,actorState};}
      return e;
    })};
}
