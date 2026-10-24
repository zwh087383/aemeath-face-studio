import { NativeExpression } from './native-expression.js';

const clone = value => structuredClone(value);
const sameOwner = (a, b) => a && b && a.source === b.source && a.generation === b.generation;
const validOwner = owner => owner && typeof owner.source === 'string' && owner.source.length > 0
  && Number.isSafeInteger(owner.generation) && owner.generation >= 0;
const finiteTime = t => Number.isFinite(t) && t >= 0;
const smooth = u => { u = Math.max(0, Math.min(1, u)); return u * u * u * (10 + u * (-15 + 6 * u)); };

/** Pure preparation player. The host supplies authoritative base weights and
 * playback time; this controller never infers emotion, opens audio, or selects
 * a gesture. PMX groups are expanded before this boundary. */
export class PreparedFaceController {
  constructor({ recipes, morphCount, mouthIndices = [], responseSeconds = .075 } = {}) {
    if (!Number.isSafeInteger(morphCount) || morphCount <= 0 || !(responseSeconds > 0 && Number.isFinite(responseSeconds))) throw Error('Invalid face dimensions');
    this.count = morphCount; this.responseSeconds = responseSeconds;
    if (!mouthIndices.every(i => Number.isSafeInteger(i) && i >= 0 && i < morphCount)) throw Error('Invalid mouth ownership');
    this.mouth = new Set(mouthIndices); this.recipes = new Map();
    for (const recipe of recipes ?? []) {
      if (!recipe.id || this.recipes.has(recipe.id) || !Array.isArray(recipe.mapping)) throw Error('Invalid or duplicate face recipe');
      for (const channel of recipe.mapping) for (const leaf of channel.leaves) {
        if (!Number.isSafeInteger(leaf.index) || leaf.index < 0 || leaf.index >= morphCount || !Number.isFinite(leaf.ratio)) throw Error('Invalid face mapping');
      }
      this.recipes.set(recipe.id, { ...recipe, sampler: recipe.nativeData ? new NativeExpression(recipe.nativeData) : null });
    }
    this.base = new Float64Array(morphCount); this.weights = new Float64Array(morphCount);
    this.velocity = new Float64Array(morphCount); this.output = new Float64Array(morphCount);
    this.now = 0; this.wall = null; this.active = null; this.baseRevision = -1;
    this.latest = new Map(); this.retired = new Map(); this.cues = new Map(); this.rejected = []; this.last = null;
  }
  reject(reason) { this.rejected.push({ reason, at: this.now }); if (this.rejected.length > 30) this.rejected.shift(); return false; }
  setBase(values, revision) {
    if (!Number.isSafeInteger(revision) || revision <= this.baseRevision) return this.reject('stale-base');
    const next = this.vector(values); this.base.set(next); this.baseRevision = revision; return true;
  }
  vector(values = {}) {
    const result = new Float64Array(this.count);
    for (const [key, value] of Object.entries(values)) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.count || !Number.isFinite(value) || Math.abs(value) > 4) throw Error('Invalid or excessive morph weight');
      result[index] = value;
    }
    return result;
  }
  start(id, owner, { attack = .3, hold, release = .45, intensity = 1, cueId } = {}) {
    const recipe = this.recipes.get(id);
    if (!recipe || (!recipe.mapping.some(row => row.leaves.length) && !(recipe.kind === 'authored-expression' && Object.keys(recipe.values ?? {}).length === 0))) return this.reject('unmapped-recipe');
    if (!validOwner(owner) || owner.generation < (this.latest.get(owner.source) ?? -1)
      || owner.generation <= (this.retired.get(owner.source) ?? -1)) return this.reject('stale-owner');
    const repeatedOwner = owner.generation === this.latest.get(owner.source);
    if (cueId !== undefined && (typeof cueId !== 'string' || !cueId.length || cueId.length > 128)) return this.reject('invalid-cue');
    if (repeatedOwner && (!cueId || this.cues.get(owner.source)?.has(cueId))) return this.reject('duplicate-cue');
    if (repeatedOwner && this.cues.get(owner.source)?.size >= 256) return this.reject('owner-cue-limit');
    hold ??= Math.max(1.2, recipe.sampler?.duration ?? 0);
    if (![attack, hold, release, intensity].every(Number.isFinite) || attack <= 0 || release <= 0 || hold < 0 || intensity < 0 || intensity > 1
      || attack + hold + release > 60) return this.reject('invalid-envelope');
    if (this.active && !sameOwner(this.active.owner, owner)) this.retired.set(this.active.owner.source, this.active.owner.generation);
    if (!repeatedOwner) this.cues.set(owner.source, new Set());
    this.cues.get(owner.source).add(cueId ?? '__single-expression');
    this.latest.set(owner.source, owner.generation);
    this.active = { id, owner: clone(owner), cueId: cueId ?? null, started: this.now, attack, hold, release, intensity };
    return true;
  }
  cancel(owner) {
    if (!validOwner(owner) || !sameOwner(owner, this.active?.owner)) return this.reject('cancel-owner-mismatch');
    this.retired.set(owner.source, owner.generation);
    this.active = null; return true; // Existing x and v are deliberately retained.
  }
  retire(owner) {
    if (!validOwner(owner) || owner.generation !== this.latest.get(owner.source)) return this.reject('retire-owner-mismatch');
    this.retired.set(owner.source, owner.generation);
    if (sameOwner(this.active?.owner, owner)) this.active = null;
    return true;
  }
  resumeClock(wallSeconds) {
    if (!finiteTime(wallSeconds) || (this.wall !== null && wallSeconds < this.wall)) throw Error('Face clock must be monotonic');
    this.wall = wallSeconds;
  }
  target() {
    const target = Float64Array.from(this.base), active = this.active;
    if (!active) return target;
    const age = this.now - active.started, total = active.attack + active.hold + active.release;
    if (age >= total) { this.active = null; return target; }
    const envelope = active.intensity * (age < active.attack ? smooth(age / active.attack)
      : age < active.attack + active.hold ? 1 : 1 - smooth((age - active.attack - active.hold) / active.release));
    const recipe = this.recipes.get(active.id), input = recipe.sampler
      ? recipe.sampler.sample(Math.min(Math.max(0, age - active.attack), recipe.sampler.duration)) : recipe.values;
    const expression = new Map();
    for (const channel of recipe.mapping) {
      const value = input[channel.source] ?? 0;
      if (!Number.isFinite(value) || Math.abs(value) > 4) throw Error('Invalid sampled native curve');
      for (const leaf of channel.leaves) expression.set(leaf.index, (expression.get(leaf.index) ?? 0) + value * leaf.ratio);
    }
    for (const [index, value] of expression) target[index] += (value - target[index]) * envelope;
    return target;
  }
  update(wallSeconds, { paused = false, speaking = false, lipWeights = {}, blink = 0 } = {}) {
    if (!finiteTime(wallSeconds) || (this.wall !== null && wallSeconds < this.wall - 1e-12)) throw Error('Face clock must be monotonic');
    if (this.wall !== null) wallSeconds = Math.max(this.wall, wallSeconds);
    const elapsed = this.wall === null ? 0 : wallSeconds - this.wall; this.wall = wallSeconds;
    if (elapsed > 10) throw Error('Unbounded face clock gap; explicitly resume with current time');
    const duration = paused ? 0 : elapsed;
    // A paused or same-time draw must be an exact no-op for expression state;
    // even target + (x-target) can introduce a few ulps when dt is zero.
    const steps = Math.ceil(duration / (1 / 120)), dt = steps ? duration / steps : 0;
    for (let step = 0; step < steps; step++) {
      this.now += dt; const target = this.target(), omega = 2 / this.responseSeconds, decay = Math.exp(-omega * dt);
      for (let i = 0; i < this.count; i++) {
        // Exact critically damped solution for this substep. Replacing/cancelling
        // changes the target, never the currently displayed value or velocity.
        const delta = this.weights[i] - target[i], b = this.velocity[i] + omega * delta;
        this.weights[i] = target[i] + (delta + b * dt) * decay;
        this.velocity[i] = (this.velocity[i] - omega * b * dt) * decay;
      }
    }
    this.output.set(this.weights);
    if (speaking) {
      const lips = this.vector(lipWeights);
      for (const index of this.mouth) this.output[index] = lips[index];
    }
    // Blinks have explicit host ownership and cannot cancel the base emotion.
    // Hosts should provide an already checked blink index; this lab uses PMX 23.
    if (blink && this.count > 23 && Number.isFinite(blink)) this.output[23] = Math.max(this.output[23], Math.max(0, Math.min(1, blink)));
    if (![...this.output, ...this.velocity].every(Number.isFinite)) throw Error('Non-finite composed face');
    this.last = { speaking, paused }; return this.output;
  }
  snapshot() { return { time: this.now, baseRevision: this.baseRevision, active: clone(this.active), last: this.last,
    weights: Array.from(this.output), expressionWeights: Array.from(this.weights), velocity: Array.from(this.velocity), rejected: clone(this.rejected) }; }
}
