import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from '../preview/node_modules/three/build/three.module.js';
import { skeletonFromInspection } from '../preview/core/motion-skeleton.js';
import { FullBodyController } from '../preview/core/full-body-controller.js';
import { ActivityDirector } from '../realtime/activities/director.mjs';
import { sampleActivity } from '../preview/core/activity-library.js';
import { PARTITIONED_DESK, partitionedDeskConflict } from '../preview/core/activity-desk-layout.js';
const hooks = registerHooks({ resolve(s, c, next) { return s === 'three' ? { url: new URL('../preview/node_modules/three/build/three.module.js', import.meta.url).href, shortCircuit: true } : next(s, c); } });
const { createActivityProps } = await import('../realtime/activities/props.mjs'); hooks.deregister();
const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../assets/Aemeath-inspection.json', import.meta.url), 'utf8')));
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

test('whole partitioned desk recipe keeps every actual hand constraint reachable including laptop lid contact', () => {
  const body = new FullBodyController({ skeleton }), director = new ActivityDirector(body), props = createActivityProps(new THREE.Scene());
  director.playSequence('desk_session'); let now = 0, maximumError = 0, maximumReach = 0, frames = 0;
  for (; frames < 6000 && director.sequence; frames++) {
    now += 1 / 30; const clock = director.tick(now); body.update(clock.now, clock.dt);
    const hands = body.handAnchors();
    props.update(body.pose.props, { anchors: { leftHand: hands.L, rightHand: hands.R }, anchor: body.pose.anchor ?? body.anchor,
      root: body.root, pose: body.pose, snapshot: body.snapshot(), time: clock.now });
    body.setRenderedPropsSnapshot(props.snapshot()); body.setPropTransferReceipts(props.snapshot());
    for (const [id, contact] of Object.entries(body.pose.propContacts?.props ?? {})) {
      for (const [side, target] of Object.entries(contact.targets ?? {})) {
        const error = distance(hands[side].position, target); maximumError = Math.max(maximumError, error);
        maximumReach = Math.max(maximumReach, body.diagnostics.arms[side].reach);
        assert.ok(error <= .025, `${body.activeId}/${body.elapsed}/${id}/${side}: actual palm error ${error} ${JSON.stringify({body:body.pose.body,pelvis:body.pose.pelvis,target,actual:hands[side].position,arm:body.diagnostics.arms[side]})}`);
        assert.ok(body.diagnostics.arms[side].reach <= .995001, `${body.activeId}/${body.elapsed}/${id}/${side}: commanded arm unreachable ${body.diagnostics.arms[side].reach}`);
      }
    }
    for (const prop of Object.values(props.snapshot().props)) if (prop.visible) assert.deepEqual(prop.scale, [1, 1, 1]);
  }
  assert.equal(director.sequence, null); assert.equal(body.done, true); assert.ok(frames > 2000);
  console.log(JSON.stringify({ acceptance: 'whole-partitioned-desk-all-surface-constraints', frames, maximumError, maximumReach }));
  props.dispose();
});

test('existing incompatible paper or open laptop is diagnosed before fixed-zone layout admission', () => {
  const table = { visible: true, attachment: 'floor', worldTransform: { position: [0, 0, 4.3], quaternion: [0, 0, 0, 1] } };
  const paper = { visible: true, attachment: 'table', worldTransform: { position: [-1.1, 8.935, 2.9], quaternion: [0, 0, 0, 1] } };
  assert.equal(partitionedDeskConflict({ table, paper }).id, 'paper');
  assert.equal(partitionedDeskConflict({ table, laptop: { visible: true, openness: 1, worldTransform: { position: PARTITIONED_DESK.laptopCenter, quaternion: [0, 0, 0, 1] } } }).reason, 'close-existing-object-before-partitioned-desk');
  assert.equal(partitionedDeskConflict({ table, paper: { ...paper, worldTransform: { ...paper.worldTransform, position: PARTITIONED_DESK.paperCenter } } }), null);
});

test('writing uses the actual retained paper frame rather than an invented default center', () => {
  const paper = { visible: true, attachment: 'table', worldTransform: { position: [-1.1, 8.935, 2.9], quaternion: [0, 0, 0, 1] } };
  for (let t = 0; t <= 8; t += .1) {
    const pose = sampleActivity('write_at_desk', t, { deskLayout: 'partitioned', sceneProps: { paper } });
    const target = pose.propContactPlans.pencil.frame.position;
    assert.ok(Math.abs(target[0] - paper.worldTransform.position[0]) <= .35 + 1e-8);
    assert.ok(Math.abs(target[2] - paper.worldTransform.position[2]) <= .12 + 1e-8);
    assert.deepEqual(pose.props.paper.worldTransform, paper.worldTransform, 'pose may clone the frame but must not substitute a different one');
  }
});
