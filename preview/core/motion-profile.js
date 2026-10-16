// Body-motion data for Aemeath, kept in one place for pose/timing tuning.
//
// Arm poses are authored in a mirrored "side space" [out, up, forward]: `out` is
// lateral distance away from the body midline, so the same numbers mean the same
// thing for both arms. Positions are bind-pose model units (Aemeath is ~20.5 tall;
// the shoulder joint sits near [1.25, 16.19, -0.84], chest front z ~1.26 at y 15).
// `hand` is the wrist target unless `anchor: 'palm'`, which targets the palm surface.

const finger = (prefix, name, count) => Array.from({ length: count }, (_, i) => `${prefix}${name}${'０１２３'[i + (name === '親指' ? 0 : 1)]}`);
const sideNames = prefix => ({
  shoulder: `${prefix}肩`, arm: `${prefix}腕`, armTwist: `${prefix}腕捩`, elbow: `${prefix}ひじ`,
  handTwist: `${prefix}手捩`, wrist: `${prefix}手首`,
  fingers: {
    thumb: [...finger(prefix, '親指', 3), `${prefix}親指２先`],
    index: [...finger(prefix, '人指', 3), `${prefix}人指３先`],
    middle: [...finger(prefix, '中指', 3), `${prefix}中指３先`],
    ring: [...finger(prefix, '薬指', 3), `${prefix}薬指３先`],
    pinky: [...finger(prefix, '小指', 3), `${prefix}小指３先`],
  },
  tips: { thumb: `${prefix}親指２先`, index: `${prefix}人指３先`, middle: `${prefix}中指３先`, ring: `${prefix}薬指３先`, pinky: `${prefix}小指３先` },
});

/** Bones driven by the motion layer. Twist helpers (捩1-3), shoulder adjusters,
 * 肩C and the individual eyes follow through the model's own grant constraints. */
export const AEMEATH_MOTION_BINDING = Object.freeze({
  torso: { spine: '上半身', chest: '上半身2', upperChest: '上半身1', neck: '首', head: '頭', eyes: '両目' },
  sides: { L: { sign: 1, names: sideNames('左') }, R: { sign: -1, names: sideNames('右') } },
});

const arm = spec => ({ shrug: 0, protract: 0, curl: .3, thumb: .25, spread: .1, anchor: 'wrist', ...spec });

export const POSTURES = Object.freeze({
  relaxed: {
    name: '放松', note: '肩膀落下，手臂自然垂在身侧',
    body: { lean: 0, twist: 0, side: 0, headPitch: 0, headYaw: 0, headRoll: 0, neckForward: 0, gazePitch: 0 },
    // Wrists sit outside the flared skirt; palms face the thigh and slightly back.
    L: arm({ hand: [2.95, 11.2, -.3], pole: [.35, -.15, -1], palm: [-.8, 0, -.6], point: [.2, -1, .05], shrug: -.03, protract: .015, curl: .24, thumb: .22 }),
    R: arm({ hand: [2.92, 11.26, -.26], pole: [.35, -.15, -1], palm: [-.82, 0, -.56], point: [.18, -1, .07], shrug: -.025, protract: .02, curl: .23, thumb: .2 }),
  },
  listening: {
    name: '倾听', note: '略微前倾，目光与头颈朝向你',
    body: { lean: .045, twist: .012, side: -.008, headPitch: .02, headYaw: 0, headRoll: .055, neckForward: .045, gazePitch: 0 },
    // Hands loosely in front of the skirt, not touching; elbows out so the sleeves clear the ribbons.
    L: arm({ hand: [1.55, 12.2, 1.45], pole: [.8, -.5, -.45], palm: [-.72, .12, -.68], point: [-.38, -1, .22], shrug: -.015, protract: .05, curl: .36, thumb: .3 }),
    R: arm({ hand: [1.42, 12.08, 1.52], pole: [.8, -.5, -.45], palm: [-.74, .1, -.66], point: [-.36, -1, .25], shrug: -.01, protract: .055, curl: .33, thumb: .28 }),
  },
  speaking: {
    name: '说话', note: '上身打开，手在身前留出说话空间',
    body: { lean: .015, twist: -.01, side: 0, headPitch: -.005, headYaw: 0, headRoll: 0, neckForward: .01, gazePitch: 0 },
    L: arm({ hand: [2.12, 12.72, 1.45], pole: [.5, -.45, -1], palm: [-.78, .5, .05], point: [-.12, -.08, 1], shrug: 0, protract: -.015, curl: .28, thumb: .2, spread: .15 }),
    R: arm({ hand: [2.02, 13.02, 1.78], pole: [.5, -.45, -1], palm: [-.72, .58, .08], point: [-.1, -.02, 1], shrug: .005, protract: -.02, curl: .24, thumb: .18, spread: .2 }),
  },
});

