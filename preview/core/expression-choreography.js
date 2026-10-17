import { CHANNELS, C, VOWELS } from './profile.js';
import { GESTURES } from './motion-profile.js';

const clamp = x => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const smooth = x => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
const MOUTH_SHAPE = new Set([...VOWELS, C.mouthWide, C.mouthNarrow, C.mouthFlat]);
const ATTITUDE_CHANNELS = [C.browFocus, C.browAnger, C.browSmile, C.browSad, C.browUp, C.browAsym,
  C.smileEyes, C.wink, C.eyeSharp, C.eyeDroop, C.eyeHalf, C.eyeSmile, C.eyeWide, C.pupilSmall, C.smile, C.frown, C.blush];
const ATTITUDE_MODES = new Set(['listening', 'thinking', 'responding', 'settling']);

/** Small sustained targets, independent of the hand's travel clock. This is an
 * interaction policy, not an estimate of the speaker/model's internal emotion. */
export function sampleAttitude(state, out = new Float32Array(CHANNELS.length)) {
  out.fill(0);
  if (!ATTITUDE_MODES.has(state?.mode)) return out;
  const warmth = clamp(state.warmth), tension = clamp(state.tension), uncertainty = clamp(state.uncertainty);
  out[C.browFocus] = .22 * tension;
  out[C.browAnger] = .08 * tension;
  out[C.browSmile] = .20 * warmth;
  out[C.browSad] = .22 * uncertainty;
  out[C.browAsym] = .10 * uncertainty;
  out[C.eyeSharp] = .14 * tension;
  out[C.eyeSmile] = .18 * warmth;
  // Waiting for an answer is not evidence of uncertainty or tired eyelids.
  out[C.eyeHalf] = .02 * warmth + .06 * uncertainty;
  out[C.smile] = .30 * warmth;
  out[C.frown] = .10 * tension;
  return out;
}

// Small original procedural materials, not captured human motion. Each follows
// the SAME executed reaction as the body with its own relative timing. Only
// upper-face channels are used; existing mouth ownership remains unchanged.
const REACTION_FACE = Object.freeze({
  'listen-adjust': [[0, {}], [.18, { browUp: .10, eyeWide: .025 }], [.51, { browFocus: .045 }], [1, {}]],
  nod: [[0, {}], [.12, { browSmile: .06 }], [.44, { eyeSmile: .08, browSmile: .04 }], [1, {}]],
  'light-explain': [[0, {}], [.26, { browAsym: .065, browUp: .035 }], [.64, { eyeSmile: .055 }], [1, {}]],
});

export function sampleReactionExpression(reaction, out = new Float32Array(CHANNELS.length)) {
  out.fill(0);
  const keys = REACTION_FACE[reaction?.kind];
  if (!keys || reaction.recovering || !Number.isFinite(reaction.age) || reaction.age < 0
    || !Number.isFinite(reaction.duration) || reaction.duration <= 0) return out;
  const age = reaction.age / reaction.duration;
  if (age > 1) return out;
  let index = 0;
  while (index < keys.length - 2 && age > keys[index + 1][0]) index++;
  const a = keys[index], b = keys[index + 1], u = smooth((age - a[0]) / (b[0] - a[0]));
  for (const name of new Set([...Object.keys(a[1]), ...Object.keys(b[1])])) {
    out[C[name]] = ((a[1][name] ?? 0) * (1 - u) + (b[1][name] ?? 0) * u) * clamp(reaction.strength ?? 1);
  }
  return out;
}

/** Sample expressive intent on the body's warped gesture clock. Expression keys
 * are full poses: omitted channels mean zero, not a sticky prior preset. */
