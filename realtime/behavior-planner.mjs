/** Host-owned, deterministic communication state. No audio, timers, renderer or
 * model dependencies. Subtitles propose intent; only trusted host events may
 * establish thinking, start/end playback, change ownership or cancel a turn. */
const finite = value => typeof value === 'number' && Number.isFinite(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const validOwner = value => value && id(value.connectionId) && id(value.responseId)
  && Number.isSafeInteger(value.epoch) && value.epoch > 0;
const same = (a, b) => a && b && a.connectionId === b.connectionId && a.responseId === b.responseId && a.epoch === b.epoch;
const copyOwner = owner => owner ? { connectionId: owner.connectionId, responseId: owner.responseId, epoch: owner.epoch } : null;
const ACTIVE = new Set(['buffering', 'playing', 'paused']);
const LEVELS = new Set(['none', 'micro', 'authored', 'defer']);
const INTENTS = Object.freeze({
  neutral: [.10, .04, 0], warm: [.30, .03, 0], comfort: [.30, .07, .04],
  greeting: [.64, .03, 0], agreement: [.24, .02, 0], disagreement: [.06, .16, .10],
  explanation: [.12, .12, .04], consideration: [.07, .19, .40], curiosity: [.13, .10, .38],
  affection: [.40, .03, .03], pleased: [.62, .02, 0], surprise: [.16, .23, .28],
  shy: [.25, .10, .20], playful: [.45, .04, .08],
});
const fieldFor = { expression: 'preset', action: 'action', gesture: 'gesture' };
const PART_STATES = new Set(['available', 'occupied', 'exiting']);
const POSE_FIELDS = ['headYaw', 'headPitch', 'gazeYaw', 'gazePitch'];
const clone = value => value == null ? value : structuredClone(value);
const isFree = value => value === true || value === 'available';
const cueParts = cue => cue.kind === 'gesture' ? ['arms', 'torso']
  : cue.action === 'glance' ? ['gaze'] : cue.action === 'blink' ? [] : ['head'];
const partFree = (parts, part) => part === 'arms'
  ? isFree(parts.arms?.L) && isFree(parts.arms?.R) : isFree(parts[part]);

/** Only this bounded semantic shape is accepted across the worker boundary.
 * Worker-supplied state, ownership, clocks and arbitrary bone goals are ignored. */
export function validBehaviorCandidate(behavior) {
  return !!behavior && Object.hasOwn(INTENTS, behavior.intent) && behavior.reaction
    && LEVELS.has(behavior.reaction.level);
}

export class BehaviorPlanner {
  constructor({ clock = () => performance.now() / 1000, lateTolerance = .2,
    maxResultAgeSeconds = 1.2, maxPlans = 128 } = {}) {
    if (typeof clock !== 'function') throw new TypeError('invalid behavior clock');
    if (!finite(lateTolerance) || lateTolerance < 0 || lateTolerance > 2
      || !finite(maxResultAgeSeconds) || maxResultAgeSeconds < 0 || maxResultAgeSeconds > 10
      || !Number.isSafeInteger(maxPlans) || maxPlans < 1 || maxPlans > 4096) throw new RangeError('invalid behavior bounds');
    Object.assign(this, { clock, lateTolerance, maxResultAgeSeconds, maxPlans });
    this.connectionId = null; this.owner = null; this.interactionGeneration = 0; this.highestEpoch = 0;
    this.mediaStatus = 'idle'; this.mediaTime = 0; this.lastWall = -Infinity;
    this.seen = new Set(); this.connections = new Set(); this.sequence = 0; this.lastPlan = null;
    this.intent = 'neutral'; this.state = this._state('listening', 'neutral');
    this.partnerVoicing = false; this.selfVoicing = false;
    this.pose = null; this.parts = null; this.reaction = null;
    this.restTarget = 'low'; this.restRevision = 0; this.attentionReason = 'maintain';
    this.partnerOpportunity = null; this.restRequested = false;
    this.records = new Map(); this.acceptedHistory = []; this.displayedHistory = [];
    this.counts = { accepted: 0, rejected: 0, degraded: 0, events: 0, observations: 0, displayed: 0 };
  }
  _state(mode, intent, previous = null) {
    const [warmth, tension, uncertainty] = INTENTS[intent];
    return { mode, attention: 'partner',
      warmth, tension, uncertainty, hands: 'keep', ...previous, mode };
  }
  _now() {
    let now; try { now = this.clock(); } catch { return null; }
    if (!finite(now) || now < 0 || now < this.lastWall) return null;
    this.lastWall = now; return now;
  }
  _advance() {
    if (this.interactionGeneration >= Number.MAX_SAFE_INTEGER) return false;
    this.interactionGeneration++; this.seen.clear(); this.lastPlan = null;
    // Voice observations belong to their capture generation. Without fresh
    // frames, an old true value must not survive a response/cancellation boundary.
    this.partnerVoicing = false; this.selfVoicing = false;
    this.reaction = null; this.partnerOpportunity = null; this.records.clear(); this.restRequested = false; return true;
  }
  _reject(reason) { this.counts.rejected++; return { accepted: false, reason, cues: [] }; }
  _owned(owner) { return validOwner(owner) && same(owner, this.owner) && owner.connectionId === this.connectionId; }
  setConnection(connectionId) {
    if (!id(connectionId) || this._now() === null) return false;
    if (connectionId === this.connectionId) return true;
    if (this.connections.has(connectionId) || this.connections.size >= 64 || !this._advance()) return false;
    this.connectionId = connectionId; this.connections.add(connectionId); this.owner = null;
    this.mediaStatus = 'idle'; this.mediaTime = 0; this.intent = 'neutral';
    this.partnerVoicing = false; this.selfVoicing = false; this.pose = null; this.parts = null;
    this.restTarget = 'low'; this.restRevision++; this.acceptedHistory = []; this.displayedHistory = [];
    this.state = this._state('listening', 'neutral'); this.counts.events++; return true;
  }
  begin(owner) {
    if (!validOwner(owner) || owner.connectionId !== this.connectionId || owner.epoch <= this.highestEpoch
      || this._now() === null || !this._advance()) return false;
    this.owner = copyOwner(owner); this.highestEpoch = owner.epoch; this.mediaTime = 0; this.mediaStatus = 'buffering';
    // response.created is not evidence of an answer or of actual sound. Preserve
    // a host-established unresolved thinking state rather than ending it by timer.
    if (this.state.mode !== 'thinking') this.state = { ...this.state, mode: 'listening', attention: 'partner' };
    this.counts.events++; return true;
  }
  userSpeechStarted(connectionId, { voiced = true } = {}) {
    if (connectionId !== this.connectionId || !id(connectionId) || typeof voiced !== 'boolean' || this._now() === null || !this._advance()) return false;
    this.owner = null; this.mediaStatus = 'cancelled'; this.mediaTime = 0; this.intent = 'neutral';
    this.partnerVoicing = voiced; this.selfVoicing = false; this.partnerOpportunity = voiced ? this.lastWall : null;
    this.state = this._state('listening', 'neutral'); this.counts.events++; return true;
  }
  userSpeechEnded({ connectionId, interactionGeneration } = {}) {
    if (!id(connectionId) || connectionId !== this.connectionId || interactionGeneration !== this.interactionGeneration
      || this.owner || this._now() === null) return false;
    // "thinking" remains the compatibility lifecycle name for unresolved wait.
    // A pause does not prove uncertainty and must not manufacture a frown/aside.
    this.partnerVoicing = false;
    this.state = { ...this.state, mode: 'thinking', attention: 'partner' };
    this.counts.events++; return true;
  }
  answerAvailable(owner) {
    if (!this._owned(owner) || !ACTIVE.has(this.mediaStatus) || this._now() === null) return false;
    this.state = { ...this.state, mode: 'responding', attention: 'partner' };
    this.counts.events++; return true;
  }
  media({ owner, status, time, sourceActive } = {}) {
    if (!this._owned(owner) || !['buffering', 'playing', 'paused', 'ended', 'cancelled'].includes(status)
      || !finite(time) || time < this.mediaTime || this._now() === null) return false;
    // Once ended, a late playing snapshot must not revive the previous response.
    if (this.mediaStatus === 'ended' && status !== 'ended' && status !== 'cancelled') return false;
    if (status === 'cancelled') return this.cancel(owner);
    this.mediaTime = time; this.mediaStatus = status;
    // Playback state alone may include a silent queue gap. The host can supply
    // sourceActive, or observeInteraction can supply the physical playback fact.
    if (typeof sourceActive === 'boolean') this.selfVoicing = status === 'playing' && sourceActive;
    else if (status !== 'playing') this.selfVoicing = false;
    if (status === 'playing') this.state = { ...this.state, mode: 'responding', attention: 'partner' };
    if (status === 'ended') this.state = { ...this.state, mode: 'settling', attention: 'partner' };
    this.counts.events++; return true;
  }
  cancel(owner) {
    if (!this._owned(owner) || this._now() === null || !this._advance()) return false;
    this.owner = null; this.mediaStatus = 'cancelled'; this.intent = 'neutral';
    this.selfVoicing = false;
    this.state = this._state('listening', 'neutral'); this.counts.events++; return true;
  }
  settled(owner) {
    if (!this._owned(owner) || this.mediaStatus !== 'ended' || this._now() === null) return false;
    this.state = { ...this.state, mode: 'listening', attention: 'partner' };
    this.counts.events++; return true;
  }
  disconnect(connectionId) {
    if (connectionId !== this.connectionId || !id(connectionId) || this._now() === null || !this._advance()) return false;
    this.connectionId = null; this.owner = null; this.mediaStatus = 'disconnected'; this.intent = 'neutral';
    this.partnerVoicing = false; this.selfVoicing = false; this.pose = null; this.parts = null;
    this.state = this._state('listening', 'neutral'); this.counts.events++; return true;
  }
  /** Trusted host observations, never worker/model content. This path has no
   * responseId and no authority to cancel audio. A voice onset is an opportunity
   * to recover displaced attention, not a command to nod or agree. */
  observeInteraction({ connectionId, interactionGeneration, partnerVoicing, selfVoicing,
    pose, interactionPose, parts, execution } = {}) {
    if (!id(connectionId) || connectionId !== this.connectionId || interactionGeneration !== this.interactionGeneration)
      return false;
    if ([partnerVoicing, selfVoicing].some(value => value !== undefined && typeof value !== 'boolean')) return false;
    const observedPose = pose ?? interactionPose;
    if (observedPose != null && (typeof observedPose !== 'object'
      || POSE_FIELDS.some(key => observedPose[key] !== undefined && (!finite(observedPose[key]) || Math.abs(observedPose[key]) > Math.PI))
      || ['handsSettled', 'handPlacementNeeded', 'headBusy', 'armsBusy', 'torsoBusy'].some(key => observedPose[key] !== undefined && typeof observedPose[key] !== 'boolean')
      || (observedPose.handRest !== undefined && !['low', 'ready'].includes(observedPose.handRest)))) return false;
    if (parts != null && (typeof parts !== 'object' || !['gaze', 'head', 'torso'].every(key => PART_STATES.has(parts[key]))
      || !['L', 'R'].every(key => PART_STATES.has(parts.arms?.[key])))) return false;
    const now = this._now(); if (now === null) return false;
    if (partnerVoicing !== undefined) {
      if (partnerVoicing && !this.partnerVoicing) this.partnerOpportunity = now;
      if (!partnerVoicing) this.partnerOpportunity = null;
      this.partnerVoicing = partnerVoicing;
    }
    if (selfVoicing !== undefined) this.selfVoicing = selfVoicing;
    if (observedPose) {
      if (!this.pose && observedPose.handRest) { this.restTarget = observedPose.handRest; this.restRevision++; }
      this.pose = { ...this.pose, ...Object.fromEntries([...POSE_FIELDS, 'handRest', 'handsSettled', 'handPlacementNeeded', 'headBusy', 'armsBusy', 'torsoBusy']
        .filter(key => observedPose[key] !== undefined).map(key => [key, observedPose[key]])) };
    }
    if (parts) this.parts = clone(parts);
    for (const [key, displayed] of [['lastAccepted', false], ['lastDisplayed', true]]) {
      const record = execution?.[key];
      if (record?.id) this.feedback(record.id, { accepted: true, displayed });
    }
    // Opportunities are consumed once, including when an unavailable head means
    // "keep". No queued catch-up nod and no periodic retry while speech continues.
    if (this.partnerOpportunity !== null && this.pose) {
      const timely = now - this.partnerOpportunity <= .75;
      this.partnerOpportunity = null;
      const deviation = Math.abs(this.pose.headYaw ?? 0) + Math.abs(this.pose.headPitch ?? 0);
      const gazeAway = Math.abs(this.pose.gazeYaw ?? 0) + Math.abs(this.pose.gazePitch ?? 0) > .045;
      this.attentionReason = gazeAway || deviation > .055 ? 'partner_onset_refocus' : 'already_attending';
      const headFree = this.parts ? partFree(this.parts, 'head') : this.pose.headBusy !== true;
      const torsoFree = this.parts ? partFree(this.parts, 'torso') : this.pose.torsoBusy !== true;
      const lastDisplayed = this.displayedHistory.at(-1);
      const recentlyRefocused = lastDisplayed?.kind === 'listen-adjust' && now - lastDisplayed.displayedAt < .65;
      // Actual display consumes readiness briefly. Merely proposing or accepting
      // a reaction does not claim the user has seen it and cannot consume this
      // visual-history budget. This is a rejection guard, never a motion timer.
      if (timely && this.partnerVoicing && deviation > .055 && headFree && torsoFree && !recentlyRefocused)
        this._reaction('listen-adjust', 'partner_onset_displaced_attention', now, { strength: Math.min(.34, .16 + deviation) });
    }
    // The executor reports which close rest is compatible with the displayed
    // hand position. A new sentence never forces a reset or a new hand gesture.
    if (this.pose?.handsSettled === true || this.pose?.handPlacementNeeded === false) this.restRequested = false;
    const armsFree = this.parts ? partFree(this.parts, 'arms') : this.pose?.armsBusy === false;
    if (this.pose?.handsSettled === false && this.pose.handPlacementNeeded !== false && armsFree && !this.restRequested) {
      this.restRequested = true;
      this.restTarget = this.pose.handRest ?? this.restTarget; this.restRevision++;
      // Do not overwrite an unconsumed attention reaction; the persistent rest
      // goal is sufficient for simultaneous hand placement in that frame.
      if (!this.reaction || this.records.get(this.reaction.id)?.accepted !== undefined)
        this._reaction('rest', 'displayed_hand_needs_placement', now, { rest: this.restTarget, strength: 1 });
    }
    this.counts.observations++; return true;
  }
  _reaction(kind, reason, now, options = {}) {
    // Full connection identity travels separately. Keep the actuator ID bounded
    // even when the host uses the maximum 128-character connection ID.
    const reactionId = `${this.connectionId.slice(0, 80)}:g${this.interactionGeneration}:b${++this.sequence}`;
    this.reaction = { id: reactionId, kind, reason, now, expiresAt: now + this.lateTolerance, connectionId: this.connectionId,
      interactionGeneration: this.interactionGeneration, ...options };
    this._remember(reactionId, { kind, reason, connectionId: this.connectionId,
      interactionGeneration: this.interactionGeneration, owner: null, proposedAt: now });
  }
  _remember(key, record) {
    this.records.set(key, record);
    while (this.records.size > this.maxPlans) this.records.delete(this.records.keys().next().value);
  }
  /** Called only AFTER sidecar host ownership/sequence/anchor/catalog validation.
   * Identity and clocks are deliberately separate arguments from worker content. */
  planCandidate(decision, { owner, interactionGeneration, anchor, nowAudio, receivedAt, nowWall,
    bodyBusy = false, parts = this.parts, candidateId } = {}) {
    if (!this._owned(owner) || interactionGeneration !== this.interactionGeneration || !ACTIVE.has(this.mediaStatus))
      return this._reject('inactive_or_wrong_generation');
    const localNow = this._now();
    if (localNow === null || ![anchor, nowAudio, receivedAt, nowWall].every(finite) || anchor < 0 || nowAudio < 0
      || receivedAt < 0 || receivedAt > nowWall || nowWall > localNow + .001 || anchor - nowAudio > .5
      || nowAudio - anchor > this.lateTolerance || nowWall - receivedAt > this.maxResultAgeSeconds)
      return this._reject('invalid_or_late_anchor');
    if (!id(candidateId) || this.seen.has(candidateId) || this.seen.size >= this.maxPlans)
      return this._reject('duplicate_or_capacity');
    if (!validBehaviorCandidate(decision?.behavior) || !Array.isArray(decision.cues) || decision.cues.length > 2
      || typeof bodyBusy !== 'boolean') return this._reject('invalid_behavior');
    const { intent, reaction } = decision.behavior;
    let cues = [], level = reaction.level, degraded = null;
    for (const cue of decision.cues) {
      const field = fieldFor[cue?.kind];
      if (!field || !id(cue[field]) || !finite(cue.strength) || cue.strength < 0 || cue.strength > 1)
        return this._reject('invalid_behavior_cue');
      // Persistent attitude owns the facial meaning. Do not independently queue
      // a full-strength preset for the same plan and add it a second time.
      if (cue.kind === 'expression') continue;
      if (level === 'authored' && cue.kind === 'gesture') cues.push({ ...cue });
      else if (level === 'micro' && cue.kind === 'action') cues.push({ ...cue, strength: Math.min(cue.strength, .36) });
      else if (level !== 'none' && level !== 'defer') return this._reject('reaction_cue_mismatch');
    }
    if ((level === 'authored' || level === 'micro') && !cues.length) return this._reject('missing_reaction_cue');
    const legacyBusy = !parts && bodyBusy;
    const stateKept = (legacyBusy && intent !== this.intent)
      || (intent === 'neutral' && !decision.cues.some(cue => cue.kind === 'expression' && cue.preset === 'neutral'));
    if (cues.length && (legacyBusy || (parts && cues.some(cue => cueParts(cue).some(part => !partFree(parts, part)))))) {
      cues = []; level = 'none'; degraded = legacyBusy ? 'body_busy' : 'required_parts_busy'; this.counts.degraded++;
    }
    this.seen.add(candidateId);
    if (level !== 'defer' && !stateKept) {
      this.intent = intent;
      // A subtitle can select attitude, but never invent/finish a thinking phase.
      this.state = this._state(this.state.mode, intent);
    }
    const planId = `${owner.connectionId}:${owner.responseId}:${owner.epoch}:p${++this.sequence}`;
    this.lastPlan = { version: 1, planId, owner: copyOwner(owner), interactionGeneration,
      anchor: { clock: 'audio', at: anchor }, admitUntil: anchor + this.lateTolerance,
      intent, state: { ...this.state }, reaction: { level }, degraded, stateKept };
    this._remember(planId, { kind: cues[0]?.gesture ?? cues[0]?.action ?? level, reason: 'subtitle',
      connectionId: this.connectionId, interactionGeneration, owner: copyOwner(owner), proposedAt: localNow });
    this.counts.accepted++;
    return { accepted: true, reason: degraded ?? (stateKept ? (bodyBusy ? 'body_busy_keep_attitude' : 'quiet_preserve_attitude') : level), cues,
      plan: structuredClone(this.lastPlan) };
  }
  feedback(planId, { accepted, displayed = false, reason } = {}) {
    const record = this.records.get(planId);
    if (!record || typeof accepted !== 'boolean' || typeof displayed !== 'boolean' || (displayed && !accepted)
      || record.connectionId !== this.connectionId || record.interactionGeneration !== this.interactionGeneration) return false;
    // A previously refused proposal cannot become executed due to a late event.
    if (record.accepted === false && accepted) return false;
    const now = this._now(); if (now === null) return false;
    if (accepted && record.accepted !== true) {
      record.accepted = true; record.acceptedAt = now;
      this.acceptedHistory.push({ id: planId, ...clone(record) });
      if (this.acceptedHistory.length > 32) this.acceptedHistory.shift();
    } else if (!accepted) record.accepted = false;
    if (displayed && !record.displayed) {
      record.displayed = true; record.displayedAt = now;
      this.displayedHistory.push({ id: planId, ...clone(record) }); this.counts.displayed++;
      if (this.displayedHistory.length > 32) this.displayedHistory.shift();
    }
    if (!accepted && this.lastPlan?.planId === planId) {
      this.lastPlan.reaction = { level: 'none' }; this.lastPlan.degraded = String(reason || 'scheduler_rejected').slice(0, 80);
      this.counts.degraded++;
    }
    return true;
  }
  snapshot() {
    const { mode, attention } = this.state;
    const aside = attention === 'aside';
    // Stable small attention/support targets, not a cyclic sway or random jitter.
    // They enter the existing composition and do not own arms or final bones.
    const body = { gazeYaw: aside ? -.075 : 0, gazePitch: aside ? .025 : 0,
      headYaw: aside ? -.030 : 0, headPitch: aside ? .012 : .005,
      headRoll: this.intent === 'comfort' ? -.010 : 0,
      lean: this.intent === 'comfort' ? .030 : .014,
      twist: 0, side: 0, neckForward: 0, rest: this.restTarget, restRevision: this.restRevision };
    return { connectionId: this.connectionId, owner: copyOwner(this.owner), interactionGeneration: this.interactionGeneration,
      mediaStatus: this.mediaStatus, mediaTime: this.mediaTime, mode, intent: this.intent,
      state: { ...this.state }, body, partnerVoicing: this.partnerVoicing, selfVoicing: this.selfVoicing,
      pose: clone(this.pose), parts: clone(this.parts), reaction: clone(this.reaction),
      continuity: { attentionTarget: this.state.attention, attentionReason: this.attentionReason,
        restTarget: this.restTarget, restRevision: this.restRevision, policy: 'interaction_facts',
        lastDisplayedReaction: clone(this.displayedHistory.at(-1) ?? null) },
      acceptedHistory: clone(this.acceptedHistory), displayedHistory: clone(this.displayedHistory),
      counts: { ...this.counts }, lastPlan: this.lastPlan ? structuredClone(this.lastPlan) : null };
  }
}
