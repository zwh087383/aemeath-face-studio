import test from 'node:test';
import assert from 'node:assert/strict';
import {IdleScheduler} from '../realtime/idle-activity-demo/scheduler.mjs';
import {VoiceGate} from '../realtime/idle-activity-demo/voice-gate.mjs';
const setup=()=>{const calls=[],motion={setMode:mode=>calls.push(mode),clearCheckpoint:()=>calls.push('clear')};return {s:new IdleScheduler(motion),calls};};
const row=(revision,status='running',extra={})=>({sessionId:'s1',generation:1,revision,task:{status},engaged:false,...extra});
test('real lifecycle selects activity / natural pause / resume / completion',()=>{
  const {s,calls}=setup();s.accept(row(1));s.accept(row(2,'paused'));s.accept(row(3));s.accept(row(4,'done'));
  assert.deepEqual(calls.filter(c=>c!=='clear'),['working','paused','working','complete']);
});
test('local microphone attention is not undone by poll before backend ACK',()=>{
  const {s}=setup();s.accept(row(1));s.attention();s.accept(row(2));assert.equal(s.mode,'listening');
  s.accept(row(3,'paused',{engaged:true}));s.accept(row(4,'paused',{engaged:false}));assert.equal(s.mode,'paused');
});
test('late revision or cancelled older generation cannot revive activity',()=>{
  const {s}=setup();s.accept(row(10,'failed',{generation:2}));assert.equal(s.accept(row(9)),false);
  assert.equal(s.accept(row(11,'running',{generation:1})),false);assert.equal(s.mode,'idle');
});
test('completion during conversation stays listening until explicit end',()=>{
  const {s}=setup();s.accept(row(1,'done',{engaged:true}));assert.equal(s.mode,'listening');
  s.accept(row(2,'done',{engaged:false}));assert.equal(s.mode,'complete');
});
test('lost connection stops new work without mutating business facts',()=>{
  const {s}=setup();s.accept(row(1));s.connectionLost();assert.equal(s.mode,'paused');assert.equal(s.last.task.status,'running');
});
test('VAD requires sustained energy; short click or silence does not open turn',()=>{
  const v=new VoiceGate();assert.equal(v.update(.8,.05),null);assert.equal(v.update(0,.1),null);
  assert.equal(v.update(.05,.1),null);assert.equal(v.update(.05,.05),'speech-start');
  assert.equal(v.update(.05,.05),null);
  for(let i=0;i<5;i++)assert.equal(v.update(0,.1),null);
  assert.equal(v.update(0,.1),'speech-end');
});
