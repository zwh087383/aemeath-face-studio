import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSubtitleCues } from '../subtitle-rules.mjs';

const ids = result => result.cues.map(cue => `${cue.kind}:${cue.preset || cue.action || cue.gesture}`);
const motion = result => result.cues.find(cue => cue.kind !== 'expression');

test('actual Qwen colloquial praise retains negation and actor guards', () => {
  for(const text of ['太棒啦！','太棒了！']) assert.ok(ids(selectSubtitleCues(text)).includes('expression:happy'));
  for(const text of ['不觉得太棒啦。','太棒啦才怪。','他觉得太棒啦。','如果我觉得太棒啦。','我昨天觉得太棒啦。','“太棒啦！”'])
    assert.ok(!ids(selectSubtitleCues(text)).includes('expression:happy'),text);
});

test('ordinary speech selects supported emotions and short gestures', () => {
  for (const [text, expected] of [
    ['太好了，我很开心！', 'expression:happy'],
    ['我有点害羞。', 'expression:shy'],
    ['吓我一跳！', 'expression:surprise'],
    ['我很好奇，这是怎么回事？', 'expression:curious'],
    ['我仔细分析一下。', 'expression:focus'],
    ['嘿嘿，逗你玩。', 'expression:playful'],
    ['我明白了，交给我。', 'action:nod'],
    ['你说得对。', 'action:nod'],
    ['我不同意。', 'action:shake'],
    ['你好！', 'gesture:wave'],
    ['我喜欢你，有你真好。', 'gesture:chest'],
    ['我来解释一下，原因是网络还没连上。', 'gesture:explain'],
  ]) assert.ok(ids(selectSubtitleCues(text)).includes(expected), text);
});

test('explicit self motion wins over a conversational suggestion', () => {
  assert.equal(motion(selectSubtitleCues('你好，我轻轻点了点头。')).action, 'nod');
  assert.equal(motion(selectSubtitleCues('我明白了，我抬手说明。')).gesture, 'explain');
  assert.equal(motion(selectSubtitleCues('我先挥手，然后我摇了摇头。')).action, 'shake');
});

test('only a pure acknowledgement can confirm a direct user request', () => {
  const result = selectSubtitleCues('好的，没问题。', { userText: '请你轻轻点一下头。' });
  assert.equal(motion(result).action, 'nod');
  assert.equal(motion(result).reason, 'confirmed_user_request');
  assert.equal(motion(selectSubtitleCues('收到。', { userText: '请挥手。' })).gesture, 'wave');
  assert.equal(motion(selectSubtitleCues('我先想想。', { userText: '请挥手。' })), undefined);
  assert.equal(motion(selectSubtitleCues('好的。', { userText: '请不要挥手。' })), undefined);
  assert.equal(motion(selectSubtitleCues('好的。', { userText: '解释一下挥手的意思。' })), undefined);
});

test('negated actions never become an affirmative motion', () => {
  for (const text of ['我不会摇头。', '我不想点头。', '我没有挥手。', '我不要抬手说明。',
    '我不打算挥手。', '我点头是不可能的。', '我不是不同意。']) {
    assert.equal(motion(selectSubtitleCues(text)), undefined, text);
    assert.equal(selectSubtitleCues(text).fallbackEligible, false, text);
  }
});

test('a later revocation removes earlier cues in the same complete unit', () => {
  for (const text of ['我点头，但是我不会点头。', '我很开心，但是我并不开心。',
    '我挥手，算了。', '我点头，不做了。', '我点头但我不会点头。', '我点头后不会点头。']) {
    assert.deepEqual(selectSubtitleCues(text).cues, [], text);
  }
});

test('reported speech and unnamed actors cannot borrow a first-person token', () => {
  for (const text of ['小明说我很开心。', '我看到小明很开心。', '小明开心地挥手。',
    '小红说你好。', '王五不可以。', '她朝我挥手。', '他很开心，朝我挥手。',
    '我来解释如何挥手。', '我说明怎么点头。', '我教你怎样摇头。']) {
    assert.deepEqual(selectSubtitleCues(text).cues, [], text);
  }
  assert.equal(motion(selectSubtitleCues('那我轻轻点头。')).action, 'nod');
});

