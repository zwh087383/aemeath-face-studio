import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildReviewQueue, validateReviewQueue, writeReviewQueue, renderReviewQueue, sourceIdentity } from '../scripts/action-preparation/build-review-queue.mjs';

const rules = () => ({ rules: [{ id: 'standing-talk', match: { sourceRegex: '/Talk\\d*(?:_(?:Start|Loop[12]?|End))?\\.uasset$' }, priority: 90 }], reuseComparisons: [] });
const base = (id, kind) => ({ id, kind, name: id, sourceCatalog: kind === 'native-body' ? 'native' : 'authored', sourceRef: `fixture#${id}`, measurements: {},
  usage: { purpose: '实际用途待审', preconditions: ['固定入口'], entry: '检查当前姿态', exit: '保留实际现场' }, blockers: ['未验实模'], automaticEligible: false });
function body(id, phase = 'single', directory = 'Character/A', name = 'Talk') {
  const sourceRef = `${directory}/${name}${phase === 'single' ? '' : `_${phase[0].toUpperCase() + phase.slice(1)}`}.uasset`;
  const identity = sourceIdentity(sourceRef);
  return { ...base(id, 'native-body'), sourceRef, family: identity.family, phase: identity.phase, durationSeconds: 2,
    sourceDataRef: `clips/${id}.json.gz`, usageRuleIds: ['standing-talk'], measurements: { finite: true, lowAngularMotionReviewIntervals: [{ startSeconds: 0, endSeconds: 2 }], feet: { L: { contactConfirmed: false } } } };
}
function catalog(items, seams = []) {
  const familyNames = [...new Set(items.filter(x => x.kind === 'native-body').map(x => x.family))];
  return { schema: 'aemeath-preparation/v1', items, seams, families: familyNames.map(family => ({ family, memberIds: items.filter(x => x.family === family).map(x => x.id) })) };
}
const groupOf = (queue, id) => queue.groups.find(group => group.memberIds.includes(id));

test('missing End has no exit and low-speed intervals cannot create cancellation permission', () => {
  const c = catalog([body('a-start', 'start'), body('a-loop', 'loop')]);
  const queue = buildReviewQueue(c, rules()), group = groupOf(queue, 'a-start');
  assert.equal(group.sourceSeamReview.tier, 'missing-named-exit');
  assert.deepEqual(group.endpointCandidates.exit, []);
  assert.equal(group.cancellationChecks[2].phaseCandidateMissing, true);
  assert.equal(group.cancellationChecks[2].accepted, false);
  assert.equal(group.lowMotionIsNotExitEvidence, true);
  assert.equal(group.automaticEligible, false);
  assert.match(group.prerequisitesToResolve.join('\n'), /缺同源命名End/);
});

test('same basename across directories preserves both sources and never borrows a matching End', () => {
  const c = catalog([body('a-start', 'start', 'Character/A'), body('a-loop', 'loop', 'Character/A'), body('b-end', 'end', 'Character/B')]);
  const queue = buildReviewQueue(c, rules());
  assert.equal(queue.summary.nativeNameFamilies, 1);
  assert.equal(queue.summary.nativeSourceDirectoryGroups, 2);
  assert.deepEqual(groupOf(queue, 'a-start').endpointCandidates.exit, []);
  assert.equal(groupOf(queue, 'b-end').sourceSeamReview.missingNamedStart, true);
  assert.equal(queue.nameFamilyIndex[0].sourceFamilies.length, 2);
});

test('rejects a sourceRef/family mismatch and incorrect usage rule provenance', () => {
  const c = catalog([body('a')]);
  c.items[0].sourceRef = 'Character/B/Talk.uasset';
  assert.throws(() => buildReviewQueue(c, rules()), /Wrong source family\/phase mapping/);
  const second = catalog([body('b')]);
  second.items[0].usageRuleIds = ['another-rule'];
  assert.throws(() => buildReviewQueue(second, rules()), /Wrong source usage rule mapping/);
});

test('rejects a cross-directory seam even when both endpoints are valid bodies', () => {
  const c = catalog([body('a-loop', 'loop'), body('b-end', 'end', 'Character/B')], [{ from: 'a-loop', to: 'b-end', measurable: true }]);
  assert.throws(() => buildReviewQueue(c, rules()), /Wrong source seam mapping/);
});

test('separates pose closeness from velocity mismatch and treats unavailable velocity as unknown', () => {
  const measured = { from: 'a-start', to: 'a-loop', measurable: true, positionGapCm: 0.001, rotationGapDeg: 0.002,
    linearVelocityGapCmPerSec: 0.1, angularVelocityGapDegPerSec: 35 };
  const c = catalog([body('a-start', 'start'), body('a-loop', 'loop'), body('a-end', 'end')], [measured,
    { ...measured, from: 'a-loop', to: 'a-loop' }, { ...measured, from: 'a-loop', to: 'a-end' }]);
  assert.equal(groupOf(buildReviewQueue(c, rules()), 'a-start').sourceSeamReview.tier, 'source-velocity-gap-review');
  delete measured.angularVelocityGapDegPerSec;
  assert.equal(groupOf(buildReviewQueue(c, rules()), 'a-start').sourceSeamReview.tier, 'unmeasurable-or-incomplete-source-seam');
});

test('a missing expected source phase seam cannot be presented as close endpoints', () => {
  const c = catalog([body('a-start', 'start'), body('a-loop', 'loop'), body('a-end', 'end')], [
    { from: 'a-start', to: 'a-loop', measurable: true, positionGapCm: 0, rotationGapDeg: 0, linearVelocityGapCmPerSec: 0, angularVelocityGapDegPerSec: 0 },
  ]);
  const group = groupOf(buildReviewQueue(c, rules()), 'a-start');
  assert.equal(group.sourceSeamReview.tier, 'unmeasurable-or-incomplete-source-seam');
  assert.deepEqual(group.sourceSeamReview.missingSourceSeamPairs, [{ from: 'a-loop', to: 'a-loop' }, { from: 'a-loop', to: 'a-end' }]);
});

