/** Character-specific expression choices. These gains are experimental authoring
 * values, not psychological measurements or additional WAI emotion state. */
export const ATTITUDE_KINDS = Object.freeze(['attention', 'concern', 'serious', 'warm', 'curious', 'playful', 'sad', 'excited']);
export const REACTION_KINDS = Object.freeze(['surprise', 'confused', 'smile', 'concern']);

// A secondary stance is a small, explicit nuance of the same fresh semantic
// evidence. It cannot replace the primary stance's conflict policy or WAI math.
export const SECONDARY_STANCE_BLEND = .35;
export const SECONDARY_STANCE_REGIONS = Object.freeze({
  attention: Object.freeze([]),
  concern: Object.freeze(['brows']), serious: Object.freeze(['brows']),
  warm: Object.freeze(['corners']), curious: Object.freeze(['eyes']),
  playful: Object.freeze(['corners']), sad: Object.freeze(['brows']),
  excited: Object.freeze(['corners', 'eyes']),
});

export const FACE_PROFILES = Object.freeze({
  attention: { recipeId: 'authored-expression:neutral', gain: 1, positive: false },
  serious: { recipeId: 'authored-expression:focus', gain: .46, positive: false },
  concern: { recipeId: 'expression-aimisi-sad02-3beb630272', gain: .65, positive: false },
  warm: { recipeId: 'expression-aimisi-smile-4da1c40696', gain: .7, positive: true },
  curious: { recipeId: 'expression-aimisi-jingya-d11f6453f7', gain: .34, positive: false },
  playful: { recipeId: 'expression-aimisi-kawaii-0b83f3a342', gain: .55, positive: true },
  sad: { recipeId: 'expression-aimisi-sad-c3d3092b05', gain: .7, positive: false },
  excited: { recipeId: 'expression-aimisi-happy02-215f86e1e4', gain: .68, positive: true },
  surprise: { recipeId: 'expression-aimisi-jingya-d11f6453f7', gain: .65, positive: false },
  confused: { recipeId: 'expression-aimisi-wunai-d413aca0e0', gain: .55, positive: false },
  smile: { recipeId: 'expression-aimisi-smile-4da1c40696', gain: .7, positive: true },
  anger: { recipeId: 'expression-aimisi-angry-18f176d22b', gain: .55, positive: false },
  tired: { recipeId: 'expression-rolelife-aimisi-sleep-447120d051', gain: .32, positive: false },
});

export const FACE_TIMING = Object.freeze({
  semanticHoldSeconds: 20, semanticFadeSeconds: 5,
  responseSeconds: .075, articulationSeconds: .016,
  reactionAttack: .12, reactionHold: .35, reactionRelease: .25,
  maximumBlinkSeconds: .45, sustainedClosureLimit: .55,
});

/** These are hand-written local component inputs, never model observations. */
export const LOCAL_MATH_SAMPLES = Object.freeze([
  { id: 'neutral', label: '平静', emotion: { V: 0, A: .35, D: .5, S: .12, L: .5, T: .5 }, effectiveEnergy: .75 },
  { id: 'happy', label: '愉快', emotion: { V: .65, A: .55, D: .6, S: .08, L: .65, T: .7 }, effectiveEnergy: .8 },
  { id: 'excited', label: '明显兴奋', emotion: { V: .85, A: .85, D: .65, S: .12, L: .7, T: .8 }, effectiveEnergy: .85 },
  { id: 'sad', label: '低落', emotion: { V: -.7, A: .2, D: .25, S: .4, L: .5, T: .5 }, effectiveEnergy: .55 },
  { id: 'angry', label: '紧绷烦躁', emotion: { V: -.65, A: .8, D: .7, S: .8, L: .45, T: .5 }, effectiveEnergy: .75 },
  { id: 'worried', label: '担忧', emotion: { V: -.4, A: .5, D: .25, S: .65, L: .6, T: .6 }, effectiveEnergy: .65 },
  { id: 'tired', label: '疲惫', emotion: { V: -.1, A: .2, D: .35, S: .25, L: .5, T: .5 }, effectiveEnergy: .15 },
  { id: 'shy', label: '收敛的愉快', emotion: { V: .3, A: .4, D: .2, S: .25, L: .65, T: .65 }, effectiveEnergy: .65 },
].map(sample => Object.freeze({ ...sample, emotion: Object.freeze(sample.emotion), authority: 'mathematical', source: 'handwritten_component_fixture', componentOnly: true })));

export function actionFaceCompatible(attitude, actionKind) {
  if (!attitude) return true;
  if (attitude === 'attention') return !FACE_PROFILES[actionKind]?.positive;
  if (['concern', 'sad', 'serious'].includes(attitude)) return ['concern', 'sad', 'serious', 'attention', 'confused', 'surprise'].includes(actionKind);
  if (attitude === 'curious') return ['curious', 'serious', 'attention', 'confused', 'surprise'].includes(actionKind);
  return ['warm', 'playful', 'excited', 'smile', 'attention', 'surprise'].includes(actionKind);
}
