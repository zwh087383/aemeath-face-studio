// Semantic channels keep the controller independent of Three.js and PMX indices.
export const CHANNELS = [
  'browFocus', 'browAnger', 'browSmile', 'browSad', 'browUp', 'browAsym',
  'blink', 'smileEyes', 'wink', 'eyeSharp', 'eyeDroop', 'eyeHalf', 'eyeSmile',
  'eyeWide', 'pupilSmall', 'a', 'i', 'u', 'e', 'o', 'smile', 'frown',
  'mouthWide', 'mouthNarrow', 'mouthFlat', 'blush',
];
export const C = Object.freeze(Object.fromEntries(CHANNELS.map((name, i) => [name, i])));
export const VOWELS = ['a', 'i', 'u', 'e', 'o'].map(name => C[name]);
export const PRESETS = Object.freeze([
  { id: 'neutral', name: '自然', note: '放松眉眼，留一点呼吸。', morphs: {}, tilt: 0 },
  { id: 'smile', name: '浅笑', note: '嘴角轻轻扬起，眼尾柔和。', morphs: { browSmile: .24, eyeSmile: .28, smile: .48 }, tilt: -.018 },
  { id: 'happy', name: '开心', note: '弯起眼睛，笑意慢慢展开。', morphs: { browSmile: .65, smileEyes: 1, a: .42, smile: .55 }, tilt: -.035 },
  { id: 'curious', name: '疑惑', note: '眉毛微拢，侧头听你解释。', morphs: { browSad: .7, browAsym: .25, eyeWide: .22, o: .20, mouthFlat: .3 }, tilt: .11 },
  { id: 'focus', name: '认真', note: '目光集中，神情克制。', morphs: { browFocus: .6, browAnger: .22, eyeSharp: .4, frown: .45, mouthFlat: .5 }, tilt: .012 },
  { id: 'surprise', name: '惊讶', note: '先抬眉，再轻轻睁大眼睛。', morphs: { browUp: .7, eyeWide: .7, pupilSmall: .15, o: .6 }, tilt: 0 },
  { id: 'shy', name: '害羞', note: '微垂眼神，让脸红缓缓浮现。', morphs: { browSad: .35, eyeDroop: .3, eyeHalf: .17, smile: .38, blush: .85 }, tilt: -.06 },
  { id: 'playful', name: '俏皮', note: '单侧眨眼，带一点轻快笑意。', morphs: { browSmile: .5, wink: 1, smile: .65, a: .16 }, tilt: -.07 },
]);
export const PRESET_BY_ID = Object.freeze(Object.fromEntries(PRESETS.map(p => [p.id, p])));
export const ACTIONS = Object.freeze({
  nod: { name: '点头', duration: .86, axis: 'pitch', keys: [[0, 0], [.23, .095], [.48, -.035], [.7, .025], [.86, 0]] },
  shake: { name: '摇头', duration: 1.15, axis: 'yaw', keys: [[0, 0], [.23, .09], [.53, -.09], [.82, .055], [1.15, 0]] },
  tilt: { name: '侧头', duration: 1.65, axis: 'roll', keys: [[0, 0], [.4, .09], [1.05, .09], [1.65, 0]] },
  glance: { name: '回眸', duration: 1.4, axis: 'yaw', keys: [[0, 0], [.4, -.11], [.8, -.11], [1.4, 0]] },
  blink: { name: '眨眼', duration: .24 },
});

// Character-specific binding, checked against the loaded model before rendering.
export const AEMEATH_BINDINGS = [
  [0, '真面目'], [3, '怒り'], [6, 'にこり'], [10, '困る'], [14, '上'], [21, '怪訝右'],
  [23, 'まばたき'], [24, '笑い'], [25, 'ウィンク右'], [34, 'ｷﾘｯ'], [36, '垂れ目'],
  [38, 'じと目'], [41, '笑い目'], [42, 'びっくり'], [49, '瞳小'], [52, 'あ'], [53, 'い'],
  [54, 'う'], [55, 'え'], [56, 'お'], [61, '口角上げ'], [62, '口角下げ'],
  [63, '口横広げ'], [70, '口横狭め'], [87, '平口'], [114, '照れ公式'],
];

export const DEMO = PRESETS.map((preset, i) => ({
  id: `scene-${i}`, preset: preset.id, at: i * 1.8, duration: 1.8,
  action: ['blink', 'nod', 'nod', 'tilt', 'glance', 'shake', 'tilt', 'blink'][i],
}));
