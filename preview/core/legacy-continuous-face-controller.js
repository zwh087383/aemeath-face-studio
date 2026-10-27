import { NativeExpression } from './native-expression.js';
import { ATTITUDE_KINDS, REACTION_KINDS, FACE_PROFILES, FACE_TIMING, actionFaceCompatible } from '../../realtime/character-center/face-profiles.mjs';

const clone = value => structuredClone(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const unit = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = unit(value); return t * t * (3 - 2 * t); };
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const validIdentity = value => value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 160
  && typeof value.source === 'string' && value.source.length > 0 && value.source.length <= 240 && validRevision(value.revision);
const isCorner = name => /^(M_(Smile|Ennui)_[RL]|P_M_Z[RL]_Add)$/.test(name) || /口角/.test(name);
const isSmile = name => /^(M_Smile_[RL]|P_M_Z[RL]_Add|B_Happy|B_Cheerful|E_Blephar|E_Smile_[RL]|S_16)$/.test(name) || /口角上げ|にこり|笑い目|にやり/.test(name);
const isClosure = name => /^(E_Close(?:_[LR])?|E_Smile_[LR]|E_Blephar)$/.test(name) || /まばたき|ウィンク|ｳｨﾝｸ|笑い目/.test(name);

/** A single final PMX-leaf compositor. It does not mutate WAI, choose body
 * actions, infer semantic meaning from text, or own any head/eye bones. */