// Gestures. Keys are [time, pose] on the gesture's own clock; `stop` marks keys where
// motion intentionally pauses (zero velocity). Other keys pass through with velocity.
// Phases document the prepare/stroke/hold/recover structure; `apex` is the stressed
// moment to align with speech; `recover` is the interrupt retraction time.
export const GESTURES = Object.freeze({
  explain: {
    name: '摊手解释', tracks: ['R', 'L', 'body'], duration: 2.45, apex: .66, recover: .55, cooldown: 1.2,
    phases: { prepare: [0, .5], stroke: [.5, .78], hold: [.78, 1.7], recover: [1.7, 2.45] },
    keys: {
      R: [
        [0, arm({ hand: [2.18, 12.95, 1.45], pole: [.5, -.5, -1], palm: [-.8, .5, .15], point: [.05, 0, 1], curl: .26 })],
        [.5, arm({ hand: [2.3, 13.72, 2.12], pole: [.45, -.6, -1], palm: [-.38, 1, .18], point: [.32, .12, 1], curl: .16, spread: .3, thumb: .05 })],
        [.66, arm({ hand: [2.52, 13.86, 2.2], pole: [.5, -.6, -1], palm: [-.05, 1, .25], point: [.58, .12, 1], curl: .13, spread: .38, thumb: 0, shrug: .02 }), 'stop'],
        [1.2, arm({ hand: [2.47, 13.8, 2.15], pole: [.5, -.6, -1], palm: [-.1, 1, .22], point: [.55, .1, 1], curl: .15, spread: .34, thumb: .02, shrug: .012 })],
        [1.7, arm({ hand: [2.42, 13.74, 2.08], pole: [.5, -.6, -1], palm: [-.16, 1, .2], point: [.5, .08, 1], curl: .17, spread: .3, thumb: .04 }), 'stop'],
      ],
      L: [
        [0, arm({ hand: [2.2, 12.6, 1.3], pole: [.7, -.5, -.55], palm: [-.8, .45, .05], point: [-.1, -.1, 1], curl: .3 })],
        [.62, arm({ hand: [2.42, 12.9, 1.42], pole: [.7, -.55, -.5], palm: [-.55, .75, .12], point: [.1, -.05, 1], curl: .24, spread: .2, thumb: .12 }), 'stop'],
        [1.7, arm({ hand: [2.38, 12.84, 1.38], pole: [.7, -.55, -.5], palm: [-.6, .7, .1], point: [.08, -.06, 1], curl: .25, spread: .18, thumb: .14 }), 'stop'],
      ],
      body: [
        [0, { lean: 0, twist: 0, side: 0, headPitch: 0, headYaw: 0, headRoll: 0 }],
        [.66, { lean: .022, twist: -.025, side: -.006, headPitch: -.01, headYaw: -.015, headRoll: .03 }, 'stop'],
        [1.7, { lean: .018, twist: -.02, side: -.005, headPitch: -.008, headYaw: -.012, headRoll: .028 }, 'stop'],
      ],
    },
  },
  wave: {
    name: '挥手', tracks: ['R', 'body'], duration: 2.65, apex: .82, recover: .6, cooldown: 1.5,
    // Raising the hand overhead folds the elbow first instead of swinging a straight arm out.
    arc: { tuck: .3, out: .55 },
    phases: { prepare: [0, .56], stroke: [.56, 1.72], hold: [1.72, 1.95], recover: [1.95, 2.65] },
    keys: {
      R: [
        [0, arm({ hand: [2.35, 13.6, 1.05], pole: [.8, -.55, -.55], palm: [-.85, .2, .4], point: [.15, .2, 1], curl: .28 })],
        // Elbow flexes first: the hand passes in front of the shoulder with the forearm
        // rising, never aimed backwards and never reaching out on a straight arm.
        [.32, arm({ hand: [3.4, 15.4, 1.3], pole: [.9, -.6, .2], palm: [-.4, .2, .9], point: [.1, .85, .5], curl: .2, spread: .25, shrug: .03 })],
        // Forearm near vertical with the elbow out and slightly forward; the wave pivots at the elbow.
        [.56, arm({ hand: [3.8, 18.2, 1.0], pole: [.9, -.5, .45], palm: [.02, .05, 1], point: [0, 1, .06], curl: .12, spread: .42, thumb: .06, shrug: .055 })],
        [.82, arm({ hand: [4.1, 18.14, 1.0], pole: [.9, -.5, .45], palm: [.08, .05, 1], point: [.4, 1, .06], curl: .1, spread: .45, thumb: .05, shrug: .055 })],
        [1.08, arm({ hand: [3.5, 18.14, 1.0], pole: [.9, -.5, .45], palm: [-.06, .05, 1], point: [-.4, 1, .06], curl: .12, spread: .42, thumb: .06, shrug: .055 })],
        [1.34, arm({ hand: [4.1, 18.14, 1.0], pole: [.9, -.5, .45], palm: [.08, .05, 1], point: [.4, 1, .06], curl: .1, spread: .45, thumb: .05, shrug: .055 })],
        [1.58, arm({ hand: [3.56, 18.15, 1.0], pole: [.9, -.5, .45], palm: [-.04, .05, 1], point: [-.32, 1, .06], curl: .12, spread: .42, thumb: .06, shrug: .055 })],
        [1.72, arm({ hand: [3.86, 18.19, 1.0], pole: [.9, -.5, .45], palm: [.02, .05, 1], point: [.08, 1, .06], curl: .14, spread: .38, thumb: .08, shrug: .05 }), 'stop'],
        [1.95, arm({ hand: [3.83, 18.12, 1.0], pole: [.9, -.5, .45], palm: [0, .05, 1], point: [.04, 1, .06], curl: .18, spread: .32, thumb: .1, shrug: .045 }), 'stop'],
        // Lowering retraces the raise path while the weight fades.
        [2.35, arm({ hand: [3.4, 15.4, 1.3], pole: [.9, -.6, .2], palm: [-.4, .2, .9], point: [.1, .85, .5], curl: .22, spread: .2, shrug: .02 }), 'stop'],
      ],
      body: [
        [0, { lean: 0, twist: 0, side: 0, headPitch: 0, headYaw: 0, headRoll: 0 }],
        [.56, { lean: .01, twist: -.02, side: .014, headPitch: -.012, headYaw: -.02, headRoll: -.035 }],
        [1.72, { lean: .01, twist: -.018, side: .012, headPitch: -.01, headYaw: -.018, headRoll: -.032 }, 'stop'],
        [1.95, { lean: .008, twist: -.015, side: .01, headPitch: -.008, headYaw: -.015, headRoll: -.028 }, 'stop'],
      ],
    },
  },
  shrug: {
    name: '轻耸肩', tracks: ['R', 'L', 'body'], duration: 1.6, apex: .44, recover: .45, cooldown: 1.2,
    phases: { prepare: [0, .36], stroke: [.36, .56], hold: [.56, .86], recover: [.86, 1.6] },
    keys: {
      ...Object.fromEntries(['R', 'L'].map((side, i) => [side, [
        [0, arm({ hand: [2.4, 12.4, .9], pole: [.5, -1, -.2], palm: [-.8, .3, .2], point: [.15, -.4, 1], curl: .28, shrug: .02 })],
        [.44, arm({ hand: [2.78 - i * .06, 12.62 - i * .05, 1.36], pole: [.55, -1, -.1], palm: [.12, .92, .42], point: [.72, .05, .72], curl: .13, spread: .34, thumb: .04, shrug: .135 - i * .01 }), 'stop'],
        [.7, arm({ hand: [2.74 - i * .06, 12.56 - i * .05, 1.32], pole: [.55, -1, -.1], palm: [.08, .9, .4], point: [.7, .02, .72], curl: .15, spread: .3, thumb: .06, shrug: .1 - i * .008 })],
        [.86, arm({ hand: [2.7 - i * .06, 12.5 - i * .05, 1.28], pole: [.55, -1, -.1], palm: [.02, .88, .36], point: [.68, 0, .72], curl: .17, spread: .28, thumb: .08, shrug: .085 - i * .006 }), 'stop'],
      ]])),
      // The head tilts slightly but is not carried up with the shoulders.
      body: [
        [0, { lean: 0, twist: 0, side: 0, headPitch: 0, headYaw: 0, headRoll: 0 }],
        [.44, { lean: -.012, twist: 0, side: 0, headPitch: -.012, headYaw: .01, headRoll: .045 }, 'stop'],
        [.86, { lean: -.008, twist: 0, side: 0, headPitch: -.006, headYaw: .008, headRoll: .038 }, 'stop'],
      ],
    },
  },
  chest: {
    name: '手放胸前', tracks: ['R', 'body'], duration: 2.8, apex: .72, recover: .65, cooldown: 1.5,
    phases: { prepare: [0, .64], stroke: [.64, .86], hold: [.86, 2.02], recover: [2.02, 2.8] },
    keys: {
      R: [
        [0, arm({ hand: [2.2, 13.2, 1.7], pole: [.6, -.7, -.6], palm: [-.8, .3, .4], point: [-.1, .1, 1], curl: .26 })],
        [.34, arm({ hand: [1.12, 14.75, 2.05], anchor: 'palm', pole: [.75, -.85, -.25], palm: [-.25, -.05, -1], point: [-1, .32, -.05], curl: .14, thumb: .14, spread: -.1 })],
        // Elbow held out and forward so the forearm passes in front of the bust.
        [.72, arm({ hand: [-.1, 15.7, 1.48], anchor: 'palm', pole: [.9, -.7, .35], palm: [.02, -.08, -1], point: [-1, .55, -.02], curl: .1, thumb: .16, spread: -.24 }), 'stop'],
        [1.4, arm({ hand: [-.08, 15.66, 1.49], anchor: 'palm', pole: [.9, -.7, .35], palm: [.02, -.1, -1], point: [-1, .5, -.02], curl: .12, thumb: .17, spread: -.24 })],
        [2.02, arm({ hand: [-.06, 15.68, 1.5], anchor: 'palm', pole: [.9, -.7, .35], palm: [.02, -.08, -1], point: [-1, .55, -.02], curl: .12, thumb: .16, spread: -.22 }), 'stop'],
      ],
      body: [
        [0, { lean: 0, twist: 0, side: 0, headPitch: 0, headYaw: 0, headRoll: 0 }],
        [.72, { lean: .02, twist: .02, side: 0, headPitch: .035, headYaw: .01, headRoll: .025 }, 'stop'],
        [2.02, { lean: .018, twist: .018, side: 0, headPitch: .03, headYaw: .008, headRoll: .022 }, 'stop'],
      ],
    },
  },
  // Small speech beat on top of the speaking posture; additive offsets only.
  beat: {
    name: '语气', tracks: ['R'], duration: .95, apex: .34, recover: .3, cooldown: 2.2, additive: true, internal: true,
    phases: { prepare: [0, .28], stroke: [.28, .44], hold: [.44, .55], recover: [.55, .95] },
    keys: {
      R: [
        [0, { hand: [0, 0, 0], palm: [0, 0, 0], point: [0, 0, 0], curl: 0 }],
        [.34, { hand: [.1, .2, .16], palm: [.12, .45, 0], point: [.08, .12, 0], curl: -.06 }, 'stop'],
        [.55, { hand: [.08, .16, .13], palm: [.1, .38, 0], point: [.06, .1, 0], curl: -.05 }, 'stop'],
      ],
    },
  },
});

