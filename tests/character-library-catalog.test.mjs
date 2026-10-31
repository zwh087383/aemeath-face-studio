import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { CHARACTER_CATALOG, CHARACTER_ACTIONS, NATIVE_GROUPS, NATIVE_INVENTORY, READING_ACTIONS, validateCharacterCommands, resolveNativePerformance } from '../realtime/character-center/catalog.mjs';
import { canonicalJSON, sha256, validatePerformance } from '../realtime/character-center/catalog-compiler.mjs';
import { ACTIVITY_LIBRARY } from '../preview/core/activity-library.js';
import { MODEL_ACTIONS } from '../realtime/model-director/catalog.mjs';

test('all original 83 IDs remain, all original 75 activities and explicit seated desk approach have executable contracts',()=>{
  const original=[...Object.keys(MODEL_ACTIONS),'native:stand01','native:thinking01',...READING_ACTIONS.map(id=>'activity:'+id)];
  assert.equal(original.length,83);for(const id of original)assert.ok(CHARACTER_ACTIONS[id],id);
  assert.equal(Object.keys(ACTIVITY_LIBRARY).length,76);
  for(const [name,source] of Object.entries(ACTIVITY_LIBRARY)){
    const row=CHARACTER_ACTIONS['activity:'+name];assert.equal(row.duration,source.duration);assert.equal(row.requires.support,source.initialSupport);
    assert.deepEqual(row.requires.freeHands,source.freeHands??[]);assert.equal(row.effects.support,source.endSupport);
    assert.ok(row.source.id===name&&row.performanceContract&&row.durationContract);
    if(source.heldVariant)assert.ok(row.variants[source.heldVariant]);
  }
  assert.equal(CHARACTER_ACTIONS['activity:drink_seated'].requires.held,'mug');
  assert.equal(CHARACTER_ACTIONS['activity:write_at_desk'].requires.held,'pencil');
  assert.equal(CHARACTER_ACTIONS['activity:pickup_box'].requires.existingSource,'box');
  assert.equal(CHARACTER_ACTIONS['activity:put_book_seated'].effects.held,null);
  for(const name of ['put_book_seated','put_book_standing']) {
    const prep=CHARACTER_ACTIONS['activity:'+name].durationContract.conditionalPreparation;
    assert.equal(prep.seconds,1.4);assert.equal(prep.when.bookOpennessGreaterThan,.05);
    assert.equal(prep.when.deskLayout,'partitioned');assert.equal(prep.phase,'close-held-book');
  }
  const approach=CHARACTER_ACTIONS['activity:approach_desk_seated'];assert.equal(approach.effects.root,'measured');
  assert.equal(approach.effects.chair,'measured');assert.equal(approach.requires.seatSupported,true);
  assert.deepEqual(approach.requires.chairTableAlignment.advanceRange,[.15,7.05]);
});

test('inventory covers exact 149 source families and 319 clips without pretending acceptance',()=>{
  assert.equal(NATIVE_INVENTORY.length,149);assert.equal(NATIVE_INVENTORY.reduce((n,g)=>n+g.phases.length,0),319);
  assert.equal(new Set(NATIVE_INVENTORY.map(g=>g.sourceFamily)).size,149);
  const registered=new Set(Object.values(NATIVE_GROUPS).map(g=>g.groupId));
  for(const group of NATIVE_INVENTORY){
    assert.equal(registered.has(group.groupId),group.policy.scope==='single-character');
    assert.equal(group.review.visualAccepted,false);assert.equal(group.review.contactAccepted,false);
    for(const phase of group.phases){assert.match(phase.sha256,/^[a-f0-9]{64}$/);assert.equal(phase.geometry.sampleCount,9);
      assert.equal(phase.sourceAsset.replace(/\.uasset$/i,'').replace(/_(?:Start|Loop\d*|End)$/i,''),group.sourceFamily);}
  }
  assert.ok(!registered.has('native:8b2e802a90db3da3'));
  for(const group of NATIVE_INVENTORY.filter(g=>g.policy.scope!=='single-character'))assert.ok(group.policy.reason);
  assert.equal(NATIVE_INVENTORY.filter(g=>g.missingStart).length,8);
  assert.equal(NATIVE_INVENTORY.filter(g=>g.missingEnd).length,18);
});

test('actual Sit01 and Sit05_Land source support contracts do not infer from a name',()=>{
  const byName=name=>Object.values(NATIVE_GROUPS).find(g=>g.sourceFamily.endsWith('/'+name));
  assert.equal(byName('Sit01').lifecycle.entrySupport,'standing');assert.equal(byName('Sit01').lifecycle.middleSupport,'seated');assert.equal(byName('Sit01').effects.support,'standing');
  assert.equal(byName('Sit05_Land').requires.support,'seated');assert.equal(byName('Sit05_Land').effects.support,'standing');
  assert.equal(byName('Sit02').requires.support,'standing');
  assert.equal(byName('Sit02').lifecycle.sourceEntrySupport,'floor-seated');
  assert.equal(byName('Sit02').durationContract.entrySeconds,2.4);
  assert.equal(byName('Sit04_Head').lifecycle.exit,'return-entry');
  assert.equal(byName('DZ_Liaotoufa01').durationContract.returnSeconds,.65);
});

test('JS and generated JSON carry one reproducible canonical hash',()=>{
  for(const value of ['', 'abc','中文 🦊 '.repeat(1000)])assert.equal(sha256(value),crypto.createHash('sha256').update(value).digest('hex'));
  const {hash,...body}=CHARACTER_CATALOG;assert.equal(hash,'sha256:'+crypto.createHash('sha256').update(canonicalJSON(body)).digest('hex'));
  const generated=JSON.parse(fs.readFileSync(new URL('../realtime/character-center/catalog.json',import.meta.url),'utf8'));
  assert.equal(canonicalJSON(generated),canonicalJSON(CHARACTER_CATALOG),'run catalog generator after library changes');
});

