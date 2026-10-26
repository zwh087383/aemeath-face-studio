import { CHARACTER_ACTIONS, validateCharacterCommands } from './catalog.mjs';

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
const held = state => Object.entries(state?.props ?? {}).filter(([, value]) =>
  value?.visible !== false && ['left', 'right', 'both'].includes(value?.attachment));

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
  if (need.support && state.support !== need.support) return `requires_${need.support}`;
  if (need.hands === 'free' && (state.hands !== 'free' || held(state).length)) return 'hands_occupied';
  if (need.support === 'standing' && state.contacts?.L !== true && state.contacts?.R !== true)
    return 'standing_support_unconfirmed';
  if (need.support === 'seated' && state.seatSupported !== true) return 'seat_support_unconfirmed';
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
    isOwnerCurrent = () => true, onEvent = () => {} } = {}) {
    if (!executors?.[initialExecutor] || typeof getActorState !== 'function') throw Error('body_adapters_required');
    this.executors = executors; this.executor = initialExecutor; this.getActorState = getActorState;
    this.isOwnerCurrent = isOwnerCurrent; this.onEvent = onEvent;
    this.pending = []; this.active = null; this.faceActive = [];
    this.rows = []; this.events = []; this.serial = 0; this.now = 0; this.paused = false;
    this.cancelled = new Set(); this.seen = new Set(); this.media = {};
  }

  record(type, row = null, detail = {}) {
    const event = { type, at: this.now, atMs: this.now * 1000, ...(row ? {
      id: row.id, action: row.action, owner: copy(row.owner), sourceKey: bodyOwnerKey(row.owner) } : {}), ...detail };
    this.events.push(event); if (this.events.length > 500) this.events.shift();
    try { this.onEvent(copy(event)); } catch { /* Diagnostics cannot break the render loop. */ }
    return event;
  }

  current(owner) {
    if (!bodyOwnerKey(owner) || !ownerVersion(owner)) return false;
    if (this.cancelled.has(`${bodyOwnerKey(owner)}@${owner.sourceVersion}`)) return false;
    return this.isOwnerCurrent(owner) === true;
  }

  submit(command, owner) {
    let parsed;
    try { parsed = validateCharacterCommands(command); } catch (error) { return { accepted: false, reason: error.message }; }
    if (!this.current(owner)) return { accepted: false, reason: 'stale_or_invalid_source' };
    const requestKey = owner.requestId ? `${bodyOwnerKey(owner)}@${owner.sourceVersion}:${owner.requestId}` : null;
    if (requestKey && this.seen.has(requestKey)) return { accepted: false, reason: 'duplicate_request' };
    if (requestKey) this.seen.add(requestKey);
    if (parsed.operation !== 'append') this.clearSource(owner, parsed.operation === 'clear' ? 'model_clear' : 'model_replace');
    for (const action of parsed.actions) {
      const row = { ...action, id: `character-action-${++this.serial}`, owner: copy(owner),
        acceptedAt: this.now, due: this.now + action.delay_ms / 1000, status: 'queued' };
      this.pending.push(row); this.rows.push(row); this.record('action_queued', row);
    }
    return { accepted: true, count: parsed.actions.length };
  }

  clearSource(owner, reason) {
    const matches = row => sameSource(row.owner, owner);
    this.pending = this.pending.filter(row => {
      if (!matches(row)) return true;
      row.status = 'cancelled'; row.reason = reason; this.record('action_cancelled', row, { reason }); return false;
    });
    if (this.active && matches(this.active)) {
      const row = this.active; row.status = 'cancelled'; row.reason = reason;
      this.executors[this.executor].cancel?.(row, reason); this.record('action_cancelled', row, { reason }); this.active = null;
    }
    this.faceActive = this.faceActive.filter(row => {
      if (!matches(row)) return true;
      this.executors.face?.cancel?.(row, reason); row.status = 'cancelled'; this.record('action_cancelled', row, { reason }); return false;
    });
  }

  cancel(owner = null, reason = 'barge_in') {
    const owners = owner ? [owner] : [...this.pending, ...(this.active ? [this.active] : []), ...this.faceActive].map(row => row.owner);
    const keys = new Set();
    for (const item of owners) {
      if (!bodyOwnerKey(item) || !ownerVersion(item)) continue;
      const key = `${bodyOwnerKey(item)}@${item.sourceVersion}`;
      if (keys.has(key)) continue; keys.add(key); this.cancelled.add(key); this.clearSource(item, reason);
    }
    return { cancelledSources: keys.size };
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

  update(now, dt, media = this.media) {
    if (!Number.isFinite(now) || !Number.isFinite(dt) || dt < 0) throw Error('invalid_body_clock');
    this.now = now; this.media = media;
    if (this.paused || media.paused) {
      for (const row of this.pending) row.due += dt;
      return this.snapshot();
    }
    for (const row of [...this.pending, ...(this.active ? [this.active] : []), ...this.faceActive]) {
      if (!this.current(row.owner)) this.clearSource(row.owner, 'source_retired');
    }
    // Playback-end is terminal evidence for a queued voice onset. In particular,
    // an assistant segment-end semantic gate may release its command after the
    // audio has finished. Do not replay that missed gesture or leave it blocking
    // a later activity. Already moving bodies retain their mechanical exit.
    if (media.audioStatus === 'ended' && Number.isFinite(media.audioTime) && media.audioTime >= 0) {
      this.pending = this.pending.filter(row => {
        if (row.anchor !== 'voice' || !this.matchesMedia(row, media)) return true;
        row.status = 'expired'; row.reason = 'voice_anchor_missed'; row.expiredAt = now;
        this.record('action_expired', row, { reason: row.reason, audioTime: media.audioTime });
        return false;
      });
    }
    if (this.active) {
      const row = this.active, state = this.executors[this.executor].status(row);
      if (state.started && row.displayedAt == null) {
        row.displayedAt = now; row.status = 'playing'; this.record('action_started', row, { executor: this.executor });
      }
      if (state.done) {
        row.status = state.failed ? 'failed' : 'completed'; row.reason = state.reason ?? null; row.completedAt = now;
        this.record(`action_${row.status}`, row, { reason: row.reason, executor: this.executor }); this.active = null;
      }
    }
    this.faceActive = this.faceActive.filter(row => {
      const state = this.executors.face.status(row);
      if (state.started && row.displayedAt == null) { row.displayedAt = now; this.record('action_started', row, { executor: 'face' }); }
      if (!state.done) return true;
      row.status = 'completed'; this.record('action_completed', row, { executor: 'face' }); return false;
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
    }
    if (this.active || !this.executors[this.executor].canYield()) return this.snapshot();
    const index = this.pending.findIndex(row => CHARACTER_ACTIONS[row.action].channel !== 'face');
    if (index < 0) return this.snapshot();
    const row = this.pending[index], def = CHARACTER_ACTIONS[row.action];
    if (now < row.due || !this.anchorReady(row, media)) return this.snapshot();
    const actor = this.getActorState();
    const reason = bodyAdmission(def, actor) ?? this.executors[def.executor]?.check?.(def, actor) ?? null;
    if (reason || !this.executors[def.executor]) {
      this.pending.splice(index, 1); row.status = 'rejected'; row.reason = reason ?? 'executor_unavailable';
      this.record('action_rejected', row, { reason: row.reason }); return this.snapshot();
    }
    // start is synchronous and transactional: a refusal cannot steal ownership.
    const oldExecutor = this.executor;
    let accepted = false;
    try { accepted = this.executors[def.executor].start(def, row, actor, oldExecutor) === true; }
    catch (error) { row.reason = `executor_error:${error.message}`; }
    this.pending.splice(index, 1);
    if (!accepted) { row.status = 'rejected'; row.reason ??= 'executor_refused';
      this.record('action_rejected', row, { reason: row.reason }); return this.snapshot(); }
    this.executor = def.executor; this.active = row; row.status = 'admitted'; row.admittedAt = now;
    this.record('body_handover', row, { from: oldExecutor, to: this.executor,
      support: actor.support, held: held(actor).map(([id]) => id) });
    this.record('action_admitted', row, { executor: this.executor });
    return this.snapshot();
  }

  snapshot() {
    return { now: this.now, paused: this.paused, executor: this.executor, active: copy(this.active),
      pending: copy(this.pending), faceActive: copy(this.faceActive), actorState: copy(this.getActorState()),
      rows: copy(this.rows.slice(-250)), events: copy(this.events.slice(-100)),
      policy: 'model chooses; no per-turn action limit; real support and held props govern admission' };
  }
}

export { CharacterBodyDirector as BodyDirector };
