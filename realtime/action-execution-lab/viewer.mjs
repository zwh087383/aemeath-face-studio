import { ACTIVITY_IDS } from '/preview/core/activity-library.js';
document.getElementById('activity-count').textContent = ACTIVITY_IDS.length;
const frame = document.getElementById('lab'), fixtureStatus = document.getElementById('fixture-status');
const explanations = {
  '/native-behavior-lab/': '原生动作按同一来源目录组合。可检查循环、进入、退出，以及从当前运动减速停住；仍不等于任意姿势都能安全转场。',
  '/activities/': '从真实桌面拿起、固定尺寸持物、站坐放书和放杯、坐姿放笔。手到握点且静稳才接管，物体到桌面且静稳后才松手。请结合侧面检查。',
  '/face-preparation-lab/': '短表情出现、保持、退回最新底色。可在过程中换底色、取消或模拟发音嘴形；这里没有调用语音模型。',
};
for (const button of document.querySelectorAll('[data-page]')) button.onclick = () => {
  for (const other of document.querySelectorAll('[data-page]')) other.setAttribute('aria-pressed', String(other === button));
  frame.src = button.dataset.page;
  document.getElementById('fixtures').hidden = button.dataset.page !== '/activities/';
  document.getElementById('explanation').textContent = explanations[button.dataset.page];
};
function arrange(id) {
  const api = frame.contentWindow?.activityLab;
  if (!api?.ready) { fixtureStatus.textContent = '先进入生活活动页，等待人物载入后再布置。'; return false; }
  if (!['book', 'mug', 'pencil', 'box'].includes(id)) return false;
  api.reset();
  const state = { visible: true, attachment: 'table', ...(id === 'book' ? { openness: .8 } : {}),
    ...(id === 'pencil' ? { position: [-2.6, 8.961, 3.2], rotation: [0, 0, -Math.PI / 2] } : {}),
    ...(id === 'box' ? { position: [0, 8.9, 3.8] } : {}) };
  api.scene.props.update({ table: true, [id]: state }, { anchor: api.scene.body.anchor, time: api.director.time });
  api.scene.body.setRenderedPropsSnapshot(api.scene.props.snapshot());
  fixtureStatus.textContent = `已重置并摆好${({ book: '书', mug: '杯子', pencil: '笔', box: '箱子' })[id]}。物体仍在桌上；现在可选择对应取物或使用动作。`;
  return true;
}
for (const button of document.querySelectorAll('[data-fixture]')) button.onclick = () => arrange(button.dataset.fixture);
window.executionPreparation = { arrange };