test('performance is optional, exact old commands survive, unknown variations fail closed',()=>{
  const command={operation:'append',actions:[{action:'native:thinking01',anchor:'immediate'}]};
  assert.deepEqual(validateCharacterCommands(command).actions[0],{...command.actions[0],delay_ms:0});
  const row=CHARACTER_ACTIONS['native:thinking01'];
  assert.throws(()=>validatePerformance({speed:.5},row),/invalid_performance/);
  assert.throws(()=>validatePerformance({micro_set:['chin_tap']},row),/invalid_micro_set/);
  assert.throws(()=>validatePerformance({variant_set:['unknown']},row),/invalid_variant_set/);
  for(const bad of [NaN,Infinity,0,-1,[9,4],[4,5,6]])assert.throws(()=>validatePerformance({total_seconds:bad},row),/invalid_total/);
  assert.throws(()=>validatePerformance({total_seconds:9},CHARACTER_ACTIONS['activity:jump_vertical']),/invalid_total/);
  assert.deepEqual(validatePerformance({total_seconds:[8,12],variant_set:['exact'],micro_set:[]},row),{total_seconds:[8,12],variant_set:['exact'],micro_set:[]});
});

test('native duration planning reserves returns, preserves original phase speed and reports reachable time',()=>{
  const thinking=NATIVE_GROUPS['native:thinking01'],normal=resolveNativePerformance(thinking);
  assert.equal(normal.repeat,1);assert.ok(Math.abs(normal.actualSeconds-6.4666666)<1e-5);
  const eight=resolveNativePerformance(thinking,{total_seconds:8});assert.equal(eight.repeat,2);assert.ok(Math.abs(eight.actualSeconds-9.1333333)<1e-5);assert.equal(eight.exact,false);
  assert.throws(()=>resolveNativePerformance(thinking,{total_seconds:[7,8]}),/unreachable/);
  const missing=Object.values(NATIVE_GROUPS).find(g=>g.sourceFamily.endsWith('/DZ_Liaotoufa01'));
  const planned=resolveNativePerformance(missing);assert.equal(planned.returnReservedSeconds,.65);assert.ok(Math.abs(planned.actualSeconds-missing.duration)<1e-7);
  const numbered=Object.values(NATIVE_GROUPS).find(g=>g.sourceFamily.endsWith('/Thinking02'));
  const selected=numbered.phaseData.find(p=>p.sourcePhase==='loop1');
  const variation=resolveNativePerformance(numbered,{variant_set:['phase:'+selected.id],total_seconds:[8,10]});
  assert.equal(variation.phaseData.filter(p=>p.phase==='loop').length,1);assert.equal(variation.phaseData.find(p=>p.phase==='loop').id,selected.id);
});

test('every single-loop permission resolves to its already exercised exact route; multi-loop permissions enumerate real alternatives',()=>{
  let sameRoute=0,multi=0;
  for(const def of Object.values(NATIVE_GROUPS))for(const id of def.performanceContract.variant_set.filter(id=>id.startsWith('phase:'))){
    const planned=resolveNativePerformance(def,{variant_set:[id]}),loops=def.phaseData.filter(p=>p.phase==='loop');
    assert.equal(planned.phaseData.filter(p=>p.phase==='loop').length,1);
    assert.equal(planned.phaseData.find(p=>p.phase==='loop').id,id.slice(6));
    if(loops.length===1){assert.deepEqual(planned.phaseData,def.phaseData);assert.ok(Math.abs(planned.actualSeconds-def.duration)<1e-9);sameRoute++;}else multi++;
  }
  assert.equal(sameRoute,68);assert.equal(multi,2);
  const long=resolveNativePerformance(NATIVE_GROUPS['native:thinking01'],{total_seconds:86400});assert.ok(long.repeat>10000);
});

test('mathematical duration choice selects reachable whole cycles only inside an explicitly allowed interval',()=>{
  const def=NATIVE_GROUPS['native:thinking01'],performance={total_seconds:[6,15]};
  const low=resolveNativePerformance(def,performance,{durationChoice:0}),high=resolveNativePerformance(def,performance,{durationChoice:1});
  assert.equal(low.repeat,1);assert.equal(high.repeat,4);
  for(const planned of [low,high]){
    assert.ok(planned.actualSeconds>=6&&planned.actualSeconds<=15);
    assert.equal(planned.phaseData,def.phaseData);
    const actual=def.durationContract.entrySeconds+def.durationContract.startSeconds+def.durationContract.loopSeconds*planned.repeat+def.durationContract.endSeconds+def.durationContract.returnSeconds+def.durationContract.settleSeconds;
    assert.ok(Math.abs(actual-planned.actualSeconds)<1e-8);
    assert.equal(planned.preservesSourceSpeed,true);
  }
  assert.equal(resolveNativePerformance(def,{}, {durationChoice:1}).repeat,1,'energy must not add unpermitted repeats');
  assert.equal(resolveNativePerformance(def,{total_seconds:8},{durationChoice:0}).actualSeconds,resolveNativePerformance(def,{total_seconds:8},{durationChoice:1}).actualSeconds,'a scalar target remains the nearest legal duration');
  for(const bad of [-.01,1.01,NaN,Infinity,'1',null])assert.throws(()=>resolveNativePerformance(def,performance,{durationChoice:bad}),/invalid_native_duration_choice/);
  for(const choice of [0,.5,1])assert.throws(()=>resolveNativePerformance(def,{total_seconds:[7,8]},{durationChoice:choice}),/native_duration_unreachable/);
});
