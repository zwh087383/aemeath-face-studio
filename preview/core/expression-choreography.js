import { CHANNELS, C, VOWELS } from './profile.js';
import { GESTURES } from './motion-profile.js';

const clamp = x => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const smooth = x => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
const MOUTH_SHAPE = new Set([...VOWELS, C.mouthWide, C.mouthNarrow, C.mouthFlat]);

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
  }

  update(now, gestures = [], { paused = false } = {}) {
    if (!Number.isFinite(now)) return this.weights;
    const dt = this.lastNow === null ? 0 : Math.max(0, Math.min(.1, now - this.lastNow));
    this.lastNow = Number.isFinite(now) ? now : this.lastNow;
    // Frozen audio gestures retain their exact displayed face. Retraction uses the
    // local clock and must remain live even if the transport was paused/cancelled.
    if (paused && !gestures.some(g => g.recovering)) return this.weights;
    this.target.fill(0);
    let sum = 0;
    for (const g of gestures) {
      if (!GESTURES[g.gesture]?.expression) continue;
      const gain = clamp(g.expressionWeight ?? g.strength ?? 1);
      sampleGestureExpression(g.gesture, g.age, 1, this.sample);
      for (let i = 0; i < CHANNELS.length; i++) this.target[i] += this.sample[i] * gain;
      sum += gain;
    }
    // Normalize overlapping performances: a handoff should not double the face.
    if (sum > 1) for (let i = 0; i < CHANNELS.length; i++) this.target[i] /= sum;
    for (let i = 0; i < CHANNELS.length; i++) {
      const tau = i === C.blink ? .025 : i === C.blush ? .24 : this.target[i] > this.weights[i] ? .075 : .17;
      this.weights[i] += (this.target[i] - this.weights[i]) * (1 - Math.exp(-dt / tau));
      if (this.target[i] === 0 && this.weights[i] < 1e-6) this.weights[i] = 0;
    }
    return this.weights;
  }

  reset() { this.weights.fill(0); this.target.fill(0); this.lastNow = null; }
}

/** Composes a gesture overlay without mutating the face controller's base array.
 * Vowels and articulator shapes belong exclusively to speech whenever it is active.
 * `closure` is the current lip seal (0..1); closed consonants keep their seal. */
export function blendExpressionOverlay(base, overlay, { speechActivity = 0, closure = 0, out = new Float32Array(CHANNELS.length) } = {}) {
  const speaking = Number(speechActivity) > 0, seal = clamp(closure);
  for (let i = 0; i < CHANNELS.length; i++) {
    const b = clamp(base?.[i] ?? 0), e = clamp(overlay?.[i] ?? 0);
    if (speaking && MOUTH_SHAPE.has(i)) { out[i] = b; continue; }
    if (i === C.smile || i === C.frown) {
      const room = speaking ? .24 * (1 - seal) : .65;
      out[i] = Math.max(b, Math.min(.75, b + e * room));
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
