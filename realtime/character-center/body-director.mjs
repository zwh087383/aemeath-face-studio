import { CHARACTER_ACTIONS, CHARACTER_CATALOG, validateCharacterCommands } from './catalog.mjs';

const copy = value => value == null ? value : structuredClone(value);
export function bodyOwnerKey(owner) {
  if (!owner || typeof owner !== 'object') return null;
  if (typeof owner.sourceKey === 'string' && owner.sourceKey) return owner.sourceKey;
  const id = owner.activityId || owner.turnId;
  return typeof owner.sourceScope === 'string' && typeof id === 'string' && id
    ? `${owner.sourceScope}:${id}` : null;
}
const ownerVersion = owner => Number.isSafeInteger(owner?.sourceVersion) && owner.sourceVersion >= 0;
const sameSource = (a, b) => bodyOwnerKey(a) === bodyOwnerKey(b) && a?.sourceVersion === b?.sourceVersion;
const executionRow = row => row == null ? null : copy(Object.fromEntries(Object.entries(row)
  .filter(([key]) => !['nativeEvidence', 'realizedPerformance', 'preparedNative'].includes(key))));
const held = state => Object.entries(state?.props ?? {}).filter(([, value]) =>
  value?.visible !== false && ['left', 'right', 'both'].includes(value?.attachment));

/** A support-preserving variant is available only inside the model's explicit
 * permission. Default commands keep their original executor and requirements. */
export function resolveBodyDefinition(definition, row) {
  if (!row?.performance?.variant_set?.includes('support-preserving')) return definition;
  const variant = definition.variants?.['support-preserving'];
  if (!variant || variant.executor !== 'activity-overlay') return definition;
  return { ...definition, executor: 'supported', supportedKind: variant.kind,
    selectedVariant: 'support-preserving',
    // The reviewed variant has its own complete support/hand requirements. In
    // particular, standing-only and both-hands-free must not leak from default.
    requires: copy(variant.requires), effects: { ...definition.effects, ...variant.effects } };
}

/** MMD helper metadata describes original PMX bones; native skirt skinning adds
 * virtual palette entries with no PMX grant/morph records. Keep that temporary
 * helper view local and synchronous, restoring the full GPU palette on failure. */
export function withAuthoredSkeleton(mesh, callback) {
  const skeleton = mesh.skeleton, all = skeleton.bones;
  const authored = all.filter(bone => !bone.userData?.nativeClothVirtual);
  const metadata = mesh.geometry?.userData?.MMD?.bones;
  if (!metadata || metadata.length !== authored.length) throw Error('pmx_bone_metadata_mismatch');
  skeleton.bones = authored;
  try { return callback(); } finally { skeleton.bones = all; }
}

/** A dormant conversation player must rejoin the shared clock before enqueue's
 * existing 60-second lookahead validation. No PMX pose is written here. */
export function syncIdleMotionClock(motion, now, input) {
  motion.update(now, 0, input);
}

/** Facts are supplied by the current executor AFTER its actual pose is rendered.
 * This check never manufactures a chair, a book or an acquisition receipt. */
export function bodyAdmission(definition, state) {
  if (!state) return 'body_state_unavailable';
  if (definition.channel === 'face') return null;
  const need = definition.requires ?? {};
  if (need.support && need.support !== 'any' && !(Array.isArray(need.support) ? need.support.includes(state.support) : state.support === need.support)) return `requires_${need.support}`;
  if (need.hands === 'free' && (state.hands !== 'free' || held(state).length)) return 'hands_occupied';
  const busyHands = new Set(held(state).flatMap(([, p]) => p.attachment === 'both' ? ['L', 'R'] : [p.attachment === 'left' ? 'L' : 'R']));
  for (const hand of need.freeHands ?? []) if (busyHands.has(hand)) return `requires_free_hand_${hand}`;
  const supports = Array.isArray(need.support) ? need.support : [need.support];
  if (supports.includes('standing') && state.support === 'standing' && state.contacts?.L !== true && state.contacts?.R !== true)
    return 'standing_support_unconfirmed';
  if (supports.includes('seated') && state.support === 'seated' && state.seatSupported !== true) return 'seat_support_unconfirmed';
  for (const capability of need.capabilities ?? []) if (!state.capabilities?.includes(capability)) return `requires_capability_${capability}`;
  for (const id of need.props ?? []) {
    if (state.props?.[id]?.visible !== true) return `missing_${id}`;
  }
  if (need.held && !held(state).some(([id]) => id === need.held)) return `must_hold_${need.held}`;
  if (need.existingSource && state.props?.[need.existingSource]?.attachment !== 'table')
    return `missing_table_source_${need.existingSource}`;
  return null;
}

