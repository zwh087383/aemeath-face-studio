import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PerformanceDirector, STORIES } from '../performance/director.mjs';
import { FaceController } from '../../preview/core/controller.js';
import { MotionController } from '../../preview/core/motion-controller.js';
import { skeletonFromInspection } from '../../preview/core/motion-skeleton.js';

const skeleton = skeletonFromInspection(JSON.parse(readFileSync(new URL('../../assets/Aemeath-inspection.json', import.meta.url))));
function fixture() {
  const motion = new MotionController({ skeleton, seed: 724 }), face = new FaceController();
  face.headSway = false;
  const director = new PerformanceDirector({ motion, face });
  let wall = 0;
  const frame = () => {
    const { now, dt } = director.tick(wall);
    face.update(now, dt, null, !director.paused);
    motion.update(now, dt, { face: face.head, actions: face.activeActions, speech: 0 });
  };
  const advance = seconds => { for (let i = 0; i < Math.round(seconds * 60); i++) { wall += 1 / 60; frame(); } };
  frame();
  return { motion, face, director, advance, frame };
}

test('non-looped story enters successors during recovery and finishes each authored gesture', () => {
  const f = fixture(), starts = [], overlaps = [];
  assert.equal(f.director.playStory('greeting', false), true);
  let last = '';
  for (let i = 0; i < 1800; i++) {
    f.advance(1 / 60);
    const current = f.motion.snapshot().gestures.find(g => g.id === f.director.activeId);
    if (current && current.id !== last) {
      starts.push(current.gesture); last = current.id;
      overlaps.push(f.motion.snapshot().gestures.some(g => g.id !== current.id && g.recovering));
    }
  }
  assert.deepEqual(starts, STORIES.greeting.gestures);
  assert.ok(overlaps.slice(1).every(Boolean), 'successors blend with outgoing recovery');
  assert.equal(f.director.story, null);
  assert.equal(f.motion.gestures.length, 0);
});

test('pause freezes real controller bones and clock; resumption does not catch up wall time', () => {
  const f = fixture(); f.director.play('bow_smile'); f.advance(1);
  f.director.pause(); f.frame();
  const before = [...f.motion.locals].map(([key, q]) => [key, [...q]]), time = f.director.now;
  f.advance(5);
  assert.equal(f.director.now, time);
  assert.deepEqual([...f.motion.locals].map(([key, q]) => [key, [...q]]), before);
  f.director.pause(); f.advance(.1);
  assert.ok(Math.abs(f.director.now - time - .1) < 1e-9);
  assert.equal(f.motion.status, 'playing');
});

test('wave review finishes recovery before starting its successor', () => {
  const f = fixture(), starts = [];
  assert.equal(f.director.playStory('wave_review', false), true);
  let last = '', sawRecovery = false;
  for (let i = 0; i < 1200; i++) {
    f.advance(1 / 60);
    const gestures = f.motion.snapshot().gestures;
    const current = gestures.find(g => g.id === f.director.activeId);
    if (current?.gesture === 'wave' && current.phase === 'recover') sawRecovery = true;
    if (current && current.id !== last) {
      if (starts.length) {
        assert.ok(sawRecovery, 'the outgoing wave actually reached recovery');
        assert.equal(gestures.length, 1, 'the next greeting must not replace a recovering wave');
      }
      starts.push(current.gesture); last = current.id;
    }
  }
  assert.deepEqual(starts, ['wave', 'greet']);
  assert.equal(f.motion.gestures.length, 0);
  assert.equal(f.director.story, null);
});

test('interrupt while paused releases all motion and clears story without resuming the sequence', () => {
  const f = fixture(); f.director.playStory('discovery'); f.advance(.8); f.director.pause();
  const events = f.director.events.length;
  assert.equal(f.director.stop(), true); f.advance(3);
  assert.equal(f.motion.active, false); assert.equal(f.face.active, false);
  assert.equal(f.motion.gestures.length, 0); assert.equal(f.motion.pending.length, 0);
  assert.equal(f.director.story, null); assert.equal(f.director.paused, false);
  assert.equal(f.director.events.length, events + 1);
});

test('replay after interrupt has a new epoch and rejects stale ownership', () => {
  const f = fixture(); f.director.play('surprise'); f.advance(.7);
  const old = f.director.epoch; f.director.stop(); f.advance(.1);
  assert.equal(f.director.play('comfort'), true); f.advance(.1);
  assert.ok(f.director.epoch > old);
  assert.equal(f.motion.playback(old, 'playing', 100), false);
  assert.equal(f.face.playback(old, 'playing', 100), false);
  assert.ok(f.motion.snapshot().gestures.some(g => g.gesture === 'comfort' && !g.recovering));
});

test('cooldown rejection leaves existing story selection and cue ownership intact', () => {
  const f = fixture(); f.director.playStory('greeting'); f.advance(.2);
  const prior = { story: f.director.story, index: f.director.index, activeId: f.director.activeId };
  assert.equal(f.director.playStory('greeting', false), false);
  assert.deepEqual({ story: f.director.story, index: f.director.index, activeId: f.director.activeId }, prior);
  assert.equal(f.director.play('beat'), false);
  f.advance(8);
  assert.ok(f.director.events.some(e => e.gesture === 'bow_smile'));
});