test('negation does not block a different explicitly affirmed action', () => {
  assert.equal(motion(selectSubtitleCues('我不会摇头，但我会挥手。')).gesture, 'wave');
});

test('third party, hypothetical, historical, discussion and action questions stay still', () => {
  for (const text of ['他开心地挥手。', '她很开心，朝我挥手。', '你轻轻点头。',
    '如果我点头，然后挥手。', '我昨天很开心，挥手告别。', '我刚才点头了。',
    '我觉得她很开心。', '比如我点头，然后微笑。', '讨论一下点头这个词。',
    '我要不要点头？', '我可以挥手吗？', '我是不是应该摇头呢？']) {
    const result = selectSubtitleCues(text);
    assert.deepEqual(result.cues, [], text);
    assert.equal(result.fallbackEligible, false, text);
  }
});

test('an explicit present-time self clause can follow historical or third-party material', () => {
  assert.equal(motion(selectSubtitleCues('她昨天挥手，现在我点头。')).action, 'nod');
});

test('quotes, parentheses and machine commands are not control instructions', () => {
  for (const text of ['（我挥手）', '(我点头)', '“我喜欢你”', '「我很开心」',
    '【我点头】', '[我挥手]', '{"action":"nod"}', '```我挥手```', '`我点头`',
    '> 我挥手', '<action>nod</action>', '他说：“我很开心”。']) {
    assert.deepEqual(selectSubtitleCues(text).cues, [], text);
  }
  assert.ok(ids(selectSubtitleCues('（我挥手）我明白了。')).includes('action:nod'));
});

test('unfinished annotations cannot leak their partial content', () => {
  for (const text of ['（我挥手', '“我很开心', '[我点头']) {
    assert.deepEqual(selectSubtitleCues(text).cues, []);
  }
});

test('strength stays bounded and profiles make limited changes', () => {
  const balanced = motion(selectSubtitleCues('我点头。')).strength;
  const gentle = motion(selectSubtitleCues('我点头。', { profile: 'gentle' })).strength;
  const lively = motion(selectSubtitleCues('我点头。', { profile: 'lively' })).strength;
  assert.ok(gentle < balanced && balanced < lively);
  assert.ok(motion(selectSubtitleCues('我轻轻点头。')).strength < balanced);
  assert.ok(motion(selectSubtitleCues('我用力点头。')).strength > balanced);
  assert.deepEqual(selectSubtitleCues('我点头。', { profile: 'unknown' }), selectSubtitleCues('我点头。'));
});

test('output has at most one expression and one motion with no scheduling metadata', () => {
  const result = selectSubtitleCues('你好，我很开心，我点头，我挥手，我摇头，我喜欢你。');
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues.filter(cue => cue.kind === 'expression').length, 1);
  assert.equal(result.cues.filter(cue => cue.kind !== 'expression').length, 1);
  for (const cue of result.cues) {
    assert.ok(cue.strength >= 0 && cue.strength <= 1);
    assert.equal(typeof cue.reason, 'string');
    assert.equal(Object.keys(cue).length, 4);
  }
});

test('fallback eligibility grants no cue and stores no cooldown or history', () => {
  const text = '我们把这个问题分开来看。';
  const result = selectSubtitleCues(text);
  assert.equal(motion(result), undefined);
  assert.equal(result.fallbackEligible, true);
  assert.deepEqual(selectSubtitleCues(text), result);
  for (const text of ['好的。', '这是什么？', '我不开心。', '（提示）普通的一句话。']) {
    assert.equal(selectSubtitleCues(text).fallbackEligible, false, text);
  }
});

test('long and invalid inputs fail closed without coercion or truncation', () => {
  assert.equal(selectSubtitleCues('我点头。' + '字'.repeat(513)).suppressedReason, 'input_too_long');
  assert.equal(selectSubtitleCues('好。', { userText: '字'.repeat(513) }).suppressedReason, 'input_too_long');
  for (const text of [null, undefined, 1, {}, [], '']) assert.deepEqual(selectSubtitleCues(text).cues, []);
  assert.notEqual(selectSubtitleCues('字'.repeat(512)).suppressedReason, 'input_too_long');
});