/** Model-owned queue. The executor is a mechanical adapter, not an action picker.
 * There is no per-turn action ceiling, semantic keyword fallback or cooldown.
 * One body executor retains support while a separate pure-face lane can blink. */
export class CharacterBodyDirector {
  constructor({ executors, initialExecutor = 'conversation', getActorState,
    isOwnerCurrent = () => true, onEvent = () => {}, preparationTimeoutMs = 30000,
    wallClock = () => performance.now() } = {}) {
    if (!executors?.[initialExecutor] || typeof getActorState !== 'function') throw Error('body_adapters_required');
    if (!Number.isFinite(preparationTimeoutMs) || preparationTimeoutMs <= 0 || typeof wallClock !== 'function') throw Error('invalid_preparation_deadline');
    this.preparationTimeoutMs = preparationTimeoutMs; this.wallClock = wallClock;
    this.executors = executors; this.executor = initialExecutor; this.getActorState = getActorState;
    this.isOwnerCurrent = isOwnerCurrent; this.onEvent = onEvent;
    this.pending = []; this.active = null; this.faceActive = []; this.controlActive = null; this.suspended = null;
    this.rows = []; this.events = []; this.serial = 0; this.now = 0; this.paused = false;
    this.cancelled = new Set(); this.seen = new Set(); this.media = {};
    this.attentionLease = null; this.mechanicalOwners = new Map(); this.attentionSerial = 0;
  }

  record(type, row = null, detail = {}) {
    const event = { type, at: this.now, atMs: this.now * 1000, ...(row ? {
      id: row.id, action: row.action, index: row.index, owner: copy(row.receiptOwner ?? row.owner),
      sourceKey: bodyOwnerKey(row.receiptOwner ?? row.owner),
      ...(row.receiptOwner ? { executionOwner: copy(row.owner) } : {}) } : {}), ...detail };
    this.events.push(event); if (this.events.length > 500) this.events.shift();
    try { this.onEvent(copy(event)); } catch { /* Diagnostics cannot break the render loop. */ }
    return event;
  }

  current(owner) {
    if (!bodyOwnerKey(owner) || !ownerVersion(owner)) return false;
    if (this.cancelled.has(`${bodyOwnerKey(owner)}@${owner.sourceVersion}`)) return false;
    if (owner.sourceScope === 'mechanical') return this.mechanicalOwners.get(bodyOwnerKey(owner)) === owner.sourceVersion;
    return this.isOwnerCurrent(owner) === true;
  }

  rowCurrent(row) {
    if (this.current(row.owner)) return true;
    // Only this already-running physical row may settle into its measured
    // attention pause. Retiring the old turn still rejects new commands.
    if (this.attentionLease?.rowId !== row.id) return false;
    const token = this.getActorState()?.activityToken;
    return token === this.attentionLease.token || token === null && this.active === row
      && this.executor === 'activity' && this.executors.activity.status(row)?.done === true;
  }

  retireQueued(predicate, reason) {
    this.pending = this.pending.filter(row => {
      if (!predicate(row)) return true;
      row.status = 'cancelled'; row.reason = reason; this.record('action_cancelled', row, { reason }); return false;
    });
  }

  /** Actual user attention is a local mechanical event, not a model-selected
   * behavior or a semantic claim about the user's words. Never resumes work. */
  pauseForAttention({ turnId = null, reason = 'user_speech_started' } = {}) {
    this.retireQueued(row => row.owner.sourceScope === 'activity' || turnId && row.owner.turnId === turnId, 'user_attention');
    const actor = this.getActorState(), token = actor?.activityToken;
    const activity = this.suspended?.token === token ? this.suspended.row
      : this.executor === 'activity' ? this.active : null;
    if (!activity || typeof token !== 'string' || !token) return { accepted: false, reason: 'no_live_activity' };
    this.attentionLease = { token, rowId: activity.id, owner: copy(activity.owner) };
    if (this.suspended?.token === token) return { accepted: true, alreadyPaused: true, activityToken: token, modelChosen: false };
    if ([this.controlActive, ...this.pending].some(row => row?.owner?.sourceScope === 'mechanical'
      && row.action === 'control:pause_activity' && row.activity_token === token))
      return { accepted: true, alreadyPending: true, activityToken: token, modelChosen: false };
    const sequence = ++this.attentionSerial, sourceKey = `mechanical:user-attention:${sequence}`;
    const owner = { sourceKey, sourceScope: 'mechanical', sourceVersion: sequence,
      requestId: `local-attention-${sequence}`, modelChosen: false, trigger: reason };
    this.mechanicalOwners.set(sourceKey, sequence);
    const result = this.submit({ operation: 'append', actions: [{ action: 'control:pause_activity',
      anchor: 'immediate', activity_token: token }] }, owner);
    this.record('local_attention_control', null, { activityToken: token, owner: copy(owner),
      modelChosen: false, semanticUnderstanding: false, reason, accepted: result.accepted });
    return { ...result, activityToken: token, modelChosen: false };
  }

