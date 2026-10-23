import test from 'node:test';
import assert from 'node:assert/strict';
import {SkillReaction,reviewAt,reactionFace,REACTION_LIMITS} from '../preview/core/skill-reaction.js';

test('self-correction waits without inventing understanding from elapsed time',()=>{
  const c=reviewAt(10,{complete:false});assert.equal(c.phase,'wait');assert.equal(c.pose().smileR,0);
  assert.equal(c.confirm(c.command({understood:false})).reason,'understanding-not-confirmed');
  assert.equal(c.phase,'wait');assert.equal(c.confirm(c.command({understood:true,speakerCompleted:true,partnerVoicing:false})).ok,true);
  c.advance(.36);assert.ok(c.pose().pitch>.1);c.advance(2);assert.equal(c.phase,'idle');
});
test('actual performance receipt follows completion, not queue acceptance',()=>{
  const c=new SkillReaction();assert.equal(c.start().reason,'accepted-not-yet-performed');
  assert.ok(!c.receipts.some(r=>r.reason==='performed-and-completed'));
  c.advance(.5);c.correction(c.command());c.advance(1);c.confirm(c.command({understood:true,speakerCompleted:true,partnerVoicing:false}));
  c.advance(1.8);assert.equal(c.receipts.at(-1).reason,'performed-and-completed');
});
test('pause freezes both waiting and recovery clocks exactly',()=>{
  const c=reviewAt(1);c.pause();const before=c.snapshot();c.advance(20);assert.deepEqual(c.snapshot(),before);
  c.pause(false);c.interrupt();c.advance(.1);c.pause();const after=c.snapshot();c.advance(100);assert.deepEqual(c.snapshot(),after);
});
test('interrupt is position-continuous at preparation, arrest, wait, confirmation and recovery',()=>{
  for(const t of [0,.22,.81,1.8,2.85,3.9]){
    const c=reviewAt(t),before=c.pose();assert.equal(c.interrupt().ok,true);
    assert.deepEqual(c.pose(),before);for(let i=0;i<90;i++){c.advance(.01);assert.ok(Object.values(c.pose()).every(Number.isFinite));}
    assert.equal(c.phase,'idle');assert.ok(Object.values(c.pose()).every(v=>v===0));
  }
});
test('cancelled epoch and old turn cannot restart or acknowledge a cancelled gesture',()=>{
  const c=reviewAt(1),old=c.command();c.interrupt();
  assert.equal(c.confirm({...old,understood:true}).reason,'stale-context');
  c.advance(1);assert.equal(c.start(old).reason,'stale-context');
  assert.equal(c.start({...old,epoch:c.epoch,dedupeKey:'new'}).ok,true);
  assert.equal(c.correction({...c.command(),turnId:'old-turn'}).reason,'stale-context');
});
test('a completed speaker and understood content are separate required facts',()=>{
  const c=reviewAt(1);for(const fields of [{understood:true},{understood:true,speakerCompleted:true},{understood:true,speakerCompleted:true,partnerVoicing:true}]){
    assert.equal(c.confirm(c.command(fields)).reason,'speaker-not-finished');assert.equal(c.phase,'arrest');
  }
  assert.equal(c.confirm(c.command({understood:true,speakerCompleted:true,partnerVoicing:false})).ok,true);
});
test('external cancellation validates session, turn, epoch and cancel correlation',()=>{
  const c=reviewAt(1),owner=c.command();for(const field of ['sessionId','turnId','cancelId','epoch']){
    assert.equal(c.interrupt({...owner,[field]:'wrong'}).reason,'stale-context');assert.equal(c.phase,'arrest');
  }
  assert.equal(c.interrupt({epoch:c.epoch}).reason,'stale-context');assert.equal(c.interrupt(owner).ok,true);
});
test('duplicates, invalid clock and expired commands are rejected',()=>{
  const c=new SkillReaction();assert.equal(c.start({expiresAt:-1}).ok,false);c.start({dedupeKey:'one'});
  c.interrupt();c.advance(1);assert.equal(c.start({dedupeKey:'one'}).reason,'duplicate');
  assert.throws(()=>c.advance(NaN));assert.throws(()=>c.advance(-1));
});
test('full samples stay finite, return to zero, and leave every viseme out of the face mask',()=>{
  const forbidden=['A','Aa','S_01','I','U','E','O','M_OpenSmall','M_Laugh','SeqMouthAlpha'];
  let maxLean=0,maxSmile=0;
  for(let t=0;t<4.6;t+=1/120){const p=reviewAt(t).pose();assert.ok(Object.values(p).every(Number.isFinite));maxLean=Math.max(maxLean,p.lean);maxSmile=Math.max(maxSmile,p.smileR);const f=reactionFace(p);for(const k of forbidden)assert.ok(!(k in f));}
  assert.ok(maxLean>=.089);assert.ok(maxSmile>=.259);assert.ok(Object.values(reviewAt(4.5).pose()).every(v=>v===0));
});
test('repeated runs and timeline seeks have no accumulated state',()=>{
  const expected=reviewAt(1.2).pose();for(let i=0;i<30;i++){assert.deepEqual(reviewAt(1.2).pose(),expected);assert.ok(Object.values(reviewAt(4.5).pose()).every(v=>v===0));}
  const c=reviewAt(17.8,{complete:false});c.advance(.3);assert.equal(c.phase,'cancelled');c.advance(1);assert.equal(c.phase,'idle');
});
test('arbitrary correction, confirmation and cancellation preserve velocity and bounded trajectories',()=>{
  let seed=87123;const random=()=>((seed=(Math.imul(1664525,seed)+1013904223)>>>0)/2**32);
  const checkEvent=(c,invoke)=>{
    const before=c.pose(),epsilon=.000001,ahead=c.pose(epsilon);
    const velocity=Object.fromEntries(Object.keys(before).map(k=>[k,(ahead[k]-before[k])/epsilon]));
    assert.equal(invoke().ok,true);assert.deepEqual(c.pose(),before);
    const after=c.pose(epsilon);for(const k of Object.keys(before))assert.ok(Math.abs((after[k]-before[k])/epsilon-velocity[k])<.002,`${k}: velocity jump`);
    for(let i=0;i<=240;i++){const p=c.pose(i/240);for(const [k,[lo,hi]]of Object.entries(REACTION_LIMITS))assert.ok(p[k]>=lo-1e-9&&p[k]<=hi+1e-9,`${k}: ${p[k]} outside ${lo},${hi}`);}
  };
  for(let i=0;i<40;i++){
    const c=new SkillReaction();c.start();c.advance(.02+random()*.64);
    checkEvent(c,()=>c.correction(c.command()));c.advance(.02+random()*.49);
    checkEvent(c,()=>c.confirm(c.command({understood:true,speakerCompleted:true,partnerVoicing:false})));
    c.advance(random()*1.7);checkEvent(c,()=>c.interrupt());
  }
});
test('a delayed frame processes completion or expiry in chronological order',()=>{
  const complete=reviewAt(3);complete.advance(50);assert.equal(complete.phase,'idle');
  assert.equal(complete.receipts.at(-1).reason,'performed-and-completed');assert.equal(complete.receipts.at(-1).time,4.45);
  const wait=reviewAt(10,{complete:false});wait.advance(20);assert.equal(wait.phase,'idle');
  assert.equal(wait.receipts.at(-1).reason,'returned-after-cancel');assert.equal(wait.receipts.at(-1).time,18.9);
});
