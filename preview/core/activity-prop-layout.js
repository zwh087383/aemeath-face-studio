/** Shared activity-space dimensions. +Y is up, +Z is the character's front.
 * World props use the immutable activity-start anchor, never the moving avatar.
 * All distances are in the actual PMX model's units (height approximately 20.6).
 */
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

export const ACTIVITY_PROP_LAYOUT = freeze({
  chair: {
    position: [0, 0, -1.2], seatTop: 6.1, seatSize: [6.6, .6, 5.2],
    seatCenter: [0, 6.1, -1.2], backHeight: 12.9, backLocalZ: -2.35,
    contacts: { seat: [0, 6.1, -1.2], leftFoot: [1.15, 0, 3.3], rightFoot: [-1.15, 0, 3.3] },
  },
  table: { position: [0, 0, 4.3], top: 8.9, size: [10, .55, 5],
    contacts: { top: [0, 8.9, 4.3], writing: [-1.1, 8.94, 2.9], laptop: [0, 8.94, 3.2] } },
  book: { position: [0, 9.065, 3.3], size: [3.4, .3, 2.6], grips: { left: [1.55, .06, 0], right: [-1.55, .06, 0] } },
  mug: { position: [-3.5, 8.9, 3.2], height: 1.36, radius: .55, grip: [.95, .72, 0] },
  paper: { position: [-1.1, 8.935, 2.9], size: [2.9, .045, 2.2] },
  pencil: { position: [3.55, 9.0, 3.2], length: 1.8, grip: [0, .85, 0] },
  laptop: { position: [0, 8.94, 3.2], size: [4.25, .22, 2.8], lidHeight: 2.8 },
  platform: { position: [0, 0, 5.3], size: [7, 1.25, 4.4], top: 1.25 },
  mat: { position: [0, 0, 0], size: [8.2, .08, 13], top: .08 },
  box: { position: [0, 0, 4.1], size: [4.3, 3, 3.5], grips: { left: [2.15, 1.5, 0], right: [-2.15, 1.5, 0] } },
});

export const ACTIVITY_PROP_IDS = Object.freeze(Object.keys(ACTIVITY_PROP_LAYOUT));
export const PROP_ATTACHMENTS = Object.freeze(['floor', 'table', 'left', 'right', 'both']);
export const finiteVector = (value, length = 3) => (Array.isArray(value) || ArrayBuffer.isView(value))
  && value.length === length && Array.from(value).every(Number.isFinite);

/** Page-edge grips follow the hinged book. Near closure, contact slides toward
 * the two ends of the spine so the closed volume can still be held in both
 * hands; a closed book must not stretch its thin covers to the hand distance.
 */
export function propGripPair(id, openness = 1) {
  const pair = ACTIVITY_PROP_LAYOUT[id]?.grips;
  if (!pair) return null;
  if (id !== 'book') return { left: [...pair.left], right: [...pair.right] };
  const closure = (1 - Math.max(0, Math.min(1, openness))) * 1.5;
  const progress = Math.max(0, Math.min(1, (closure - .9) / .6)), shift = progress * progress * (3 - 2 * progress);
  const x = (1.55 * Math.cos(closure) - .06 * Math.sin(closure)) * (1 - shift);
  const y = (1.55 * Math.sin(closure) + .06 * Math.cos(closure)) * (1 - shift) + .82 * shift;
  return { left: [x, y, 1.1 * shift], right: [-x, y, -1.1 * shift] };
}

/** Prefer a measured palm anchor. Otherwise estimate the palm from real wrist
 * and first middle-finger bone positions, matching MotionRig's .45 fraction.
 * A missing hand returns null: callers must not leave a stale hovering object.
 */
export function readHandAnchor(avatar, side) {
  const direct = avatar?.anchors?.[`${side}Hand`];
  if (finiteVector(direct)) return { position: Array.from(direct), quaternion: [0, 0, 0, 1], measured: true };
  if (finiteVector(direct?.position)) return { position: Array.from(direct.position),
    quaternion: finiteVector(direct.quaternion ?? direct.rotation, 4) ? Array.from(direct.quaternion ?? direct.rotation) : [0, 0, 0, 1], measured: true };
  const bones = avatar?.bones ?? {}, wrist = bones[`${side}Wrist`];
  if (!finiteVector(wrist)) return null;
  const middle = bones[`${side}Middle`] ?? bones[`${side}Middle1`];
  const position = finiteVector(middle) ? wrist.map((n, i) => n + .45 * (middle[i] - n)) : Array.from(wrist);
  const quaternion = avatar?.rotations?.[`${side}Wrist`];
  return { position, quaternion: finiteVector(quaternion, 4) ? Array.from(quaternion) : [0, 0, 0, 1], measured: finiteVector(middle) };
}

export function normalizePropState(value, id) {
  if (!ACTIVITY_PROP_LAYOUT[id]) return { visible: false, attachment: 'floor' };
  const state = value === true ? { visible: true } : value && typeof value === 'object' ? value : {};
  const defaultAttachment = ['book', 'mug', 'paper', 'pencil', 'laptop'].includes(id) ? 'table' : 'floor';
  const attachment = state.attachment ?? defaultAttachment;
  return { ...state, visible: value === true || (value !== false && state.visible === true),
    attachment, validAttachment: PROP_ATTACHMENTS.includes(attachment),
    openness: Math.max(0, Math.min(1, Number.isFinite(state.openness) ? state.openness : 1)),
    pageTurn: Math.max(0, Math.min(1, Number.isFinite(state.pageTurn) ? state.pageTurn : 0)) };
}