test('retains all 319 native bodies, 56 gestures, 65 activities and every auxiliary resource without body inflation', () => {
  const bodies = Array.from({ length: 319 }, (_, i) => body(`body-${i}`, 'single', 'Character/A', `Talk${i}`));
  const gestures = Array.from({ length: 56 }, (_, i) => ({ ...base(`gesture-${i}`, 'gesture'), runtimeId: `gesture-${i}`, category: 'conversation', measurements: { nominalDurationSeconds: 2 } }));
  const activities = Array.from({ length: 65 }, (_, i) => ({ ...base(`activity-${i}`, 'activity'), runtimeId: `activity-${i}`, measurements: { samples: 121, fps: 60, supports: { standing: 121 }, props: {} } }));
  const auxiliary = ['native-ribbon', 'native-look', 'native-prop-animation', 'expression', 'default-face', 'micro'].map((kind, i) => base(`support-${i}`, kind));
  const c = catalog([...bodies, ...gestures, ...activities, ...auxiliary]), queue = buildReviewQueue(c, rules());
  assert.equal(queue.summary.recordsCovered, 446);
  assert.equal(queue.summary.nativeBodyClips, 319);
  assert.equal(queue.summary.byKind.gesture, 56);
  assert.equal(queue.summary.byKind.activity, 65);
  assert.equal(queue.groups.flatMap(x => x.memberIds).length, 446);
  assert.equal(new Set(queue.groups.flatMap(x => x.memberIds)).size, 446);
  assert.equal(queue.groups.filter(x => x.kind === 'native-body-family').flatMap(x => x.sources).length, 319);
  assert.equal(queue.groups.some(x => x.automaticEligible), false);
  const activity = groupOf(queue, 'activity-0');
  assert.equal(activity.cancellationChecks[1].candidatePoints[0].timeSeconds, 1);
  assert.equal(activity.endpointCandidates.exit[0].timeSeconds, 2);
  queue.groups.find(x => x.memberIds.includes('activity-64')).memberIds = [];
  assert.throws(() => validateReviewQueue(queue, c), /Source list size mismatch/);
});

test('review source tampering and hidden support substitution are rejected', () => {
  const c = catalog([body('a'), base('ribbon-a', 'native-ribbon')]);
  const queue = buildReviewQueue(c, rules());
  groupOf(queue, 'a').sources[0].sourceRef = 'Character/B/Talk.uasset';
  assert.throws(() => validateReviewQueue(queue, c), /Wrong review source mapping/);
  const correct = buildReviewQueue(c, rules());
  groupOf(correct, 'a').kind = 'native-ribbon';
  assert.throws(() => validateReviewQueue(correct, c), /Body hidden in support group/);
});

test('structured expression provenance survives JSON reload, renders fully and rejects changed resource hash', () => {
  const expression = { ...base('native-expression', 'expression'), sourceCatalog: 'expressions',
    sourceRef: { sourceAsset: 'Character/A/Expression/Smile.uasset', file: 'resources/smile.json', sha256: 'a'.repeat(64) } };
  const c = catalog([body('a'), expression]), queue = buildReviewQueue(c, rules());
  const reloadedQueue = JSON.parse(JSON.stringify(queue)), reloadedCatalog = JSON.parse(JSON.stringify(c));
  assert.equal(validateReviewQueue(reloadedQueue, reloadedCatalog), true);
  const source = groupOf(queue, 'native-expression').sources[0];
  assert.equal(source.sourceDataRef, 'resources/smile.json');
  assert.equal(source.sourceSha256, 'a'.repeat(64));
  const markdown = renderReviewQueue(queue);
  assert.match(markdown, /Character\/A\/Expression\/Smile\.uasset/);
  assert.match(markdown, /resources\/smile\.json/);
  assert.equal(markdown.includes('[object Object]'), false);
  groupOf(reloadedQueue, 'native-expression').sources[0].sourceRef.sha256 = 'b'.repeat(64);
  assert.throws(() => validateReviewQueue(reloadedQueue, reloadedCatalog), /Wrong review source mapping/);
});

test('custom output directory receives JSON and readable instructions while inputs stay byte-identical', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aemeath-review-queue-'));
  try {
    const c = catalog([body('a-start', 'start'), body('a-loop', 'loop')]);
    const catalogBytes = JSON.stringify(c), ruleBytes = JSON.stringify(rules());
    const catalogFile = path.join(directory, 'catalog.json'), rulesFile = path.join(directory, 'rules.json');
    await writeFile(catalogFile, catalogBytes); await writeFile(rulesFile, ruleBytes);
    const output = path.join(directory, 'nested', 'review');
    const queue = await writeReviewQueue(catalogFile, rulesFile, output);
    const json = JSON.parse(await readFile(path.join(output, 'review-queue.json'), 'utf8'));
    const markdown = await readFile(path.join(output, 'review-queue.md'), 'utf8');
    assert.equal(json.summary.recordsCovered, 2);
    assert.equal(queue.fingerprints.catalogSha256.length, 64);
    assert.match(markdown, /出口候选：空，先补可执行退出/);
    assert.match(markdown, /准备时取消/);
    assert.match(markdown, /主动作\/保持时取消/);
    assert.match(markdown, /收回时取消/);
    assert.equal(await readFile(catalogFile, 'utf8'), catalogBytes);
    assert.equal(await readFile(rulesFile, 'utf8'), ruleBytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
