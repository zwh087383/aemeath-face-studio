import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_MOTION_REVIEWS, nativeMotionReviewFor, applyNativeMotionReview, reviewedNativeGroups } from '../preview/core/native-motion-review.js';
import { assertMotionAllowed } from '../preview/core/character-motion-policy.js';
import { buildNativeBehaviorPlan, NativeBehaviorAdapter } from '../preview/core/native-behavior-adapter.js';

const byName = name => NATIVE_MOTION_REVIEWS.find(row => row.name === name);

test('all screenshot entries and the two named removals leave selection and execution', async () => {
  const expected = ['Stand2','DZ_Sit_Baoyuan01','Stand_Cidai01','Run_cidai','Take_Mai01','keboard01','Aimisi_Fanclub',
    'MotorPassenger_Stand','Mortor_Zhixiang01','DZ_Motor_shouji01','Motor_Dajian01','Touch01','Stand1_Action01',
    'Stand1_Action02','XA_Loop_Stand','DZ_Tanzuo03','DZ_Chiru01','DZ_Rushui01','DZ_Fly01','DZ_Hunmi'];
  assert.deepEqual(NATIVE_MOTION_REVIEWS.filter(row => row.status === 'excluded').map(row => row.name), expected);
  for (const name of expected) {
    const row = byName(name), group = { id: row.groupId, sourceFamily: row.sourceFamily };
    assert.deepEqual(reviewedNativeGroups([group]), []);
    assert.throws(() => buildNativeBehaviorPlan(group, { clips: [] }), /User-excluded motion/);
    for (const clipId of row.clipIds) {
      assert.throws(() => assertMotionAllowed({ id: 'renamed', sourceIds: [clipId] }), /User-excluded motion/);
      const adapter = Object.create(NativeBehaviorAdapter.prototype);
      adapter.rows = new Map(); adapter.manifest = { clips: [{ id: clipId, resourceKind: 'body', status: 'ready' }] };
      await assert.rejects(adapter.load([clipId], () => { throw Error('excluded source was read'); }), /User-excluded motion/);
    }
    assert.throws(() => assertMotionAllowed({ source: { family: row.sourceFamily + '_Loop.UASSET' } }), /User-excluded motion/);
  }
});

test('pending meanings remain available for manual review with the prior semantic claim removed', () => {
  for (const name of ['Complain04', 'Wuzui01', 'Wuzui02']) {
    const rule = byName(name), old = { id: rule.groupId, reviewPurpose: ['旧含义'], usageRuleIds: ['old'],
      usage: { purpose: '旧含义', trigger: '旧触发', preconditions: ['旧前提'], notes: ['旧解释'] } };
    const source = JSON.stringify(old), current = reviewedNativeGroups([old])[0];
    assert.equal(current.semanticStatus, 'pending');
    assert.match(current.displayName, /含义待确认/);
    assert.equal(current.usage.purpose, '动作含义待确认。');
    for (const revoked of ['旧含义', '旧触发', '旧前提', '旧解释']) assert.ok(!JSON.stringify(current).includes(revoked));
    assert.equal(JSON.stringify(old), source);
    assert.doesNotThrow(() => assertMotionAllowed(old));
  }
});

test('user observation replaces Shy02 and DZ_Tanqi01 semantics across group and phase records', () => {
  for (const [name, meaning] of [['Shy02', '身体前倾说话'], ['DZ_Tanqi01', '哭泣']]) {
    const rule = byName(name);
    for (const identity of [{ id: rule.groupId }, { sourceRef: rule.sourceFamily + '_Start.uasset' }, { source: { groupId: rule.groupId } }]) {
      const current = applyNativeMotionReview({ ...identity, usage: { purpose: '旧解释', trigger: '旧触发' } });
      assert.equal(current.userReview.reviewedBy, 'user');
      assert.deepEqual(current.reviewPurpose, [meaning + '。']);
      assert.equal(current.usage.purpose, meaning + '。');
      assert.equal(current.semanticStatus, 'confirmed');
    }
  }
});

test('identity matching keeps unrelated same-name sources and approved neighboring variants', () => {
  for (const row of [{}, { name: 'Stand2', sourceFamily: 'Other/Stand2' }, { id: 'aimisi-stand01' },
    { sourceFamily: 'Client/Content/Aki/Character/Role/FemaleM/Aimisi/CommonAnim/UiAnim/Team_Stand2' },
    { sourceFamily: byName('Stand1_Action02').sourceFamily.replace('Action02', 'Action03') }]) {
    assert.equal(nativeMotionReviewFor(row), null);
    assert.doesNotThrow(() => assertMotionAllowed(row));
    assert.deepEqual(reviewedNativeGroups([row]), [row]);
  }
  assert.equal(nativeMotionReviewFor({ sourceIds: [byName('Shy02').clipIds[0], byName('Touch01').clipIds[0]] }).status, 'excluded');
});
