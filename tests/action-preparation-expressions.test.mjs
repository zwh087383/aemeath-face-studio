import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildExpressionPreparation, createMorphAudit, expandMorphLeaves, expressionNotes,
  prepareExpression} from '../scripts/action-preparation/prepare-expressions.mjs';

const vertex = (name, englishName, panel, index) => ({name, englishName, type:1, panel,
  elements:[{index, position:[.1, 0, 0]}]});
const model = () => [vertex('あ', 'S_01', 3, 1), vertex('い', 'I', 3, 1),
  vertex('にこり', 'B_Happy', 1, 2), vertex('瞳小', 'Pupil_Scale', 2, 3),
  vertex('右口角上げ', 'M_Smile_R', 3, 1), vertex('左口角上げ', 'M_Smile_L', 3, 1),
  vertex('ウィンク右', 'E_Smile_R', 2, 4), vertex('ウィンク', 'E_Smile_L', 2, 5),
  {name:'looks-like-brow', englishName:'', type:0, panel:1, elements:[{index:2, ratio:1}, {index:0, ratio:-.4}]}];
const entry = (name = 'Aimisi_Wink') => ({id:`fixture-${name}`, name, kind:'expression',
  file:`resources/${name}.json`, sourceAsset:`Client/Content/Aimisi/Expression/${name}.uasset`});
const curve = (name, values) => ({name, keys:values.map(([time, value]) => ({time, value, interpolation:'RCIM_Linear'}))});
const constant = (name, value) => curve(name, [[0, value], [1, value]]);

test('actual runtime alias mapping preserves signed values, half-face targets and asymmetry', () => {
  const result = prepareExpression(entry(), {duration:1, curves:[constant('M_Smile_R', .6000006),
    constant('M_Smile_L', .6181814), constant('Pupil_Scale', -.09090781), constant('B_Happy', .4272728),
    constant('E_Smile_R', 1)]}, createMorphAudit(model()));
  assert.equal(result.measurements.allCurvesStatic, true);
  assert.equal(result.measurements.curves.find(c => c.name === 'Pupil_Scale').first, -.09090781);
  assert.equal(result.measurements.curves.find(c => c.name === 'M_Smile_R').mapping.targetName, '右口角上げ');
  assert.ok(result.measurements.asymmetry.some(a => a.unequalFirst));
  assert.ok(result.measurements.asymmetry.some(a => a.right === 'E_Smile_R' && a.state === 'left-absent-not-zero'));
  assert.deepEqual(result.speechVariants[1].sourceChannels, ['B_Happy', 'E_Smile_R']);
  assert.deepEqual(result.conditionalMouthCorners.map(c => c.min), [.6000006, .6181814]);
  assert.equal(result.automaticEligible, false);
});

test('a group listed as brow is excluded if its actual PMX leaves change the mouth', () => {
  const audit = createMorphAudit(model());
  const result = prepareExpression(entry('group'), {duration:1,
    curves:[constant('looks-like-brow', .8)]}, audit);
  const mapping = result.measurements.curves[0].mapping;
  assert.equal(mapping.groupExpanded, true);
  assert.ok(mapping.leaves.some(leaf => leaf.name === 'あ' && leaf.ratio === -.4));
  assert.equal(mapping.touchesMouth, true);
  assert.equal(result.speechVariants[1].sourceChannels.length, 0);
  assert.ok(result.blockers.includes('original-recipe-overlaps-speech-mouth'));
  assert.ok(audit.groups[0].hasSignedRatio);
});

test('recursive groups preserve multiplied signed ratios and reject cycles or missing leaves', () => {
  const morphs = [vertex('a', '', 3, 1), {name:'g1', type:0, panel:4, elements:[{index:2, ratio:-.5}]},
    {name:'g2', type:0, panel:4, elements:[{index:0, ratio:.3}]}];
  assert.equal(expandMorphLeaves(morphs, 1).leaves[0].ratio, -.15);
  morphs[2].elements.push({index:1, ratio:1}, {index:99, ratio:1});
  const result = expandMorphLeaves(morphs, 1);
  assert.ok(result.errors.some(e => e.startsWith('group-cycle:')));
  assert.ok(result.errors.includes('missing-morph:99'));
  const item = prepareExpression(entry('g1'), {curves:[constant('g1', 1)]}, createMorphAudit(morphs));
  assert.ok(item.blockers.includes('invalid-pmx-group-reference'));
  assert.equal(item.automaticEligible, false);
  morphs[2].elements.push({index:0, ratio:null});
  assert.ok(expandMorphLeaves(morphs, 2).errors.some(e => e.startsWith('nonfinite-group-ratio:')));
});

test('equal endpoint values with nonzero cubic tangents are not classified as static', () => {
  const result = prepareExpression(entry('same-endpoints'), {duration:1, curves:[{name:'B_Happy', keys:[
    {time:0, value:.5, interpolation:'RCIM_Cubic', leaveTangent:2},
    {time:1, value:.5, interpolation:'RCIM_Cubic', arriveTangent:-2}]}]}, createMorphAudit(model()));
  assert.equal(result.measurements.allCurvesStatic, false);
  assert.equal(result.measurements.dynamicCurveCount, 1);
  assert.ok(result.measurements.curves[0].sampleMax > .5);
});

