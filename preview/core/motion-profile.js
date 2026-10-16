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
const LEGACY_GESTURES = Object.freeze({
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

// Expanded performance vocabulary is defined below.

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


// Complete performances: intention precedes the hand stroke, eyes lead the head,
// and torso/head settle on different keys. Arms remain in mirrored authoring space.
// Amplitudes are deliberately readable at conversational camera distance.
const B = spec => ({ lean: 0, twist: 0, side: 0, headPitch: 0, headYaw: 0, headRoll: 0,
  neckForward: 0, gazePitch: 0, gazeYaw: 0, pelvisPitch: 0, pelvisRoll: 0, hipShift: 0, ...spec });
const bodyKeys = keys => keys.map(([t, p, stop]) => [t, B(p), stop]);
const pose = (base, spec = {}) => arm({ ...base, ...spec });
const lowR = POSTURES.listening.R, lowL = POSTURES.listening.L;
const openR = LEGACY_GESTURES.explain.keys.R[2][1], openL = LEGACY_GESTURES.explain.keys.L[1][1];
const heart = LEGACY_GESTURES.chest.keys.R[2][1];
const faceTrack = (duration, keys) => ({ keys: [[0, {}], ...keys, [duration, {}]] });
const performance = (name, note, duration, apex, endHold, keys, expression, extra = {}) => ({
  name, note, duration, apex, recover: .7, cooldown: 1.3, tracks: ['body', 'R', 'L'],
  phases: { prepare: [0, apex * .7], stroke: [apex * .7, apex + .2], hold: [apex + .2, endHold], recover: [endHold, duration] },
  keys: { ...keys, body: bodyKeys(keys.body) }, expression: faceTrack(duration, expression), ...extra,
});
const EXPRESSIVE_GESTURES = {
  bow_smile: performance('俯身抬眼微笑', '腰背先俯近，抬眼看你，笑意随后展开', 3.8, 1.05, 2.65, {
    body: [[0, {}], [.22, { lean: -.025, headPitch: .025, gazePitch: -.07 }],
      [.72, { lean: .25, pelvisPitch: -.055, headPitch: .035, neckForward: .045, hipShift: -.07 }],
      [1.15, { lean: .34, pelvisPitch: -.07, headPitch: -.11, headRoll: .045, gazePitch: -.1, neckForward: .07 }, 'stop'],
      [2.35, { lean: .29, pelvisPitch: -.06, headPitch: -.075, headRoll: .035, gazePitch: -.06 }, 'stop'],
      [3.1, { lean: .12, headPitch: -.03, headRoll: .015 }]],
    R: [[0, lowR], [.75, pose(lowR, { hand: [2.05, 12.42, 2.1], curl: .38, protract: .1 })], [1.3, pose(lowR, { hand: [2.15, 12.5, 2.2], curl: .25, spread: .14 }), 'stop'], [2.65, pose(lowR, { hand: [2.1, 12.42, 2.15], curl: .29 }), 'stop']],
    L: [[0, lowL], [.9, pose(lowL, { hand: [2.15, 12.22, 2.1], curl: .4, protract: .075 })], [1.5, pose(lowL, { hand: [2.2, 12.3, 2.2], curl: .3, thumb: .24 }), 'stop'], [2.65, lowL, 'stop']],
  }, [[.45, { browSmile: .14 }], [1.18, { browSmile: .36, eyeSmile: .32, smile: .62 }], [2.45, { browSmile: .28, eyeSmile: .26, smile: .5 }]]),
  laugh: performance('开心轻笑', '吸气抬胸，眼睛先弯，一次轻笑带动肩背', 3.4, .98, 2.35, {
    body: [[0, {}], [.3, { lean: -.065, headPitch: -.045, pelvisPitch: .025 }], [.82, { lean: .075, headPitch: .055, side: -.035, headRoll: .045 }],
      [1.18, { lean: .12, headPitch: .075, side: -.045, headRoll: .06 }, 'stop'], [1.62, { lean: .025, headPitch: -.04, side: -.02 }],
      [2.35, { lean: .035, headPitch: -.01, headRoll: .02 }, 'stop']],
    R: [[0, lowR], [.7, pose(heart, { hand: [.32, 15.28, 1.78], curl: .24, spread: -.08, shrug: .055 })], [1.22, pose(heart, { hand: [.24, 15.45, 1.8], curl: .2, shrug: .075 }), 'stop'], [2.35, pose(heart, { hand: [.4, 15.2, 1.8], curl: .26, shrug: .01 }), 'stop']],
    L: [[0, lowL], [.9, pose(lowL, { hand: [1.8, 12.65, 1.8], shrug: .065, curl: .4 })], [1.4, pose(lowL, { hand: [1.9, 12.5, 1.75], shrug: .035, curl: .3 })], [2.35, lowL, 'stop']],
  }, [[.38, { browSmile: .3, eyeSmile: .35, smile: .25 }], [.95, { browSmile: .58, smileEyes: .78, smile: .8, a: .22 }], [1.55, { browSmile: .5, smileEyes: .6, smile: .7, a: .12 }], [2.4, { browSmile: .25, eyeSmile: .25, smile: .45 }]]),
  curious: performance('好奇探身', '目光先发现，侧头探近，掌心迟一点打开', 3.65, 1.12, 2.6, {
    body: [[0, {}], [.2, { gazeYaw: -.12, gazePitch: -.04 }], [.52, { headYaw: -.09, headRoll: -.09, lean: .055 }],
      [1.12, { lean: .24, twist: -.055, side: -.035, headYaw: -.08, headRoll: -.13, neckForward: .075, gazeYaw: -.1, pelvisPitch: -.05 }, 'stop'],
      [2.1, { lean: .21, twist: -.035, headYaw: -.035, headRoll: -.09, gazeYaw: 0, neckForward: .06 }], [2.6, { lean: .17, headRoll: -.055 }, 'stop']],
    R: [[0, lowR], [.8, pose(openR, { hand: [2.15, 13.5, 2.05], curl: .24, spread: .15 })], [1.4, pose(openR, { hand: [2.4, 13.75, 2.25], curl: .16, spread: .27 }), 'stop'], [2.6, pose(openR, { hand: [2.28, 13.5, 2.05], curl: .24 }), 'stop']],
    L: [[0, lowL], [.6, pose(lowL, { hand: [1.78, 12.35, 1.7], curl: .42 })], [1.3, pose(lowL, { hand: [1.9, 12.5, 1.8], curl: .32, shrug: .035 }), 'stop'], [2.6, lowL, 'stop']],
  }, [[.22, { browUp: .24, eyeWide: .18 }], [.95, { browUp: .4, browAsym: .28, eyeWide: .3, smile: .16, o: .08 }], [2.4, { browAsym: .2, eyeWide: .12, smile: .28 }]]),
  shy: performance('害羞回望', '缩肩低眼躲开，停一拍，再偷看回来', 4.3, 1.12, 3.25, {
    body: [[0, {}], [.22, { gazeYaw: .17, gazePitch: .075 }], [.7, { lean: -.045, twist: .065, headYaw: .15, headPitch: .11, headRoll: -.075, pelvisRoll: -.025, hipShift: -.12 }],
      [1.12, { lean: .045, twist: .08, headYaw: .2, headPitch: .13, headRoll: -.1, gazeYaw: .13, gazePitch: .08 }, 'stop'],
      [2.2, { lean: .035, twist: .065, headYaw: .16, headPitch: .1, headRoll: -.08, gazeYaw: -.11 }],
      [2.75, { lean: .08, twist: .025, headYaw: .025, headPitch: .025, headRoll: -.055, gazeYaw: 0 }, 'stop'], [3.25, { lean: .065, headRoll: -.04 }, 'stop']],
    R: [[0, lowR], [.85, pose(heart, { hand: [.75, 14.8, 1.95], curl: .38, thumb: .3, spread: -.16, shrug: .055 })], [1.4, pose(heart, { hand: [.68, 15, 1.95], curl: .35, shrug: .055 }), 'stop'], [3.25, pose(heart, { hand: [.9, 14.6, 2], curl: .27, shrug: .02 }), 'stop']],
    L: [[0, lowL], [1.05, pose(lowL, { hand: [1.55, 12.65, 1.8], curl: .49, thumb: .38, shrug: .065 }), 'stop'], [2.65, pose(lowL, { hand: [1.7, 12.5, 1.75], curl: .35, shrug: .015 })], [3.25, lowL, 'stop']],
  }, [[.4, { browSad: .2, eyeDroop: .18, smile: .22, blush: .2 }], [1.2, { browSad: .32, eyeHalf: .25, eyeDroop: .22, smile: .38, blush: .7 }], [2.4, { browSad: .18, eyeSmile: .2, smile: .43, blush: .62 }], [3.25, { browSmile: .22, eyeSmile: .25, smile: .5, blush: .4 }]]),
  explain_firm: performance('郑重点明', '先收势思量，打开双手，点头落在重点上', 3.65, 1.12, 2.55, {
    body: [[0, {}], [.28, { lean: -.025, headPitch: -.035, gazePitch: -.025 }], [.8, { lean: .085, twist: -.045, headPitch: -.035, pelvisPitch: -.025 }],
      [1.14, { lean: .13, twist: -.06, headPitch: .13, gazePitch: 0 }, 'stop'], [1.6, { lean: .09, twist: -.035, headPitch: -.025 }], [2.55, { lean: .065, headPitch: .015 }, 'stop']],
    R: [[0, lowR], [.6, pose(openR, { hand: [2.05, 13.4, 2], curl: .25, spread: .12 })], [1.15, pose(openR, { hand: [2.65, 14.15, 2.4], curl: .13, spread: .28 }), 'stop'], [2.55, pose(openR, { hand: [2.5, 13.8, 2.2], curl: .19 }), 'stop']],
    L: [[0, lowL], [.85, pose(openL, { hand: [2.1, 13.2, 1.9], curl: .24 })], [1.35, pose(openL, { hand: [2.5, 13.55, 2], curl: .18, spread: .22 }), 'stop'], [2.55, pose(openL, { hand: [2.3, 13.3, 1.8], curl: .25 }), 'stop']],
  }, [[.4, { browFocus: .26 }], [1.1, { browFocus: .42, eyeSharp: .18, mouthFlat: .14 }], [1.85, { browFocus: .24, browSmile: .12, smile: .25 }], [2.6, { browSmile: .18, eyeSmile: .12, smile: .3 }]]),
  surprise: performance('惊讶回神', '眼睛先睁大，胸肩后撤，呼气后重新靠近', 3.55, .72, 2.5, {
    body: [[0, {}], [.18, { gazePitch: -.04, headPitch: -.025 }], [.72, { lean: -.13, headPitch: -.11, headRoll: .04, pelvisPitch: .045, neckForward: -.025 }, 'stop'],
      [1.5, { lean: -.055, headPitch: -.025 }], [2.15, { lean: .085, headPitch: .035, neckForward: .035 }, 'stop'], [2.5, { lean: .055, headPitch: .01 }, 'stop']],
    R: [[0, lowR], [.7, pose(openR, { hand: [2.35, 14.5, 2.2], curl: .12, spread: .3, shrug: .09 }), 'stop'], [1.6, pose(openR, { hand: [2.5, 13.8, 2.1], curl: .22, shrug: .02 })], [2.5, pose(openR, { hand: [2.2, 13.4, 1.95], curl: .28 }), 'stop']],
    L: [[0, lowL], [.82, pose(openL, { hand: [2.45, 13.6, 1.9], curl: .14, spread: .28, shrug: .075 }), 'stop'], [1.8, pose(openL, { hand: [2.2, 13.1, 1.8], curl: .26 })], [2.5, lowL, 'stop']],
  }, [[.24, { browUp: .65, eyeWide: .68, o: .24 }], [.75, { browUp: .7, eyeWide: .72, pupilSmall: .12, o: .28 }], [1.65, { browUp: .26, eyeWide: .2, smile: .13 }], [2.5, { browSmile: .2, eyeSmile: .2, smile: .32 }]]),
  think: performance('凝神思考', '视线飘向上方，手收近胸，想明白后回到你', 4.2, 1.3, 3.1, {
    body: [[0, {}], [.22, { gazeYaw: -.14, gazePitch: -.11 }], [.72, { headYaw: -.1, headPitch: -.07, headRoll: .07, side: .025 }],
      [1.3, { lean: -.025, twist: -.04, headYaw: -.13, headPitch: -.09, headRoll: .09, gazeYaw: -.1, gazePitch: -.1, hipShift: .12 }, 'stop'],
      [2.5, { lean: 0, twist: -.025, headYaw: -.08, headPitch: -.045, headRoll: .06, gazeYaw: 0, gazePitch: 0 }], [3.1, { lean: .065, headPitch: .035, headRoll: .02 }, 'stop']],
    R: [[0, lowR], [.95, pose(heart, { hand: [.75, 15.1, 2.05], curl: .36, thumb: .25, spread: -.12 })], [1.5, pose(heart, { hand: [.65, 15.3, 2.05], curl: .29 }), 'stop'], [3.1, pose(heart, { hand: [.9, 14.9, 2.05], curl: .24 }), 'stop']],
    L: [[0, lowL], [1.12, pose(openL, { hand: [1.7, 12.85, 1.9], curl: .42, shrug: -.025 }), 'stop'], [2.8, pose(openL, { hand: [1.8, 12.7, 1.85], curl: .3 })], [3.1, lowL, 'stop']],
  }, [[.28, { browFocus: .22, browAsym: .2, eyeHalf: .1 }], [1.3, { browFocus: .33, browAsym: .3, eyeHalf: .15, mouthFlat: .12 }], [2.6, { browUp: .14, browSmile: .17, smile: .24 }], [3.2, { browSmile: .25, eyeSmile: .19, smile: .36 }]]),
  greet: performance('轻快招呼', '先认出你，微微前迎，掌心打开只挥一回', 3.25, .95, 2.25, {
    body: [[0, {}], [.18, { gazeYaw: -.1, gazePitch: -.035 }], [.55, { lean: .055, headYaw: -.055, headRoll: -.04, side: .025 }],
      [.95, { lean: .11, twist: -.045, headPitch: -.035, headYaw: -.02, headRoll: -.075, pelvisRoll: -.025, hipShift: -.09 }, 'stop'], [1.6, { lean: .075, headPitch: .045, headRoll: -.045 }], [2.25, { lean: .04, headRoll: -.025 }, 'stop']],
    R: [[0, lowR], [.5, LEGACY_GESTURES.wave.keys.R[1][1]], [.95, pose(LEGACY_GESTURES.wave.keys.R[2][1], { hand: [3.75, 17.65, 1.3], shrug: .045 }), 'stop'], [1.35, pose(LEGACY_GESTURES.wave.keys.R[3][1], { hand: [4.05, 17.6, 1.3], shrug: .04 })], [1.75, pose(LEGACY_GESTURES.wave.keys.R[4][1], { hand: [3.65, 17.65, 1.3], shrug: .035 }), 'stop'], [2.25, pose(LEGACY_GESTURES.wave.keys.R[2][1], { hand: [3.75, 17.55, 1.3], shrug: .025 }), 'stop'], [2.9, LEGACY_GESTURES.wave.keys.R[1][1], 'stop']],
    L: [[0, lowL], [.8, pose(openL, { hand: [2.2, 12.95, 1.7], curl: .24, spread: .2 })], [1.35, pose(openL, { hand: [2.4, 13.15, 1.85], curl: .19, spread: .24 }), 'stop'], [2.25, lowL, 'stop']],
  }, [[.28, { browUp: .18, browSmile: .2, smile: .25 }], [.95, { browSmile: .5, eyeSmile: .4, smile: .74 }], [1.8, { browSmile: .4, eyeSmile: .3, smile: .62 }], [2.3, { browSmile: .25, eyeSmile: .2, smile: .4 }]], { arc: { tuck: .25, out: .5 } }),
  listen: performance('认真倾听', '收住手，向你靠近，慢慢点一次头', 4, 1.1, 2.95, {
    body: [[0, {}], [.24, { gazePitch: -.025 }], [.65, { lean: .09, headRoll: .055, neckForward: .03 }],
      [1.1, { lean: .18, headRoll: .09, headPitch: -.035, neckForward: .06, pelvisPitch: -.035 }, 'stop'],
      [1.9, { lean: .18, headRoll: .075, headPitch: .07, neckForward: .055 }, 'stop'], [2.45, { lean: .15, headRoll: .065, headPitch: -.015 }], [2.95, { lean: .13, headRoll: .055 }, 'stop']],
    R: [[0, lowR], [.85, pose(lowR, { hand: [1.6, 12.35, 1.78], curl: .36, shrug: -.035 })], [1.5, pose(lowR, { hand: [1.6, 12.42, 1.85], curl: .27, thumb: .22 }), 'stop'], [2.95, pose(lowR, { hand: [1.6, 12.35, 1.8], curl: .31 }), 'stop']],
    L: [[0, lowL], [1.1, pose(lowL, { hand: [1.72, 12.25, 1.75], curl: .4, shrug: -.04 }), 'stop'], [2, pose(lowL, { hand: [1.7, 12.3, 1.8], curl: .31 })], [2.95, lowL, 'stop']],
  }, [[.4, { browSad: .12, eyeSmile: .08 }], [1.2, { browSad: .18, eyeSmile: .16, smile: .22 }], [2.35, { browSmile: .2, eyeSmile: .22, smile: .34 }], [3, { browSmile: .13, smile: .2 }]]),
  comfort: performance('温柔安慰', '先放低肩膀，缓慢伸出掌心，再点头回应', 4.1, 1.35, 3.05, {
    body: [[0, {}], [.38, { headPitch: .045, headRoll: -.035, gazePitch: .025 }], [.9, { lean: .11, headRoll: -.075, twist: -.025 }],
      [1.35, { lean: .2, headPitch: -.02, headRoll: -.095, neckForward: .045, pelvisPitch: -.045 }, 'stop'],
      [2.25, { lean: .18, headPitch: .055, headRoll: -.075 }, 'stop'], [3.05, { lean: .13, headPitch: 0, headRoll: -.05 }, 'stop']],
    R: [[0, lowR], [.85, pose(openR, { hand: [2.2, 13.35, 2.15], curl: .25, spread: .1, shrug: -.02 })], [1.5, pose(openR, { hand: [2.25, 13.55, 2.75], curl: .17, spread: .19, shrug: -.025 }), 'stop'], [3.05, pose(openR, { hand: [2.2, 13.4, 2.55], curl: .24 }), 'stop']],
    L: [[0, lowL], [1.05, pose(heart, { hand: [.75, 14.75, 1.95], curl: .23, shrug: -.015 })], [1.7, pose(heart, { hand: [.6, 14.95, 1.95], curl: .18, spread: -.18 }), 'stop'], [3.05, pose(heart, { hand: [.85, 14.65, 2], curl: .28 }), 'stop']],
  }, [[.45, { browSad: .27, eyeDroop: .13 }], [1.25, { browSad: .24, eyeSmile: .19, smile: .28 }], [2.3, { browSad: .13, browSmile: .2, eyeSmile: .28, smile: .46 }], [3.1, { browSmile: .16, eyeSmile: .17, smile: .31 }]]),
  look_up: performance('仰头舒展', '视线向上，胸口打开，仰头后带笑回望', 3.95, 1.2, 2.85, {
    body: [[0, {}], [.2, { gazePitch: -.13 }], [.55, { lean: -.035, headPitch: -.085, neckForward: -.025 }],
      [1.2, { lean: -.12, headPitch: -.2, headRoll: .025, pelvisPitch: .04, neckForward: -.04, gazePitch: -.12 }, 'stop'],
      [2.15, { lean: -.07, headPitch: -.13, gazePitch: -.02 }], [2.85, { lean: .045, headPitch: -.015, headRoll: .035 }, 'stop']],
    R: [[0, lowR], [.9, pose(openR, { hand: [2.65, 13.2, 1.8], curl: .24, spread: .2, protract: -.06 })], [1.45, pose(openR, { hand: [2.95, 13.4, 1.85], curl: .15, spread: .3, protract: -.075 }), 'stop'], [2.85, pose(openR, { hand: [2.45, 13.25, 1.9], curl: .25 }), 'stop']],
    L: [[0, lowL], [1.05, pose(openL, { hand: [2.55, 12.95, 1.65], curl: .25, protract: -.045 })], [1.55, pose(openL, { hand: [2.8, 13.1, 1.75], curl: .18, spread: .22, protract: -.065 }), 'stop'], [2.85, lowL, 'stop']],
  }, [[.4, { browUp: .18, eyeWide: .12 }], [1.3, { browSmile: .2, eyeHalf: .18, smile: .34 }], [2.25, { browSmile: .3, eyeSmile: .26, smile: .5 }], [2.9, { browSmile: .2, eyeSmile: .18, smile: .38 }]]),
  agree: performance('会意点头', '眼神确认，胸肩随点头前送，手指轻轻打开', 3.05, .95, 2.05, {
    body: [[0, {}], [.22, { gazePitch: -.035, headPitch: -.045 }], [.65, { lean: .065, headPitch: .025, headRoll: .025 }],
      [.95, { lean: .12, headPitch: .14, headRoll: .035, pelvisPitch: -.025 }, 'stop'], [1.4, { lean: .075, headPitch: -.035, headRoll: .02 }], [2.05, { lean: .055, headPitch: .015, headRoll: .015 }, 'stop']],
    R: [[0, lowR], [.7, pose(openR, { hand: [2.05, 13.4, 1.95], curl: .26, spread: .12 })], [1.08, pose(openR, { hand: [2.3, 13.6, 2.15], curl: .14, spread: .27 }), 'stop'], [2.05, pose(openR, { hand: [2.15, 13.35, 1.95], curl: .22 }), 'stop']],
    L: [[0, lowL], [.9, pose(lowL, { hand: [1.8, 12.45, 1.75], curl: .4 })], [1.3, pose(lowL, { hand: [1.85, 12.55, 1.8], curl: .26 }), 'stop'], [2.05, lowL, 'stop']],
  }, [[.3, { browUp: .12, eyeWide: .08 }], [.95, { browSmile: .3, eyeSmile: .24, smile: .44 }], [1.65, { browSmile: .25, eyeSmile: .2, smile: .4 }], [2.1, { browSmile: .16, smile: .28 }]]),
};

// Original cue IDs stay source/protocol compatible; give them authored expression
// envelopes as well so older playback and scheduler clients gain face/body linkage.
const legacyExpressions = {
  explain: [[.35, { browUp: .12 }], [.9, { browSmile: .22, eyeSmile: .15, smile: .3 }], [1.7, { browSmile: .16, smile: .23 }]],
  wave: [[.3, { browUp: .18, smile: .2 }], [.8, { browSmile: .42, eyeSmile: .32, smile: .65 }], [1.9, { browSmile: .25, smile: .42 }]],
  shrug: [[.25, { browAsym: .25, browUp: .15 }], [.5, { browAsym: .36, browSad: .2, smile: .24 }], [.9, { browSmile: .13, smile: .22 }]],
  chest: [[.35, { browSad: .12 }], [.85, { browSmile: .25, eyeSmile: .2, smile: .36 }], [2, { browSmile: .18, smile: .3 }]],
};
export const GESTURES = Object.freeze({
  ...Object.fromEntries(Object.entries(LEGACY_GESTURES).map(([id, def]) => [id,
    legacyExpressions[id] ? { ...def, expression: faceTrack(def.duration, legacyExpressions[id]) } : def])),
  ...EXPRESSIVE_GESTURES,
});
export const GESTURE_IDS = Object.freeze(Object.keys(GESTURES).filter(id => !GESTURES[id].internal));