  submit(command, owner) {
    let parsed;
    try { parsed = validateCharacterCommands(command); } catch (error) { return { accepted: false, reason: error.message }; }
    if (!this.current(owner)) return { accepted: false, reason: 'stale_or_invalid_source' };
    if (owner.catalogHash && owner.catalogHash !== CHARACTER_CATALOG.hash) return { accepted: false, reason: 'catalog_version_mismatch' };
    const requestKey = owner.requestId ? `${bodyOwnerKey(owner)}@${owner.sourceVersion}:${owner.requestId}` : null;
    if (requestKey && this.seen.has(requestKey)) return { accepted: false, reason: 'duplicate_request' };
    if (requestKey) this.seen.add(requestKey);
    if(parsed.operation==='keep')return {accepted:true,count:0,kept:true};
    if (parsed.operation !== 'append') this.clearSource(owner, parsed.operation === 'clear' ? 'model_clear' : 'model_replace');
    for (const [index,action] of parsed.actions.entries()) {
      const row = { ...action, id: `character-action-${++this.serial}`, owner: copy(owner),
        index, goal:parsed.goal, acceptedAt: this.now, due: this.now + action.delay_ms / 1000, status: 'queued',
        voiceAlreadyPlaying: this.matchesMedia({owner},this.media)&&this.media.audioStatus==='playing' };
      this.pending.push(row); this.rows.push(row); this.record('action_queued', row);
    }
    return { accepted: true, count: parsed.actions.length };
  }

  clearSource(owner, reason, { preserveAttention = false } = {}) {
    // A resumed task changes its mechanical execution owner, not the provenance
    // of the task. Explicit revocation of that original source still retires it.
    const matches = row => sameSource(row.owner, owner) || row.receiptOwner && sameSource(row.receiptOwner, owner);
    const preserved = row => preserveAttention && this.attentionLease?.rowId === row.id
      && this.getActorState()?.activityToken === this.attentionLease.token;
    if (!preserveAttention && this.attentionLease && (sameSource(this.attentionLease.owner, owner)
      || [this.active, this.suspended?.row].some(row => row?.id === this.attentionLease.rowId && matches(row)))) this.attentionLease = null;
    this.pending = this.pending.filter(row => {
      if (!matches(row)) return true;
      row.status = 'cancelled'; row.reason = reason; this.record('action_cancelled', row, { reason }); return false;
    });
    if (this.active && matches(this.active) && !preserved(this.active)) {
      const row = this.active; row.status = 'cancelled'; row.reason = reason;
      this.executors[this.executor].cancel?.(row, reason); this.record('action_cancelled', row, { reason }); this.active = null;
    }
    this.faceActive = this.faceActive.filter(row => {
      if (!matches(row)) return true;
      this.executors.face?.cancel?.(row, reason); row.status = 'cancelled'; this.record('action_cancelled', row, { reason }); return false;
    });
    if (this.controlActive && matches(this.controlActive)) {
      const row = this.controlActive; this.executors.control?.cancel?.(row, reason);
      row.status = 'cancelled'; row.reason = reason; this.record('action_cancelled', row, { reason, executor: 'control' });
      this.controlActive = null;
    }
    if (this.suspended && matches(this.suspended.row) && !preserved(this.suspended.row)) {
      const row = this.suspended.row; this.executors.activity?.cancel?.(row, reason);
      row.status = 'cancelled'; row.reason = reason; this.record('action_cancelled', row, { reason, suspended: true });
      this.suspended = null;
    }
  }