export function sampleGestureExpression(gesture, age, strength = 1, out = new Float32Array(CHANNELS.length)) {
  out.fill(0);
  const def = typeof gesture === 'string' ? GESTURES[gesture] : gesture;
  const keys = def?.expression?.keys;
  if (!keys?.length || !Number.isFinite(age) || age < 0 || age > def.duration) return out;
  let i = 0;
  while (i < keys.length - 2 && age > keys[i + 1][0]) i++;
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  const u = b[0] > a[0] ? smooth((age - a[0]) / (b[0] - a[0])) : 1;
  for (let j = 0; j < CHANNELS.length; j++) {
    const key = CHANNELS[j];
    out[j] = clamp(((a[1][key] ?? 0) * (1 - u) + (b[1][key] ?? 0) * u) * clamp(strength));
  }
  return out;
}

/** One persistent layer per avatar. Never restarts a preset transition every frame.
 * The returned array is reused until the next update. Missing/replaced cues decay
 * from the current rendered expression, including interruption before the apex. */
export class ExpressionChoreographer {
  constructor() {
    this.weights = new Float32Array(CHANNELS.length);
    this.target = new Float32Array(CHANNELS.length);
    this.sample = new Float32Array(CHANNELS.length);
    this.lastNow = null;
    this.layers = new Map();
    this.attitude = { weights: new Float32Array(CHANNELS.length), weight: 0 };
    this.attitudeTarget = new Float32Array(CHANNELS.length);
  }

  update(now, gestures = [], { paused = false, attitude = null, reactions = [] } = {}) {
    if (!Number.isFinite(now)) return this.weights;
    const dt = this.lastNow === null ? 0 : Math.max(0, Math.min(.1, now - this.lastNow));
    this.lastNow = Number.isFinite(now) ? now : this.lastNow;
    // A sustained attitude can release a former brow/eye/corner pose. Its clock
    // follows this host update, never a hand's stretched preparation/recovery.
    if (!paused) {
      const enabled = ATTITUDE_MODES.has(attitude?.mode);
      sampleAttitude(attitude, this.attitudeTarget);
      const k = 1 - Math.exp(-dt / .16);
      for (const i of ATTITUDE_CHANNELS) this.attitude.weights[i] += (this.attitudeTarget[i] - this.attitude.weights[i]) * k;
      this.attitude.weight += ((enabled ? 1 : 0) - this.attitude.weight) * k;
      if (!enabled && this.attitude.weight < 1e-6) this.attitude.weight = 0;
    }
    this.target.fill(0);
    let sum = 0;
    const present = new Set();
    for (const [index, g] of gestures.entries()) {
      if (!GESTURES[g.gesture]?.expression) continue;
      // Real MotionController snapshots have stable ids. The fallback preserves
      // the original small public API for callers supplying only gesture/age.
      const id = g.id ?? `${g.gesture}:${index}`;
      present.add(id);
      let layer = this.layers.get(id);
      if (!layer) {
        layer = { weights: new Float32Array(CHANNELS.length), target: new Float32Array(CHANNELS.length), retiring: false };
        this.layers.set(id, layer);
      }
      // Freeze the *displayed contribution*, not the author's still-rising pose.
      // A cancelled layer stays retired even if an old snapshot is replayed.
      layer.retiring ||= !!g.recovering;
      layer.target.fill(0);
      if (layer.retiring) continue;
      const gain = clamp(g.expressionWeight ?? g.strength ?? 1);
      sampleGestureExpression(g.gesture, g.age, 1, this.sample);
      for (let i = 0; i < CHANNELS.length; i++) layer.target[i] = this.sample[i] * gain;
      // A newly admitted action with an empty face contributes neither a target
      // nor normalization weight. It cannot dim the already visible expression.
      if (this.sample.some(x => x > 1e-7)) sum += gain;
    }
    for (const reaction of reactions.slice(0, 4)) {
      if (!REACTION_FACE[reaction.kind] || typeof reaction.id !== 'string') continue;
      const id = `reaction:${reaction.id}`;
      present.add(id);
      let layer = this.layers.get(id);
      if (!layer) {
        layer = { weights: new Float32Array(CHANNELS.length), target: new Float32Array(CHANNELS.length), retiring: false, transient: true };
        this.layers.set(id, layer);
      }
      layer.retiring ||= !!reaction.recovering;
      layer.target.fill(0);
      if (!layer.retiring) sampleReactionExpression(reaction, layer.target);
    }
    this.weights.fill(0);
    for (const [id, layer] of this.layers) {
      if (!present.has(id)) { layer.retiring = true; layer.target.fill(0); }
      for (let i = 0; i < CHANNELS.length; i++) {
        const target = layer.retiring ? 0 : layer.target[i] / (layer.transient ? 1 : Math.max(1, sum));
        this.target[i] += target;
        if (!paused || layer.retiring) {
          const tau = i === C.blink ? .025 : i === C.blush ? .24 : target > layer.weights[i] ? .075 : .17;
          layer.weights[i] += (target - layer.weights[i]) * (1 - Math.exp(-dt / tau));
          if (target === 0 && layer.weights[i] < 1e-6) layer.weights[i] = 0;
        }
        this.weights[i] = clamp(this.weights[i] + layer.weights[i]);
      }
      if (!present.has(id) && !layer.weights.some(x => x > 0)) this.layers.delete(id);
    }
    return this.weights;
  }

