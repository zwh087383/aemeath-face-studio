// Authored additions use the model's existing semantic morphs only. Head-only
// reactions deliberately avoid pretending that the rig has an eye-gaze channel.
// Speech owns vowels and articulator shapes in FaceController/overlay composition.
export const EXPRESSION_CATEGORIES = Object.freeze([
  { id: 'connection', name: '倾听与回应' },
  { id: 'care', name: '共情与低落' },
  { id: 'thought', name: '思考与疑问' },
  { id: 'assurance', name: '安心与坚定' },
  { id: 'play', name: '轻松与笑意' },
  { id: 'reserve', name: '拘谨与犹豫' },
  { id: 'energy', name: '精神与休息' },
].map(Object.freeze));

const preset = (id, name, category, note, morphs, tilt, microAction) => Object.freeze({
  id, name, category, note, morphs: Object.freeze(morphs), tilt, microAction,
});

// These are mood targets, not commands to hold a face for an entire reply.
// Start with strength .6-.85 and let a scheduled cue return to the prior attitude.
export const EXPANDED_PRESETS = Object.freeze([
  preset('acknowledge_soft', '轻轻应声', 'connection', '嘴角给一点回应，眉眼保持松弛。', { browSmile: .12, eyeSmile: .12, smile: .22 }, -.008, 'tiny_agree'),
  preset('attentive', '专心倾听', 'connection', '眼神收拢一点，抬眉表示仍在听。', { browFocus: .15, browUp: .12, eyeWide: .1, smile: .07 }, .012, 'listen_dip'),
  preset('understanding', '心领神会', 'connection', '眉梢缓下来，给一个理解的浅笑。', { browSad: .11, browSmile: .18, eyeSmile: .2, smile: .26 }, -.018, 'acknowledge'),
  preset('encouraging', '温柔鼓励', 'connection', '略抬眉、舒展眼尾，笑意有分寸。', { browUp: .18, browSmile: .23, eyeSmile: .18, smile: .35 }, -.012, 'double_nod'),

  preset('empathy', '认真共情', 'care', '眉心轻提，眼尾放软，保留一点安慰。', { browSad: .33, eyeDroop: .16, eyeSmile: .06, smile: .1 }, .018, 'listen_dip'),
  preset('concerned', '关切', 'care', '微拢眉心，目光仍看着对方。', { browSad: .3, browFocus: .13, eyeWide: .15, frown: .13 }, .012, 'head_settle'),
  preset('worried', '担心', 'care', '眉间不安比关切更明显，但不夸张瞪眼。', { browSad: .48, browAsym: .13, eyeWide: .18, frown: .23, mouthNarrow: .08 }, .026, 'look_down'),
  preset('apologetic', '歉意', 'care', '眉眼略垂，嘴角收住，轻轻低一下头。', { browSad: .38, eyeDroop: .25, eyeHalf: .1, frown: .12 }, -.025, 'listen_dip'),
  preset('disappointed', '小小失落', 'care', '目光略黯、嘴角轻落，不做哭相。', { browSad: .28, eyeDroop: .27, eyeHalf: .24, frown: .26, mouthFlat: .16 }, .008, 'look_down'),
  preset('melancholy', '若有所失', 'care', '眉间留一点低落，眼神更慢、更柔。', { browSad: .4, eyeDroop: .34, eyeHalf: .14, frown: .18 }, -.032, 'thought_tilt'),

  preset('skeptical', '有点怀疑', 'thought', '单侧眉轻抬，嘴角收平，等你继续。', { browAsym: .44, browFocus: .17, eyeHalf: .26, mouthFlat: .22 }, .04, 'thought_tilt'),
  preset('unconvinced', '不太认同', 'thought', '目光略锐，神情克制，表达保留意见。', { browFocus: .28, browAnger: .12, eyeSharp: .24, eyeHalf: .17, frown: .18 }, -.014, 'gentle_decline'),
  preset('puzzled', '轻微困惑', 'thought', '只皱一点眉，疑问没有变成惊讶。', { browSad: .29, browAsym: .18, eyeWide: .13, mouthFlat: .17 }, .052, 'thought_tilt'),
  preset('considering', '斟酌', 'thought', '眉心稍收、眼皮略降，留出想一想的停顿。', { browFocus: .28, browAsym: .13, eyeHalf: .2, mouthFlat: .13 }, .022, 'glance_left'),
  preset('recollecting', '回想', 'thought', '略抬眉，神情放空一点，再找回视线。', { browUp: .2, browAsym: .1, eyeHalf: .16, smile: .08 }, -.024, 'look_up'),
  preset('realizing', '恍然明白', 'thought', '眼睛短暂亮起来，随即浮出小小笑意。', { browUp: .35, eyeWide: .28, smile: .22, o: .08 }, -.01, 'chin_lift'),

  preset('relieved', '松一口气', 'assurance', '眉间松开，眼皮落一点，笑意回来。', { browSmile: .16, eyeDroop: .18, eyeHalf: .21, smile: .27 }, -.015, 'head_settle'),
  preset('grateful', '感谢', 'assurance', '眉眼带着温度，笑容柔和而认真。', { browSad: .13, browSmile: .25, eyeSmile: .26, smile: .36, blush: .12 }, -.024, 'acknowledge'),
  preset('proud', '有点得意', 'assurance', '抬一点眉梢，嘴角轻扬，眼睛不过分眯起。', { browSmile: .2, browAsym: .2, eyeHalf: .15, smile: .38 }, -.03, 'chin_lift'),
  preset('confident', '笃定', 'assurance', '目光稳定，嘴角略扬，不摆严厉的脸。', { browFocus: .23, eyeSharp: .17, smile: .21 }, -.006, 'acknowledge'),
  preset('determined', '下定决心', 'assurance', '眉眼收紧一点，嘴角收住，准备行动。', { browFocus: .41, browAnger: .15, eyeSharp: .31, mouthFlat: .2 }, .004, 'tiny_agree'),

  preset('amused', '忍俊不禁', 'play', '眼尾先弯，嘴角跟上，笑得轻一点。', { browSmile: .28, smileEyes: .28, eyeSmile: .2, smile: .43 }, -.026, 'head_settle'),
  preset('mischievous', '小小坏笑', 'play', '一侧眉带点主意，眼睛微眯，笑而不语。', { browAsym: .32, browSmile: .22, eyeHalf: .23, smile: .39 }, -.038, 'glance_right'),
  preset('teasing', '轻轻打趣', 'play', '略歪头、稍挑眉，笑意里带一点玩笑。', { browUp: .13, browAsym: .24, eyeSmile: .24, smile: .4, blush: .08 }, .042, 'thought_tilt'),
  preset('delighted', '眼前一亮', 'play', '目光明亮、笑容舒展，保留自然眼形。', { browUp: .21, browSmile: .32, eyeWide: .2, eyeSmile: .15, smile: .49, a: .12 }, -.022, 'double_nod'),

  preset('awkward', '有点尴尬', 'reserve', '眉梢不太对称，勉强给一个小笑。', { browSad: .23, browAsym: .21, eyeHalf: .17, smile: .19, blush: .16 }, .027, 'glance_right'),
  preset('embarrassed', '不好意思', 'reserve', '视线略垂、脸颊浅红，笑容含蓄。', { browSad: .2, eyeDroop: .24, eyeHalf: .13, smile: .24, blush: .39 }, -.037, 'look_down'),
  preset('hesitant', '欲言又止', 'reserve', '眉间犹豫，嘴角收紧一点，再抬眼回应。', { browSad: .24, browAsym: .2, eyeWide: .07, mouthNarrow: .12, mouthFlat: .16 }, .022, 'gentle_decline'),

  preset('weary', '有点疲惫', 'energy', '眼皮沉一点，眉眼少用力，嘴角放松。', { browSad: .15, eyeDroop: .3, eyeHalf: .43, frown: .07 }, .012, 'look_down'),
  preset('sleepy', '困意', 'energy', '眼睛慢慢半合，神情松软而不是翻白眼。', { eyeDroop: .21, eyeHalf: .62, browSad: .1, smile: .04 }, -.027, 'listen_dip'),
  preset('serene', '安静放松', 'energy', '眉眼舒展，留一点平和笑意。', { browSmile: .1, eyeDroop: .1, eyeHalf: .11, eyeSmile: .1, smile: .16 }, -.01, 'head_settle'),
  preset('startled', '轻轻一惊', 'energy', '眉眼短暂一提，程度轻于原来的惊讶。', { browUp: .43, eyeWide: .4, pupilSmall: .06, o: .16 }, .008, 'chin_lift'),
]);
export const EXPANDED_PRESET_IDS = Object.freeze(EXPANDED_PRESETS.map(item => item.id));

