/** Optional adapter for the existing FaceController/MotionController contract.
 * No imports from the changing studio, no DOM access, and no automatic wiring.
 * The host must start the new audio transport AFTER scheduler.begin succeeds.
 */
export function createControllerSink({ audio, face, motion, onPosture = () => true, observe = () => {} }) {
  if (!audio || !face || !motion) throw new TypeError('audio, face and motion are required');
  const onceCancelled = controller => !controller.active;
  return command => {
    const { type, identity, atWall } = command;
    // Observation is diagnostic only: it must not prevent the authoritative stop.
    try { observe(command); } catch { /* ignore diagnostic failures */ }
    if (!identity) return false;
    const epoch = identity.epoch;
    switch (type) {
      case 'begin': {
        const a = face.begin(epoch), b = motion.begin(epoch);
        return a === true && b === true;
      }
      case 'playback': {
        const status = command.status === 'buffering' ? 'paused' : command.status;
        const a = face.playback(epoch, status, command.time), b = motion.playback(epoch, status, command.time);
        return a === true && b === true;
      }
      case 'cue': {
        if (command.cue.kind === 'action' && command.cue.action === 'nod' && motion.options?.continuity) {
          // The trusted scheduler already released this cue at the media anchor.
          // Only one controller owns the new head stroke; do not also enqueue the
          // legacy fixed nod in FaceController.
          const accepted = motion.requestReaction({ id: command.cue.id, kind: 'nod', strength: command.cue.strength,
            now: atWall, owner: identity, clock: 'audio', audioAt: command.cue.at, reason: 'audio_anchored_agreement' }) === true;
          try { observe({ type: 'reaction_admission', identity, atWall, cue: command.cue, accepted,
            reason: accepted ? 'motion_accepted' : 'visual_part_unavailable' }); } catch { /* diagnostic only */ }
          // Missing an optional head reaction is a successful no-op for the
          // audio scheduler, not a transport fault. Execution feedback above is
          // separate and must never count this skip as a displayed movement.
          return true;
        }
        const accepted = command.cue.kind === 'gesture' ? motion.enqueue(command.cue) === true : face.enqueue(command.cue) === true;
        try { observe({ type: 'cue_admission', identity, atWall, cue: command.cue, accepted,
          reason: accepted ? 'controller_accepted' : 'controller_rejected' }); } catch { /* diagnostic only */ }
        return accepted;
      }
      case 'stop_audio': {
        // A stale cleanup must never cancel the next transport instance.
        const before = audio.snapshot();
        if (before.epoch !== epoch) return before.status === 'idle' && before.epoch < epoch;
        if (before.status !== 'cancelled' && before.status !== 'ended') audio.cancel();
        const after = audio.snapshot();
        return ['cancelled', 'ended'].includes(after.status) && !after.sourceActive && !(after.sourceCount > 0);
      }
      case 'retract': {
        // Always attempt both layers, even when one callback throws.
        let a = false, b = false;
        try { a = face.epoch === epoch && (onceCancelled(face) || face.cancel(epoch) === true); } catch { /* report false */ }
        try { b = motion.epoch === epoch && (onceCancelled(motion) || motion.cancel(epoch, atWall) === true); } catch { /* report false */ }
        return a && b;
      }
      // MotionController's automatic posture follows playback/cancel. This optional
      // callback is for other renderers; do not pin a manual posture in the studio.
      case 'posture': return face.epoch === epoch && motion.epoch === epoch
        && audio.snapshot().epoch <= epoch && onPosture(command.posture, command) === true;
      case 'provider_done': return true;
      default: return false;
    }
  };
}

/** Parse only a COMPLETE tool payload, bound to trusted connection/response identity.
 * Partial deltas, model-provided owner IDs and arbitrary action names cannot execute.
 * This is a local normalized payload contract, not a Qwen websocket client.
 */
export function enqueueToolCue(scheduler, identity, tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return { accepted: false, reason: 'invalid_tool' };
  const { callId, name, arguments: argumentsText } = tool;
  if (name !== 'avatar_cue' || typeof callId !== 'string' || !callId || callId.length > 120
    || typeof argumentsText !== 'string' || argumentsText.length > 4096) return { accepted: false, reason: 'invalid_tool' };
  let body;
  try { body = JSON.parse(argumentsText); } catch { return { accepted: false, reason: 'incomplete_or_invalid_json' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { accepted: false, reason: 'invalid_arguments' };
  const allowed = new Set(['kind', 'gesture', 'action', 'preset', 'at', 'apexAt', 'strength']);
  if (Object.keys(body).some(key => !allowed.has(key))) return { accepted: false, reason: 'unknown_field' };
  return scheduler.enqueue({ ...body, ...identity, id: `tool:${callId}` });
}