  cancel(owner = null, reason = 'barge_in', { preserveAttention = false } = {}) {
    if (!owner) { preserveAttention = false; this.attentionLease = null; }
    const owners = owner ? [owner] : [...this.pending, ...(this.active ? [this.active] : []), ...this.faceActive,
      ...(this.controlActive ? [this.controlActive] : []), ...(this.suspended ? [this.suspended.row] : [])].map(row => row.owner);
    const keys = new Set();
    for (const item of owners) {
      if (!bodyOwnerKey(item) || !ownerVersion(item)) continue;
      const key = `${bodyOwnerKey(item)}@${item.sourceVersion}`;
      if (keys.has(key)) continue; keys.add(key); this.cancelled.add(key); this.clearSource(item, reason, { preserveAttention });
    }
    return { cancelledSources: keys.size };
  }

  /** Explicit source revocation covers every retained physical version. A new
   * keep/face decision can change the semantic version while an older task is
   * suspended; it must not hide that task from its provenance revocation. */
  cancelSourceKey(sourceKey, reason = 'source_revoked') {
    const rows = [...this.pending, ...(this.active ? [this.active] : []), ...this.faceActive,
      ...(this.controlActive ? [this.controlActive] : []), ...(this.suspended ? [this.suspended.row] : [])];
    const owners = rows.flatMap(row => [row.owner, row.receiptOwner]).filter(owner => bodyOwnerKey(owner) === sourceKey);
    if (bodyOwnerKey(this.attentionLease?.owner) === sourceKey) owners.push(this.attentionLease.owner);
    const versions = new Map(owners.map(owner => [owner.sourceVersion, owner]));
    for (const owner of versions.values()) this.cancel(owner, reason);
    return { cancelledSources: versions.size };
  }

  pause(value = true) { this.paused = Boolean(value); return this.paused; }
  setMedia(media = {}) { this.media = { ...media }; }

  matchesMedia(row, media) {
    // A real voice belongs to a delivered turn, not to the action planner's
    // independent source revision or to a fabricated activity response id.
    if (!row.owner.turnId || !media.mediaOwner) return false;
    return typeof media.mediaOwner.turnId === 'string'
      ? media.mediaOwner.turnId === row.owner.turnId : sameSource(media.mediaOwner, row.owner);
  }

  anchorReady(row, media) {
    if (row.anchor === 'immediate' || row.anchor === 'prepare') return true;
    if (!this.matchesMedia(row, media)) return false;
    if (row.anchor === 'segment_end') return media.segmentEnded === true;
    return media.audioStatus === 'playing' && Number.isFinite(media.audioTime) && media.audioTime >= 0;
  }

  blockDependents(row, reason) {
    if(typeof row.owner.requestId!=='string')return; // legacy recordings lack command identity
    this.pending=this.pending.filter(next=>{
      if(!sameSource(next.owner,row.owner)||next.owner.requestId!==row.owner.requestId||next.index<=row.index)return true;
      next.status='cancelled';next.reason='dependency_'+reason;
      this.record('action_cancelled',next,{reason:next.reason});return false;
    });
  }

  hasEarlierPending(row) {
    if (typeof row.owner.requestId !== 'string') return false;
    return this.pending.some(other => other !== row && sameSource(other.owner, row.owner)
      && other.owner.requestId === row.owner.requestId && other.index < row.index
      && CHARACTER_ACTIONS[other.action].channel !== 'face');
  }

  controlRequirement(row, definition, state) {
    const token = row.activity_token;
    if (typeof token !== 'string' || !token || state?.activityToken !== token) return 'activity_token_mismatch';
    if (definition.name === 'pause_activity') {
      if (this.suspended?.token === token) return null;
      if (!this.active || this.executor !== 'activity') return 'no_active_activity';
    } else if (definition.name === 'resume_activity') {
      if (!this.suspended || this.suspended.token !== token) return 'no_suspended_activity';
      if (state.resumeToken !== token) return 'activity_not_stably_paused';
    } else if (definition.name === 'finish_activity') {
      if (!(this.suspended?.token === token || this.active && this.executor === 'activity')) return 'no_active_activity';
    } else return 'unsupported_activity_control';
    return null;
  }