export const GESTURE_IDS = Object.freeze(Object.keys(GESTURES).filter(id => !GESTURES[id].internal));

/** Time offsets (s) per parameter group: shoulders lead, hand orientation and
 * fingers follow through. Recovery relaxes the fingers first. */
export const OVERLAP = Object.freeze({
  enter: { shoulder: -.05, position: 0, orientation: .06, fingers: .1 },
  recover: { fingers: 0, orientation: .03, position: .05, shoulder: .08 },
});

export const MOTION_DEFAULTS = Object.freeze({
  postureTransition: .9,
  lateTolerance: .25,
  breathPeriod: 4.3,
  breath: { chest: .009, upperChest: .006, shoulder: .012 },
  micro: { headYaw: .009, headPitch: .006, bodySide: .0035 },
  beatGap: .32, beatCooldown: 2.2,
  head: { pitch: [-.26, .26], yaw: [-.36, .36], roll: [-.22, .22], neckShare: .38, chestYawShare: .12 },
  eyes: { yaw: .24, pitch: .14, vor: .72, glanceLead: 1.45 },
  springs: { gaze: 26, head: 11, neck: 8, chest: 5 },
  // Hand paths bow outward/forward in proportion to travel, clearing torso and skirt;
  // capped so long paths (raising a hand overhead) do not swing out to a straight arm.
  // tuck: fraction of the way toward the shoulder at mid-transfer for paths of at least
  // tuckTravel units (shorter paths tuck proportionally less). Off by default: drawing
  // the hand toward the shoulder brings paths in front of the chest into the bust; a
  // gesture may override any arc field (the wave folds its elbow to raise the hand).
  arc: { gain: .24, max: .8, out: .9, forward: .8, tuck: 0, tuckTravel: 5 },
  // Average wrist speed (model units/s; 1 unit is about 8 cm, so 6 is about 0.5 m/s)
  // for prepare and recover travel, and for interrupt retraction. Eased phases peak at
  // roughly twice the average. A hand with farther to go takes longer, up to
  // maxStretch times the authored phase.
  travelSpeed: 6, retractSpeed: 8, maxStretch: 2,
});

/** Demo alignment against the bundled Chinese sentence (voiced phrases measured from
 * the lip track): 热水 ~3.9 s, 嗯 ~5.4 s, 好吧 7.85-8.28 s, closing vowels end ~13.7 s.
 * This is local timeline alignment only, not word-level timing from a live TTS. */
export const MOTION_DEMO = Object.freeze([
  { id: 'explain-hot-water', gesture: 'explain', apexAt: 3.92 },
  { id: 'chest-thinking', gesture: 'chest', apexAt: 5.45 },
  { id: 'shrug-okay', gesture: 'shrug', apexAt: 8.02 },
  { id: 'wave-goodbye', gesture: 'wave', apexAt: 13.95 },
]);