test('single-sided left source is missing a partner, not a command to zero the right', () => {
  const result = prepareExpression(entry('left-only'), {curves:[constant('E_Smile_L', .4)]}, createMorphAudit(model()));
  assert.deepEqual(result.measurements.asymmetry, [{right:'E_Smile_R', left:'E_Smile_L',
    state:'right-absent-not-zero', leftFirst:.4}]);
});

test('unsupported controls remain visible and an empty speech variant is not counted as new expression', () => {
  const result = prepareExpression(entry('unsupported'), {curves:[constant('SeqMouthAlpha', 0),
    constant('Special_F_01', 1), constant('M_Smile_L', .3)]}, createMorphAudit(model()));
  assert.deepEqual(result.measurements.controlChannels, ['SeqMouthAlpha']);
  assert.deepEqual(result.measurements.activeUnmappedChannels, ['Special_F_01']);
  assert.equal(result.speechVariants[1].sourceChannels.length, 0);
  assert.ok(result.blockers.includes('control-channel-needs-explicit-owner'));
  assert.ok(result.blockers.includes('unmapped-source-controls'));
});

test('nonfinite or malformed curves stay blocked and are never replaced with name-derived values', () => {
  const result = prepareExpression(entry('Happy'), {curves:[constant('B_Happy', NaN)]}, createMorphAudit(model()));
  assert.equal(result.measurements.finite, false);
  assert.equal(result.preparationStatus, 'blocked-invalid-data');
  assert.equal(result.automaticEligible, false);
  assert.deepEqual(result.blockers, ['source-decode-or-analysis-failed']);
});

test('identical static recipes are recognized across names and container lengths without merging signed differences', () => {
  const audit = createMorphAudit(model());
  const a = prepareExpression(entry('one'), {duration:1, curves:[constant('B_Happy', .2)]}, audit);
  const b = prepareExpression(entry('two'), {duration:3, curves:[curve('B_Happy', [[0,.2], [3,.2]])]}, audit);
  const c = prepareExpression(entry('three'), {duration:1, curves:[constant('B_Happy', -.2)]}, audit);
  assert.equal(a.sourceRecipeFingerprint, b.sourceRecipeFingerprint);
  assert.notEqual(a.sourceRecipeFingerprint, c.sourceRecipeFingerprint);
});

test('fixture CLI inventories all requested resources, reports unreadable files and does not process mouth curves', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aemeath-expression-prep-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  await fs.mkdir(path.join(dir, 'resources'));
  const character = entry('Aimisi_smile');
  const generic = {...entry('Closeeyes_Smile'), id:'generic', kind:'default-face',
    sourceAsset:'Client/Content/Aki/Sequence/SequenceAnim/DefaultFace/Closeeyes_Smile.uasset'};
  const missing = {...entry('missing'), id:'missing'};
  const escaping = {...entry('escape'), id:'escape', file:'../outside.json'};
  const mouth = {id:'mouth', kind:'mouth', name:'whole-game-mouth', file:'must-not-be-read.json'};
  const manifestPath = path.join(dir, 'manifest.json'), modelMorphsPath = path.join(dir, 'model.json');
  await fs.writeFile(manifestPath, JSON.stringify({resources:[character, generic, missing, escaping, mouth]}));
  await fs.writeFile(modelMorphsPath, JSON.stringify({morphs:model()}));
  await fs.writeFile(path.join(dir, character.file), JSON.stringify({curves:[constant('M_Smile_R', .75)]}));
  await fs.writeFile(path.join(dir, generic.file), JSON.stringify({duration:1,
    curves:[curve('B_Happy', [[0,0], [1,.5]]), constant('M_Smile_L', -.2)]}));
  const result = await buildExpressionPreparation({manifestPath, modelMorphsPath});
  assert.equal(result.items.length, 4);
  assert.equal(result.summary.invalidResources, 2);
  assert.equal(result.summary.defaultFaceResources, 1);
  assert.equal(result.summary.dynamicResources, 1);
  assert.equal(result.summary.mouthInventory.count, 1);
  assert.equal(result.summary.mouthInventory.analyzedCurvesThisRun, false);
  assert.ok(result.items.find(i => i.id === 'escape').measurements.error.includes('leaves resource root'));
  assert.ok(result.items.find(i => i.id === 'generic').blockers.includes('not-aemeath-specific-review-required'));
  assert.ok(result.items.every(i => i.automaticEligible === false));
  assert.ok(expressionNotes(result).includes('所有automaticEligible均为false'));
  const script = fileURLToPath(new URL('../scripts/action-preparation/prepare-expressions.mjs', import.meta.url));
  const out = path.join(dir, 'generated/result.json'), notes = path.join(dir, 'generated/notes.md');
  const run = spawnSync(process.execPath, [script, '--manifest', manifestPath, '--model-morphs', modelMorphsPath,
    '--out', out, '--notes', notes], {encoding:'utf8'});
  assert.equal(run.status, 0, run.stderr);
  const written = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(written.schema, 'aemeath-preparation/v1');
  assert.deepEqual(written.summary, result.summary);
  assert.ok((await fs.readFile(notes, 'utf8')).includes('不是实时语音求嘴形的模型'));
});