  finishControl(row) {
    const definition = CHARACTER_ACTIONS[row.action], token = row.activity_token;
    if (definition.name === 'pause_activity' && this.active && this.executor === 'activity') {
      const activity = this.active; activity.status = 'suspended';
      this.suspended = { token, row: activity, pausedAt: this.now };
      this.active = null;
      this.record('action_suspended', activity, { activityToken: token, byControl: row.id });
    } else if (['resume_activity', 'finish_activity'].includes(definition.name) && this.suspended?.token === token) {
      const activity = this.suspended.row;
      activity.receiptOwner ??= copy(activity.owner);
      activity.owner = copy(row.owner); activity.status = 'playing'; activity.resumedAt = this.now;
      this.active = activity; this.executor = 'activity'; this.suspended = null;
      if (this.attentionLease?.rowId === activity.id) this.attentionLease = null;
      this.record('action_resumed', activity, { activityToken: token, byControl: row.id,
        finishing: definition.name === 'finish_activity', replayed: false });
    }
  }

  updateControls() {
    const adapter = this.executors.control;
    if (this.controlActive) {
      const row = this.controlActive, state = adapter?.status?.(row) ?? { done: true, failed: true, reason: 'control_status_unavailable' };
      const actor = this.getActorState();
      const finishedHere = CHARACTER_ACTIONS[row.action].name === 'finish_activity' && actor?.activityToken === null;
      const mismatch = !finishedHere && actor?.activityToken !== row.activity_token;
      if (state.started && row.displayedAt == null) {
        row.displayedAt = this.now; row.status = 'playing'; this.record('action_started', row, { executor: 'control' });
      }
      if (state.done || mismatch) {
        // A token may be invalidated while an asynchronous pause is settling.
        const failed = state.failed || mismatch;
        if (!failed) this.finishControl(row);
        row.status = failed ? 'failed' : 'completed'; row.reason = state.reason ?? (mismatch ? 'activity_token_changed' : null);
        row.completedAt = this.now;
        this.record(`action_${row.status}`, row, { executor: 'control', reason: row.reason, actualState: copy(actor) });
        this.controlActive = null;
        if (failed) this.blockDependents(row, 'control_failed');
      }
    }
    if (this.controlActive) return;
    const index = this.pending.findIndex(row => CHARACTER_ACTIONS[row.action].channel === 'control' && !this.hasEarlierPending(row));
    if (index < 0) return;
    const row = this.pending[index], definition = CHARACTER_ACTIONS[row.action];
    if (this.now < row.due || !this.anchorReady(row, this.media)) return;
    if (['resume_activity', 'finish_activity'].includes(definition.name) && this.active && this.executor !== 'activity') return;
    const actor = this.getActorState();
    let reason = this.controlRequirement(row, definition, actor);
    if (!reason) {
      const check = adapter?.check?.(definition, actor, row);
      if (check === 'busy' || check?.wait === true) return;
      reason = typeof check === 'string' ? check : check?.reason ?? null;
    }
    this.pending.splice(index, 1);
    if (reason || !adapter) {
      row.status = 'rejected'; row.reason = reason ?? 'control_executor_unavailable';
      this.record('action_rejected', row, { executor: 'control', reason: row.reason });
      this.blockDependents(row, 'control_rejected'); return;
    }
    let accepted = false;
    try { accepted = adapter.start(definition, row, actor) === true; }
    catch (error) { row.reason = `control_error:${error.message}`; }
    row.status = accepted ? 'admitted' : 'rejected'; row.admittedAt = this.now;
    if (accepted) this.controlActive = row;
    else row.reason ??= 'control_executor_refused';
    this.record(accepted ? 'action_admitted' : 'action_rejected', row, { executor: 'control', reason: row.reason });
    if (!accepted) this.blockDependents(row, 'control_rejected');
  }