const action = (name, category, note, duration, axis, keys) => Object.freeze({
  name, category, note, duration, axis, keys: Object.freeze(keys.map(key => Object.freeze(key))),
});
// All knots are seconds/radians. Each authored reaction starts and finishes at
// zero; unequal spacing, short holds and smaller recovery avoid a sine-wave loop.
// These movements supplement a body gesture rather than changing its arm pose.
export const EXPANDED_MICRO_ACTIONS = Object.freeze({
  acknowledge: action('轻点一下', 'agreement', '确认听到了，点下去稍快、回正更缓。', .78, 'pitch', [[0, 0], [.18, .048], [.29, .046], [.53, -.008], [.78, 0]]),
  double_nod: action('连续轻点头', 'agreement', '第一下确认、第二下更小，不机械等幅。', 1.2, 'pitch', [[0, 0], [.2, .056], [.4, -.009], [.61, .036], [.78, .031], [1.2, 0]]),
  listen_dip: action('听着低一下头', 'listening', '缓缓下倾停一拍，然后回到对话视线。', 1.56, 'pitch', [[0, 0], [.38, .041], [.81, .041], [1.1, .022], [1.56, 0]]),
  chin_lift: action('微抬下巴', 'response', '短暂抬头接话，回正时带很轻的缓冲。', 1.04, 'pitch', [[0, 0], [.21, -.054], [.4, -.045], [.75, .006], [1.04, 0]]),
  glance_left: action('向左看一眼', 'attention', '头部稍向左转，停一下再找回对方。', 1.58, 'yaw', [[0, 0], [.28, .092], [.68, .087], [1.15, .024], [1.58, 0]]),
  glance_right: action('向右看一眼', 'attention', '头部稍向右转，停一下再找回对方。', 1.58, 'yaw', [[0, 0], [.28, -.092], [.68, -.087], [1.15, -.024], [1.58, 0]]),
  look_down: action('低头想一想', 'attention', '目光随头略落下，停留后自然抬回。', 1.82, 'pitch', [[0, 0], [.4, .068], [.99, .063], [1.4, .026], [1.82, 0]]),
  look_up: action('抬头回想', 'attention', '头部轻抬寻找思路，回到原来的视线。', 1.68, 'pitch', [[0, 0], [.35, -.058], [.81, -.052], [1.24, -.019], [1.68, 0]]),
  head_settle: action('轻轻回稳', 'settling', '侧向松一下，再用更小的幅度回稳。', 1.24, 'roll', [[0, 0], [.31, .031], [.68, -.012], [1.01, -.004], [1.24, 0]]),
  gentle_decline: action('轻轻否认', 'response', '小幅来回一次，幅度逐渐收住。', 1.31, 'yaw', [[0, 0], [.25, .039], [.64, -.034], [.98, .012], [1.31, 0]]),
  tiny_agree: action('短促应一下', 'agreement', '很轻很短的一下确认，不连续点个不停。', .57, 'pitch', [[0, 0], [.13, .035], [.23, .03], [.4, -.004], [.57, 0]]),
  thought_tilt: action('思索时稍偏头', 'listening', '轻偏头等一下答案，缓缓回正。', 1.92, 'roll', [[0, 0], [.39, .061], [1.02, .061], [1.45, .024], [1.92, 0]]),
});
export const MICRO_ACTION_CATEGORIES = Object.freeze([
  { id: 'agreement', name: '确认与赞同' },
  { id: 'listening', name: '倾听与思考' },
  { id: 'attention', name: '转移注意' },
  { id: 'response', name: '接话与保留' },
  { id: 'settling', name: '放松回稳' },
].map(Object.freeze));
export const EXPANDED_MICRO_ACTION_IDS = Object.freeze(Object.keys(EXPANDED_MICRO_ACTIONS));