  reset() {
    this.weights.fill(0); this.target.fill(0); this.lastNow = null; this.layers.clear();
    this.attitude.weights.fill(0); this.attitudeTarget.fill(0); this.attitude.weight = 0;
  }
}

/** Composes a gesture overlay without mutating the face controller's base array.
 * Vowels and articulator shapes belong exclusively to speech whenever it is active.
 * `closure` is the current lip seal (0..1); closed consonants keep their seal. */
export function blendExpressionOverlay(base, overlay, { speechActivity = 0, mouthMode, closure = 0, attitude = null, out = new Float32Array(CHANNELS.length) } = {}) {
  // Legacy entries retain their previous boolean contract; new hosts explicitly
  // choose ownership. Zero energy or a missing lip object never changes the mode.
  const mode = mouthMode === undefined ? (Number(speechActivity) > 0 ? 'speech' : 'expression')
    : ['speech', 'closed', 'expression'].includes(mouthMode) ? mouthMode : 'closed';
  const speaking = mode === 'speech', seal = clamp(closure), attitudeWeight = clamp(attitude?.weight);
  for (let i = 0; i < CHANNELS.length; i++) {
    let b = clamp(base?.[i] ?? 0);
    const e = clamp(overlay?.[i] ?? 0);
    if (attitudeWeight && ATTITUDE_CHANNELS.includes(i)) {
      let goal = clamp(attitude.weights?.[i]);
      if (speaking && i === C.smile) goal *= 1 - .7 * seal;
      if (speaking && i === C.frown) goal *= 1 - .5 * seal;
      b += (goal - b) * attitudeWeight;
    }
    if (mode === 'closed' && MOUTH_SHAPE.has(i)) { out[i] = 0; continue; }
    if (speaking && MOUTH_SHAPE.has(i)) { out[i] = b; continue; }
    if (i === C.smile || i === C.frown) {
      const room = speaking ? .24 * (1 - seal) : .65;
      // Co-timed preset/gesture corners do not add the same smile twice. room
      // limits only the authored increment, not the final visible corner value.
      out[i] = clamp(b + Math.max(0, e - b) * room);
    } else out[i] = Math.max(b, e);
  }
  if (!speaking) {
    const total = VOWELS.reduce((s, i) => s + out[i], 0);
    if (total > .72) for (const i of VOWELS) out[i] *= .72 / total;
  }
  // Natural blinks retain priority; an open-eyed surprise cannot defeat a blink.
  const blink = out[C.blink];
  out[C.smileEyes] = Math.min(out[C.smileEyes], 1 - blink);
  out[C.wink] = Math.min(out[C.wink], 1 - blink);
  out[C.eyeWide] = Math.min(out[C.eyeWide], 1 - Math.max(blink, out[C.smileEyes], out[C.wink]));
  out[C.eyeHalf] = Math.min(out[C.eyeHalf], 1 - out[C.eyeWide]);
  return out;
}
