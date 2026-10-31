import test from 'node:test';
import assert from 'node:assert/strict';
import { CHARACTER_ACTIONS, CHARACTER_CATALOG, NATIVE_INVENTORY, validateCharacterCommands } from '../realtime/character-center/catalog.mjs';
import { compileNativeGroups } from '../realtime/character-center/native-contracts.mjs';
import { NATIVE_MOTION_REVIEWS } from '../preview/core/native-motion-review.js';

test('the current catalog preserves source inventory and removes all excluded or semantically pending actions', () => {
  assert.equal(CHARACTER_CATALOG.actions.length, 253);
  assert.equal(CHARACTER_CATALOG.coverage.nativeRegistered, 100);
  assert.equal(NATIVE_INVENTORY.length, 149);
  assert.equal(NATIVE_INVENTORY.reduce((sum, row) => sum + row.phases.length, 0), 319);
  for (const review of NATIVE_MOTION_REVIEWS.filter(row => ['excluded', 'pending'].includes(row.status))) {
    const source = NATIVE_INVENTORY.find(row => row.groupId === review.groupId);
    assert.ok(source, review.name);
    assert.equal(source.status, review.status === 'excluded' ? 'prohibited' : 'semantic-review');
    assert.ok(!CHARACTER_ACTIONS[review.groupId], review.name);
    assert.throws(() => validateCharacterCommands({ operation: 'append', actions: [{ action: review.groupId, anchor: 'immediate' }] }), /invalid_action/);
    // An older cached integration policy does not reopen the reviewed source.
    assert.deepEqual(compileNativeGroups([{ ...source, policy: { scope: 'single-character' } }]), {});
  }
});

test('observed meanings reach the exact model-facing native actions while their source trajectories stay unchanged', () => {
  for (const [name, meaning] of [['Shy02', '身体前倾说话'], ['DZ_Tanqi01', '哭泣']]) {
    const review = NATIVE_MOTION_REVIEWS.find(row => row.name === name), source = NATIVE_INVENTORY.find(row => row.groupId === review.groupId);
    const action = CHARACTER_ACTIONS[review.groupId];
    assert.equal(action.label, meaning + '（原生）');
    assert.deepEqual(action.phases, source.phases.map(phase => phase.id));
    assert.equal(action.durationContract.preserveSourceSpeed, true);
    assert.equal(source.userReview.reviewedBy, 'user');
  }
  assert.ok(CHARACTER_ACTIONS['native:stand01']);
  assert.ok(CHARACTER_ACTIONS['native:thinking01']);
});
