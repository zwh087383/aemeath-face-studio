import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityDirector } from '../realtime/activities/director.mjs';

const fixture = () => {
  const calls = [], body = { done:false, play(id){calls.push(id);this.done=false;return true;},
    snapshot(){return {done:this.done};}, pause(value){this.paused=value;}, stop(){calls.push('STOP');this.done=true;},
    reset(){calls.push('RESET');this.done=true;this.paused=false;} };
  return {body,calls,director:new ActivityDirector(body)};
};
function advance(d, seconds) { for(let t=0;t<seconds;t+=.05)d.tick((d.wall??0)+.05); }

test('sequence pause freezes its rest deadline and resuming starts only the next activity',()=>{
  const {body,calls,director:d}=fixture();d.playSequence('carry_delivery');d.tick(0);body.done=true;d.tick(.1);d.pause();advance(d,5);
  assert.deepEqual(calls,['pickup_box']);d.pause();advance(d,.4);assert.deepEqual(calls,['pickup_box','carry_box']);
});
test('stop retires all future sequence steps even after the body reports finished landing',()=>{
  const {body,calls,director:d}=fixture();d.playSequence('reading_break');d.tick(0);d.stop();body.done=true;advance(d,10);
  assert.deepEqual(calls,['walk_stop','STOP']);assert.equal(d.snapshot().sequence,null);
});
test('manual replacement retires sequence and invalid replacement does not cancel a valid owner',()=>{
  const {body,calls,director:d}=fixture();d.playSequence('carry_delivery');assert.equal(d.play('constructor'),false);
  assert.ok(d.snapshot().sequence);d.play('jump_vertical');body.done=true;advance(d,8);
  assert.deepEqual(calls,['pickup_box','jump_vertical']);assert.equal(d.snapshot().sequence,null);
});
test('reset retires the sequence and resets the clock without an old step reviving',()=>{
  const {body,calls,director:d}=fixture();d.playSequence('reading_break');d.tick(1);d.pause();d.reset();advance(d,3);
  assert.deepEqual(calls,['walk_stop','RESET']);assert.equal(body.paused,false);assert.equal(d.paused,false);assert.equal(d.snapshot().sequence,null);
});
