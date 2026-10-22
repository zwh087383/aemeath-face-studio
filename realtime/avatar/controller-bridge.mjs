import { createControllerSink } from '../controller-sink.mjs';
import { DEFAULT_CATALOG } from '../scheduler.mjs';
import { GESTURES, MOTION_DEFAULTS, OVERLAP } from '../../preview/core/motion-profile.js';
import { PRESETS, ACTIONS } from '../../preview/core/profile.js';

// MotionController stretches preparation/recovery by at most maxStretch and
// varies each gesture's rate by ±3%. Its removal tail is authored-time too.
// This is a speed=1 occupancy ceiling, not a prediction of a spoken-word apex.
const MIN_RATE = .97;
const REMOVE_TAIL = Math.max(...Object.values(OVERLAP.enter)) + .02;
const SAFETY_SECONDS = .05;
const bodyDuration = gesture => {
  const prepareEnd = gesture.phases.prepare[1], recoverStart = gesture.phases.recover[0];
  const stretch = MOTION_DEFAULTS.maxStretch;
  const longest = prepareEnd * stretch + (recoverStart - prepareEnd)
    + (gesture.duration + REMOVE_TAIL - recoverStart) * stretch;
  return Math.ceil((longest / MIN_RATE + SAFETY_SECONDS) * 1000) / 1000;
};

/** Preserve legacy entries/order, and expose every public authored gesture. */
export const AVATAR_CATALOG = Object.freeze(Object.fromEntries([
  ...Object.entries(DEFAULT_CATALOG),
  ...Object.entries(GESTURES).filter(([, gesture]) => !gesture.internal).map(([id, gesture]) => [
    `gesture:${id}`, Object.freeze({ duration: bodyDuration(gesture), apex: gesture.apex,
      cooldown: gesture.cooldown, slot: 'body' }),
  ]),
  ...PRESETS.filter(p => !Object.hasOwn(DEFAULT_CATALOG, `expression:${p.id}`)).map(p => [
    `expression:${p.id}`, Object.freeze({ duration: 1.8, apex: 0, cooldown: 0, slot: 'face' }),
  ]),
  ...Object.entries(ACTIONS).filter(([id]) => !Object.hasOwn(DEFAULT_CATALOG, `action:${id}`)).map(([id, action]) => [
    `action:${id}`, Object.freeze({ duration: action.duration, apex: 0, cooldown: .45, slot: 'head' }),
  ]),
]));

const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const validOwner = owner => owner && textId(owner.connectionId) && textId(owner.responseId)
  && Number.isSafeInteger(owner.epoch) && owner.epoch > 0;
const sameOwner = (a, b) => a && b && a.connectionId === b.connectionId
  && a.responseId === b.responseId && a.epoch === b.epoch;

/** Synchronous scheduler sink for the real face/body controllers.
 * The host starts audio only AFTER begin succeeds and updates both controllers
 * using the same seconds clock as command.atWall. New controllers may stay idle
 * indefinitely: construction never begins, cancels or retracts any epoch.
 *
 * A natural audio end lets MotionController finish on wall time. A later explicit
 * retract (including after ended) or a new begin must reclaim that tail as well.
 * The full connection/response/epoch tuple guards these extra cleanup operations.
 */
export function createAvatarSink({ audio, face, motion, observe, onPosture } = {}) {
  const delegate = createControllerSink({ audio, face, motion, observe, onPosture });
  motion.setOptions({ speed: 1, natural: true });
  let owner = null;
  return command => {
    if (!command || !validOwner(command.identity)
      || !Number.isFinite(command.atWall) || command.atWall < 0) return false;
    const { identity, atWall, type } = command, epoch = identity.epoch;
    try {
      // A host that has already advanced any component must not be rewound by an
      // older sink command, even if this sink has not yet observed its new begin.
      if (face.epoch > epoch || motion.epoch > epoch || audio.snapshot().epoch > epoch) return false;
      if (type === 'begin') {
        if (epoch <= Math.max(face.epoch, motion.epoch, owner?.epoch ?? 0)) return false;
        motion.setOptions({ speed: 1 });
        motion.retract(atWall);
        owner = { connectionId: identity.connectionId, responseId: identity.responseId, epoch };
        return delegate(command) === true;
      }
      if (!sameOwner(owner, identity)) return false;
      if (type === 'retract') {
        // Delegate first so cancellation selects the listening return posture.
        // Its inactive shortcut alone does not retract a naturally ended tail.
        let accepted = false;
        try { accepted = delegate(command) === true; }
        finally { if (motion.epoch === epoch) motion.retract(atWall); }
        return accepted;
      }
      if (type === 'cue') motion.setOptions({ speed: 1 });
      return delegate(command) === true;
    } catch { return false; }
  };
}