export class ContinuousFaceController {
  constructor({ recipes = [], morphCount, mouthIndices = [], responseSeconds = FACE_TIMING.responseSeconds, profiles = FACE_PROFILES } = {}) {
    if (!Number.isSafeInteger(morphCount) || morphCount <= 0 || !finite(responseSeconds) || responseSeconds <= 0) throw Error('Invalid face dimensions');
    if (!mouthIndices.every(i => Number.isSafeInteger(i) && i >= 0 && i < morphCount)) throw Error('Invalid mouth ownership');
    this.count = morphCount; this.responseSeconds = responseSeconds; this.profiles = profiles;
    this.recipes = new Map(); this.mouth = new Set(mouthIndices); this.corners = new Set(); this.smiles = new Set(); this.closures = new Set();
    this.expressionIndices = new Set(); this.blinkIndices = new Set(); this.openEyes = new Set();
    for (const recipe of recipes) {
      if (!recipe.id || this.recipes.has(recipe.id) || !Array.isArray(recipe.mapping)) throw Error('Invalid or duplicate face recipe');
      for (const channel of recipe.mapping) for (const leaf of channel.leaves) {
        if (!Number.isSafeInteger(leaf.index) || leaf.index < 0 || leaf.index >= morphCount || !finite(leaf.ratio)) throw Error('Invalid face mapping');
        this.expressionIndices.add(leaf.index);
        if (isCorner(channel.source)) this.corners.add(leaf.index);
        if (isSmile(channel.source)) this.smiles.add(leaf.index);
        if (isClosure(channel.source)) this.closures.add(leaf.index);
        if (channel.source === 'E_Close' || channel.source === 'まばたき') this.blinkIndices.add(leaf.index);
        if (channel.source === 'E_Stare' || channel.source === 'びっくり') this.openEyes.add(leaf.index);
      }
      this.recipes.set(recipe.id, { ...recipe, sampler: recipe.nativeData ? new NativeExpression(recipe.nativeData) : null });
    }
    this.articulators = new Set([...this.mouth].filter(i => !this.corners.has(i)));
    this.weights = new Float64Array(morphCount); this.velocity = new Float64Array(morphCount); this.output = new Float64Array(morphCount);
    this.base = new Float64Array(morphCount); this.fatigue = new Float64Array(morphCount); this.math = null; this.mathRevision = -1;
    this.attitude = null; this.reactions = new Map(); this.completedReactions = new Set(); this.overlays = new Map(); this.latest = new Map(); this.cancelled = new Map();
    this.now = 0; this.wall = null; this.blinkSince = null; this.last = null; this.rejected = []; this.lastTarget = new Float64Array(morphCount); this.attitudeRevision = -1;
    this.speechActive = false; this.articulationReleaseUntil = 0;
  }
  reject(reason) { this.rejected.push({ reason, at: this.now }); if (this.rejected.length > 64) this.rejected.shift(); return false; }
  vector(values = {}) {
    const result = new Float64Array(this.count);
    for (const [key, value] of Object.entries(values)) {
      const i = Number(key); if (!Number.isSafeInteger(i) || i < 0 || i >= this.count || !finite(value) || Math.abs(value) > 4) throw Error('Invalid morph weight');
      result[i] = value;
    }
    return result;
  }
  sampleRecipe(id, age = 0) {
    const recipe = this.recipes.get(id); if (!recipe) return null;
    const values = recipe.sampler ? recipe.sampler.sample(Math.min(Math.max(0, age), recipe.sampler.duration)) : recipe.values ?? {};
    const target = new Float64Array(this.count);
    for (const channel of recipe.mapping) {
      const value = values[channel.source] ?? 0;
      if (!finite(value) || Math.abs(value) > 4) throw Error('Invalid sampled native curve');
      for (const leaf of channel.leaves) target[leaf.index] += value * leaf.ratio;
    }
    if (!target.every(value => finite(value) && Math.abs(value) <= 4)) throw Error('Invalid expanded native expression');
    return target;
  }
  profile(kind, recipeId) {
    const entry = this.profiles[kind]; if (!entry) return null;
    const id = recipeId ?? entry.recipeId;
    if (id !== entry.recipeId && !(entry.allowedRecipes ?? []).includes(id)) return null;
    const values = this.sampleRecipe(id);
    // Natural attention is an explicit zero target, not a fabricated emotion.
    if (!values && kind !== 'attention') return null;
    return { ...entry, recipeId: id, values: values ?? new Float64Array(this.count) };
  }
  setMathematical(snapshot, revision) {
    if (!validRevision(revision) || revision <= this.mathRevision) return this.reject('stale-mathematical');
    const emotion = snapshot?.emotion ?? snapshot;
    if (!emotion || !finite(emotion.V) || emotion.V < -1 || emotion.V > 1 || !finite(emotion.A) || emotion.A < 0 || emotion.A > 1) return this.reject('invalid-mathematical');
    const stress = finite(emotion.S) ? unit(emotion.S) : 0;
    const energy = finite(snapshot?.effectiveEnergy) ? unit(snapshot.effectiveEnergy) : null;
    const base = new Float64Array(this.count);
    const add = (kind, amount) => { const p = this.profile(kind); if (p) for (let i = 0; i < this.count; i++) base[i] += p.values[i] * p.gain * amount; };
    const positive = Math.max(0, emotion.V), negative = Math.max(0, -emotion.V), tense = unit((emotion.A - .45) / .55) * stress;
    add('warm', positive * (1 - .55 * emotion.A)); add('excited', positive * .55 * emotion.A);
    add('sad', negative * (1 - tense)); add('anger', negative * tense);
    this.fatigue.fill(0);
    if (energy !== null) {
      const tired = this.profile('tired'), gain = Math.max(0, (.45 - energy) / .45) * .7;
      if (tired) for (let i = 0; i < this.count; i++) { this.fatigue[i] = tired.values[i] * tired.gain * gain; base[i] += this.fatigue[i]; }
    }
    this.math = clone(snapshot); this.mathRevision = revision; this.base.set(base); return true;
  }
  accepts(command, channel) {
    if (!validIdentity(command) || !finite(command.strength ?? .5) || (command.strength ?? .5) < 0 || (command.strength ?? .5) > 1) return this.reject('invalid-face-command');
    const key = `${channel}:${command.source}`;
    if (command.revision <= (this.latest.get(key) ?? -1)) return this.reject('stale-face-revision');
    if (command.revision <= (this.cancelled.get(command.source) ?? -1)) return this.reject('cancelled-face-source');
    return true;
  }
  setAttitude(command) {
    if (!this.accepts(command, 'attitude')) return false;
    if (command.revision <= this.attitudeRevision) return this.reject('stale-attitude-revision');
    if (!ATTITUDE_KINDS.includes(command.kind) || !this.profile(command.kind, command.recipeId)) return this.reject('unsupported-attitude');
    const previous = this.attitude, same = previous && previous.id === command.id && previous.source === command.source;
    if (same && previous.kind !== command.kind) return this.reject('changed-intent-needs-new-id');
    const newEvidence = typeof command.evidenceId === 'string' && command.evidenceId.length > 0 && command.evidenceId !== previous?.confirmedEvidenceId;
    const renewed = !same || (command.renew === true && newEvidence);
    this.attitude = { ...clone(command), strength: command.strength ?? .5, started: same ? previous.started : this.now,
      confirmedAt: renewed ? this.now : previous.confirmedAt,
      confirmedEvidenceId: renewed ? command.evidenceId ?? null : previous.confirmedEvidenceId,
      evidenceId: same && !newEvidence ? previous.evidenceId : command.evidenceId ?? null };
    this.latest.set(`attitude:${command.source}`, command.revision); this.attitudeRevision = command.revision; return true;
  }
  clearAttitude({ id, source, revision } = {}) {
    if (!validRevision(revision) || typeof source !== 'string' || !this.attitude || this.attitude.id !== id || this.attitude.source !== source
      || revision <= this.attitudeRevision) return this.reject('attitude-release-mismatch');
    this.latest.set(`attitude:${source}`, revision); this.attitudeRevision = revision; this.attitude = null; return true;
  }
  react(command) {
    if (!this.accepts(command, 'reaction')) return false;
    if (!REACTION_KINDS.includes(command.kind) || !this.profile(command.kind, command.recipeId)) return this.reject('unsupported-reaction');
    const attack = command.attack ?? FACE_TIMING.reactionAttack, hold = command.hold ?? FACE_TIMING.reactionHold, release = command.release ?? FACE_TIMING.reactionRelease;
    if (![attack, hold, release].every(finite) || attack <= 0 || hold < 0 || release <= 0 || attack + hold + release > 8) return this.reject('invalid-reaction-envelope');
    const key = `${command.source}:${command.id}`, old = this.reactions.get(key);
    if (this.completedReactions.has(key)) return this.reject('completed-reaction-id');
    if (old && (old.kind !== command.kind || old.recipeId !== command.recipeId)) return this.reject('changed-reaction-needs-new-id');
    this.reactions.set(key, { ...clone(command), strength: command.strength ?? .5, attack, hold, release, started: old?.started ?? this.now });
    this.latest.set(`reaction:${command.source}`, command.revision); return true;
  }
  setActionOverlay(command) {
    if (!this.accepts(command, 'overlay')) return false;
    if (command.phase !== undefined && (!finite(command.phase) || command.phase < 0 || command.phase > 1)) return this.reject('invalid-action-face-phase');
    if (!this.profile(command.kind, command.recipeId)) return this.reject('unsupported-action-face');
    const key = `${command.source}:${command.id}`, old = this.overlays.get(key);
    this.overlays.set(key, { ...clone(command), strength: command.strength ?? .5, started: old?.started ?? this.now });
    this.latest.set(`overlay:${command.source}`, command.revision); return true;
  }
  clearActionOverlay({ id, source, revision } = {}) {
    const cue = this.overlays.get(`${source}:${id}`);
    if (revision !== undefined && (!validRevision(revision) || (cue && revision < cue.revision))) return this.reject('old-overlay-release');
    return this.overlays.delete(`${source}:${id}`);
  }
  cancel({ source, revision } = {}) {
    if (typeof source !== 'string' || !validRevision(revision)) return this.reject('invalid-cancellation');
    if (revision < (this.cancelled.get(source) ?? -1)) return this.reject('old-cancellation');
    this.cancelled.set(source, revision);
    for (const collection of [this.reactions, this.overlays]) for (const [key, cue] of collection) if (cue.source === source && cue.revision <= revision) {
      collection.delete(key); if (collection === this.reactions) this.completedReactions.add(key);
    }
    return true;
  }
  retire(owner) { return this.cancel({ source: owner?.source, revision: owner?.revision ?? owner?.generation }); }
  resumeClock(time) { if (!finite(time) || time < 0 || (this.wall !== null && time < this.wall)) throw Error('Face clock must be monotonic'); this.wall = time; }
  attitudeState() {
    if (!this.attitude) return null;
    const elapsed = Math.max(0, this.now - this.attitude.confirmedAt);
    const fade = smooth((elapsed - FACE_TIMING.semanticHoldSeconds) / FACE_TIMING.semanticFadeSeconds);
    return { ...this.attitude, elapsed, fade, effectiveKind: fade >= 1 ? 'attention' : this.attitude.kind };
  }
  target() {
    const target = Float64Array.from(this.base), attitude = this.attitudeState();
    if (attitude) {
      const p = this.profile(attitude.kind, attitude.recipeId);
      for (const i of this.expressionIndices) target[i] = p.values[i] * p.gain * attitude.strength * (1 - attitude.fade);
      for (const i of this.blinkIndices) target[i] = Math.max(target[i], this.fatigue[i]);
      // Expiry becomes noncommittal attention, not the formerly suppressed smile.
    }
    const apply = (cue, amount) => {
      if (!actionFaceCompatible(attitude?.effectiveKind, cue.kind)) return;
      const p = this.profile(cue.kind, cue.recipeId); if (!p) return;
      for (const i of this.expressionIndices) target[i] += (p.values[i] * p.gain * cue.strength - target[i]) * amount;
    };
    for (const cue of this.overlays.values()) if (!(attitude?.fade >= 1 && cue.kind !== 'attention')) apply(cue, unit(cue.phase ?? 1) * .45);
    for (const [key, cue] of this.reactions) {
      const age = this.now - cue.started, total = cue.attack + cue.hold + cue.release;
      if (age >= total) { this.reactions.delete(key); this.completedReactions.add(key); continue; }
      const amount = age < cue.attack ? smooth(age / cue.attack) : age < cue.attack + cue.hold ? 1 : 1 - smooth((age - cue.attack - cue.hold) / cue.release);
      apply(cue, amount);
    }
    return target;
  }
  update(wallSeconds, { paused = false, speaking = false, lipWeights = {}, blink = 0, actionBlink = 0, closure = 0 } = {}) {
    if (!finite(wallSeconds) || wallSeconds < 0 || (this.wall !== null && wallSeconds < this.wall - 1e-12)) throw Error('Face clock must be monotonic');
    if (![blink, actionBlink, closure].every(finite)) throw Error('Invalid mechanical face input');
    if (this.wall !== null) wallSeconds = Math.max(wallSeconds, this.wall);
    const elapsed = this.wall === null ? 0 : wallSeconds - this.wall; this.wall = wallSeconds;
    if (elapsed > 10) throw Error('Unbounded face clock gap; explicitly resume with current time');
    const duration = paused ? 0 : elapsed;
    if (!duration) { this.last = { speaking, paused }; return this.output; }
    if (this.speechActive && !speaking) this.articulationReleaseUntil = this.now + .12;
    this.speechActive = speaking;
    const lips = this.vector(lipWeights), steps = Math.ceil(duration * 120), dt = duration / steps;
    for (let step = 0; step < steps; step++) {
      this.now += dt;
      const target = this.target(), requestedBlink = unit(Math.max(blink, actionBlink));
      if (requestedBlink <= .001) this.blinkSince = null;
      else if (this.blinkSince === null) this.blinkSince = this.now;
      const actualBlink = this.blinkSince !== null && this.now - this.blinkSince > FACE_TIMING.maximumBlinkSeconds ? 0 : requestedBlink;
      if (speaking) {
        for (const i of this.articulators) target[i] = lips[i];
        for (const i of this.corners) target[i] *= 1 - .75 * unit(closure);
      }
      for (const i of this.blinkIndices) target[i] = Math.max(target[i], actualBlink);
      for (const i of this.openEyes) target[i] *= 1 - actualBlink;
      let closing = 0; for (const i of this.closures) closing += Math.max(0, target[i]);
      const closureLimit = actualBlink > 0 ? Math.max(FACE_TIMING.sustainedClosureLimit, actualBlink) : FACE_TIMING.sustainedClosureLimit;
      if (closing > closureLimit) for (const i of this.closures) if (target[i] > 0) target[i] *= closureLimit / closing;
      this.lastTarget.set(target);
      for (let i = 0; i < this.count; i++) {
        const fast = this.articulators.has(i) && (speaking || this.now < this.articulationReleaseUntil);
        const response = fast ? FACE_TIMING.articulationSeconds : this.blinkIndices.has(i) && actualBlink > 0 ? .025 : this.responseSeconds;
        const omega = 2 / response, decay = Math.exp(-omega * dt), delta = this.weights[i] - target[i], b = this.velocity[i] + omega * delta;
        this.weights[i] = target[i] + (delta + b * dt) * decay; this.velocity[i] = (this.velocity[i] - omega * b * dt) * decay;
      }
    }
    if (![...this.weights, ...this.velocity].every(finite)) throw Error('Non-finite final face');
    this.output.set(this.weights); this.last = { speaking, paused }; return this.output;
  }
  snapshot() {
    return { time: this.now, mathematicalRevision: this.mathRevision, math: clone(this.math), attitude: clone(this.attitudeState()),
      reactions: clone([...this.reactions.values()]), overlays: clone([...this.overlays.values()]), last: clone(this.last),
      weights: Array.from(this.output), velocity: Array.from(this.velocity), target: Array.from(this.lastTarget), rejected: clone(this.rejected),
      boundaries: { semanticExpirySeconds: FACE_TIMING.semanticHoldSeconds, semanticFadeSeconds: FACE_TIMING.semanticFadeSeconds, mathematicalStateReadOnly: true, headAndEyeBonesOwned: false, calibration: 'experimental' } };
  }
}