  update(now, dt, media = this.media) {
    if (!Number.isFinite(now) || !Number.isFinite(dt) || dt < 0) throw Error('invalid_body_clock');
    this.now = now; this.media = media;
    // Only preparation is bounded in real time. A legitimate long activity or
    // paused pose has no total-duration limit. Retire before any late callback
    // can grant the failed command ownership; unrelated requests remain queued.
    for (const row of [...this.pending]) {
      const start = row.preparation === 'loading' ? row.prepareWallMs : row.checkWaitWallMs;
      if (!Number.isFinite(start) || this.wallClock() - start < this.preparationTimeoutMs) continue;
      if (!this.pending.includes(row)) continue;
      this.pending.splice(this.pending.indexOf(row), 1);
      row.status = 'rejected'; row.reason = row.preparation === 'loading' ? 'resource_preparation_timeout' : 'scene_preparation_timeout';
      row.preparation = 'failed'; row.prepareError = row.reason;
      this.record('action_rejected', row, { reason: row.reason }); this.blockDependents(row, 'preparation_timeout');
    }
    if (this.paused || media.paused) {
      for (const row of this.pending) row.due += dt;
      return this.snapshot({ diagnostics: false });
    }
    for (const row of [...this.pending, ...(this.active ? [this.active] : []), ...this.faceActive,
      ...(this.controlActive ? [this.controlActive] : [])]) {
      if (!this.rowCurrent(row)) this.clearSource(row.owner, 'source_retired');
    }
    // Playback-end is terminal evidence for a queued voice onset. In particular,
    // an assistant segment-end semantic gate may release its command after the
    // audio has finished. Do not replay that missed gesture or leave it blocking
    // a later activity. Already moving bodies retain their mechanical exit.
    if (['ended','playing'].includes(media.audioStatus) && Number.isFinite(media.audioTime) && media.audioTime >= 0) {
      const expired=[];
      this.pending = this.pending.filter(row => {
        if (row.anchor !== 'voice' || !this.matchesMedia(row, media)) return true;
        const lateAtArrival=row.voiceAlreadyPlaying&&(row.late??'start_if_speaking')!=='start_if_speaking';
        if(media.audioStatus!=='ended'&&!lateAtArrival)return true;
        row.status = 'expired'; row.reason = 'voice_anchor_missed'; row.expiredAt = now;
        this.record('action_expired', row, { reason: row.reason, audioTime: media.audioTime });
        expired.push(row);
        return false;
      });
      for(const row of expired)this.blockDependents(row,'expired');
    }
    // Control commands do not wait behind the activity that they must pause.
    // They change its state, never acquire body bones or fabricate completion.
    this.updateControls();
    if (this.active) {
      const row = this.active, state = this.executors[this.executor].status(row);
      if (state.started && row.displayedAt == null) {
        row.displayedAt = now; row.status = 'playing'; this.record('action_started', row, { executor: this.executor });
      }
      if (state.done) {
        row.status = state.failed ? 'failed' : 'completed'; row.reason = state.reason ?? null; row.completedAt = now;
        this.record(`action_${row.status}`, row, { reason: row.reason, executor: this.executor, actualState: copy(this.getActorState()), actualDuration: now - row.admittedAt, performance: copy(row.realizedPerformance) }); this.active = null;
        if (this.attentionLease?.rowId === row.id) this.attentionLease = null;
        if(state.failed)this.blockDependents(row,'failed');
      }
    }
    this.faceActive = this.faceActive.filter(row => {
      const state = this.executors.face.status(row);
      if (state.started && row.displayedAt == null) { row.displayedAt = now; this.record('action_started', row, { executor: 'face' }); }
      if (!state.done) return true;
      row.status = state.failed ? 'failed' : 'completed';
      this.record(`action_${row.status}`, row, { executor: 'face', reason:state.reason??null });
      if(state.failed)this.blockDependents(row,'face_failed');return false;
    });

    // A pure blink can coexist with a body gesture, including native/activity.
    // Meaningful head motions still use the checked shared-bone body lane.
    for (let index = 0; index < this.pending.length;) {
      const row = this.pending[index], def = CHARACTER_ACTIONS[row.action];
      if (def.channel !== 'face') { index++; continue; }
      if (now < row.due || !this.anchorReady(row, media)) { index++; continue; }
      this.pending.splice(index, 1);
      const ok = this.executors.face?.start(def, row, this.getActorState()) === true;
      row.status = ok ? 'admitted' : 'rejected'; this.record(ok ? 'action_admitted' : 'action_rejected', row, { executor: 'face' });
      if (ok) this.faceActive.push(row);
      else this.blockDependents(row,'face_rejected');
    }
    // Decode the next resource while the old body keeps its physical lease.
    const candidate = this.pending.find(row => !['face', 'control'].includes(CHARACTER_ACTIONS[row.action].channel));
    if (candidate && !candidate.preparation) {
      const def = resolveBodyDefinition(CHARACTER_ACTIONS[candidate.action], candidate), adapter = this.executors[def.executor];
      if (adapter?.prepare) {
        candidate.preparation = 'loading'; candidate.prepareAt = now; candidate.prepareWallMs = this.wallClock();
        Promise.resolve().then(() => adapter.prepare(def, candidate)).then(() => {
          // Readiness alone cannot revive a cancelled row or start a pose.
          if (!this.pending.includes(candidate) || candidate.status !== 'queued' || !this.current(candidate.owner)) return;
          if (this.wallClock() - candidate.prepareWallMs >= this.preparationTimeoutMs) {
            candidate.preparation = 'failed'; candidate.prepareError = 'resource_preparation_timeout'; return;
          }
          candidate.preparation = 'ready';
        }, error => {
          if (!this.pending.includes(candidate) || candidate.status !== 'queued') return;
          candidate.preparation = 'failed'; candidate.prepareError = String(error?.message ?? error);
        });
      }
    }
    if (this.active || this.controlActive || !this.executors[this.executor].canYield()) return this.snapshot({ diagnostics: false });
    const index = this.pending.findIndex(row => !['face', 'control'].includes(CHARACTER_ACTIONS[row.action].channel));
    if (index < 0) return this.snapshot({ diagnostics: false });
    const row = this.pending[index], def = resolveBodyDefinition(CHARACTER_ACTIONS[row.action], row);
    if (this.hasEarlierPending(row) || now < row.due || !this.anchorReady(row, media)) return this.snapshot({ diagnostics: false });
    if (row.preparation === 'loading') return this.snapshot({ diagnostics: false });
    const actor = this.getActorState();
    let reason = (this.suspended && def.executor !== 'supported' ? 'activity_suspended_requires_explicit_control' : null)
      ?? (row.preparation === 'failed' ? 'resource_preparation_failed:' + row.prepareError : null)
      ?? bodyAdmission(def, actor);
    if (!reason) {
      const check = this.executors[def.executor]?.check?.(def, actor, row);
      if (check === 'busy' || check?.wait === true) {
        row.checkWaitWallMs ??= this.wallClock();
        return this.snapshot({ diagnostics: false });
      }
      delete row.checkWaitWallMs;
      reason = typeof check === 'string' ? check : check?.reason ?? null;
    }
    if (reason || !this.executors[def.executor]) {
      this.pending.splice(index, 1); row.status = 'rejected'; row.reason = reason ?? 'executor_unavailable';
      this.record('action_rejected', row, { reason: row.reason }); this.blockDependents(row,'rejected');return this.snapshot({ diagnostics: false });
    }
    // start is synchronous and transactional: a refusal cannot steal ownership.
    const oldExecutor = this.executor;
    let accepted = false;
    try { accepted = this.executors[def.executor].start(def, row, actor, oldExecutor) === true; }
    catch (error) { row.reason = `executor_error:${error.message}`; }
    this.pending.splice(index, 1);
    if (!accepted) { row.status = 'rejected'; row.reason ??= 'executor_refused';
      this.record('action_rejected', row, { reason: row.reason }); this.blockDependents(row,'rejected');return this.snapshot({ diagnostics: false }); }
    this.executor = def.executor; this.active = row; row.status = 'admitted'; row.admittedAt = now;
    row.selectedVariant = def.selectedVariant ?? 'exact'; row.executionExecutor = def.executor;
    this.record('body_handover', row, { from: oldExecutor, to: this.executor,
      support: actor.support, held: held(actor).map(([id]) => id) });
    this.record('action_admitted', row, { executor: this.executor });
    return this.snapshot({ diagnostics: false });
  }

  snapshot({ diagnostics = true } = {}) {
    if (!diagnostics) return { now: this.now, paused: this.paused, executor: this.executor,
      active: executionRow(this.active), pending: this.pending.map(executionRow), faceActive: this.faceActive.map(executionRow),
      controlActive: executionRow(this.controlActive), suspended: this.suspended ? {
        token: this.suspended.token, row: executionRow(this.suspended.row), pausedAt: this.suspended.pausedAt } : null,
      attentionLease: copy(this.attentionLease) };
    return { now: this.now, paused: this.paused, executor: this.executor, active: copy(this.active),
      pending: copy(this.pending), faceActive: copy(this.faceActive), controlActive: copy(this.controlActive),
      suspended: copy(this.suspended), attentionLease: copy(this.attentionLease), actorState: copy(this.getActorState()),
      rows: copy(this.rows.slice(-250)), events: copy(this.events.slice(-100)),
      policy: 'model chooses; no per-turn action limit; real support and held props govern admission' };
  }
}

export { CharacterBodyDirector as BodyDirector };
