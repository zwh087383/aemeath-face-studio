import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as THREE from '../../preview/node_modules/three/build/three.module.js';
import { skeletonFromInspection } from '../../preview/core/motion-skeleton.js';
import { buildFullBodyRig, solveFullBodyPose } from '../../preview/core/full-body-ik.js';
import { ACTIVITY_LIBRARY, sampleActivity } from '../../preview/core/activity-library.js';
import { enforceActivityPropContacts, measuredPropHand } from '../../preview/core/activity-prop-execution.js';
import { fingerprintDependencies, verifyFingerprints } from './source-fingerprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'outputs/action-execution-preparation-20261023/props');
const sourceDependencies = fingerprintDependencies(['scripts/action-preparation/validate-prop-execution.mjs', 'preview/core/full-body-controller.js', 'realtime/activities/props.mjs'], root);
const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === 'three' ? {
  url: new URL('../../preview/node_modules/three/build/three.module.js', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
const { createActivityProps } = await import('../../realtime/activities/props.mjs'); hooks.deregister();
const rig = buildFullBodyRig(skeletonFromInspection(JSON.parse(await readFile(path.join(root, 'assets/Aemeath-inspection.json'), 'utf8'))));
const locals = new Map(), fk = new Map(), anchor = { position: [0, 0, 0], yaw: 0 };
const trajectories = [], recipes = [];
function prepare(pose, time, revision = 1) {
  pose.anchor = structuredClone(anchor); const contacts = enforceActivityPropContacts(rig, pose);
  const solved = solveFullBodyPose(rig, pose, locals, fk);
  const anchors = Object.fromEntries(['L', 'R'].map(side => [`${side === 'L' ? 'left' : 'right'}Hand`, measuredPropHand(rig, pose, fk, side)]));
  return { contacts, solved, avatar: { anchor, pose, time, anchors, snapshot: { activeId: pose.id, revision } } };
}
function sample(id, t, context = {}) { return sampleActivity(id, t, { ...rig.context, ...context }); }
for (const id of ['read_standing', 'read_seated', 'page_turn_standing', 'page_turn_seated', 'read_look_up', 'close_book', 'study_at_desk', 'drink_standing', 'drink_seated', 'write_at_desk']) {
  let maximumGripError = 0, frames = 0;
  for (let frame = 0; frame <= Math.ceil(ACTIVITY_LIBRARY[id].duration * 60); frame++) {
    const pose = sample(id, Math.min(frame / 60, ACTIVITY_LIBRARY[id].duration)), result = prepare(pose, frame / 60);
    assert.equal(result.solved.finite, true); assert.equal(result.contacts.ready, true, `${id}/${frame}`);
    for (const prop of Object.values(result.contacts.props)) maximumGripError = Math.max(maximumGripError, prop.maximumGripError);
    frames++;
  }
  recipes.push({ id, frames, maximumGripError, finite: true });
}
const placements = [];
for (const [id, source] of [['put_book_standing', 'read_standing'], ['put_book_seated', 'close_book'], ['put_mug_standing', 'drink_standing'], ['put_mug_seated', 'drink_seated'], ['put_pencil_seated', 'write_at_desk']]) {
  const props = createActivityProps(new THREE.Scene()), prior = sample(source, ACTIVITY_LIBRARY[source].duration); prepare(prior, 0);
  const context = { initialProps: { ...structuredClone(prior.props), table: true }, initialPose: structuredClone(prior), activityAnchor: anchor };
  const propId = ACTIVITY_LIBRARY[id].propId; let last = null, release = null, maximumStep = 0, maximumGripError = 0, frames = 0;
  for (let frame = 0; frame <= 306; frame++) {
    const time = frame / 60, pose = sample(id, Math.min(time, ACTIVITY_LIBRARY[id].duration), context), result = prepare(pose, time);
    assert.equal(result.solved.finite, true); assert.equal(result.contacts.ready, true, `${id}/${frame}`);
    props.update(pose.props, result.avatar); const rendered = props.snapshot().props[propId];
    assert.equal(rendered.visible, true); assert.deepEqual(rendered.scale, [1, 1, 1]);
    const step = last ? Math.hypot(...rendered.position.map((v, i) => v - last[i])) : 0;
    maximumStep = Math.max(maximumStep, step); last = rendered.position;
    maximumGripError = Math.max(maximumGripError, result.contacts.props[propId]?.maximumGripError ?? 0);
    if (rendered.transfer?.released) {
      release ??= { at: time, ...rendered.transfer, acceptedFrameStep: step };
      context.propTransferReceipts = { [propId]: rendered.transfer };
    }
    trajectories.push({ id, frame, time, phase: pose.phase, attachment: rendered.attachment, position: rendered.position,
      quaternion: rendered.quaternion, scale: rendered.scale, maximumGripError: result.contacts.props[propId]?.maximumGripError ?? 0,
      release: rendered.transfer ?? null, hands: result.avatar.anchors });
    frames++;
  }
  assert.ok(release, `${id}: no measured release`); assert.ok(maximumStep < .15); assert.ok(maximumGripError < .025);
  const final = props.snapshot().props[propId].position;
  props.update({}, { anchor: { position: [10, 0, 9], yaw: 1 } });
  assert.deepEqual(props.snapshot().props[propId].position, final);
  placements.push({ id, source, frames, release, maximumStepPer60HzFrame: maximumStep, maximumGripError, final, persistsAfterWalking: true });
  props.dispose();
}
await mkdir(output, { recursive: true });
const testFiles = ['tests/activity-props.test.mjs', 'tests/activity-prop-execution.test.mjs', 'tests/activity-prop-take.test.mjs',
  'tests/activity-prop-bridge.test.mjs', 'tests/activity-desk-layout.test.mjs'];
const checked = spawnSync(process.execPath, ['--test', ...testFiles], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
await writeFile(path.join(output, 'execution-tests.stdout.log'), checked.stdout ?? '');
await writeFile(path.join(output, 'execution-tests.stderr.log'), checked.stderr ?? '');
if (checked.status !== 0) throw Error(`Prop execution regression failed (${checked.status}); see execution-tests.stdout.log`);
const acceptedEvidence = (checked.stdout ?? '').split(/\r?\n/).filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line.trim()));
const acquisitionEvidence = acceptedEvidence.filter(row => row.acceptance === 'actual-pmx-first-acquisition');
assert.equal(acquisitionEvidence.length, 6, 'all five take variants and the original box need real acquisition evidence');
const sources = ['scripts/action-preparation/validate-prop-execution.mjs', 'preview/core/activity-library.js', 'preview/core/activity-prop-layout.js', 'preview/core/activity-prop-execution.js',
  'preview/core/activity-desk-layout.js', 'preview/core/activity-continuity.js', 'preview/core/full-body-controller.js',
  'preview/core/full-body-ik.js', 'preview/core/motion-skeleton.js', 'realtime/activities/props.mjs', 'assets/Aemeath-inspection.json'];
const hashes = await Promise.all(sources.map(async file => ({ file, sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') })));
verifyFingerprints(sourceDependencies, root);
const report = { schema: 1, generatedAt: new Date().toISOString(), model: 'Aemeath actual PMX inspection skeleton',
  conditions: { fps: 60, unit: 'PMX model units, character height approximately 20.6', scale: [1, 1, 1], cloudCalls: 0,
    scope: 'Actual skeleton FK plus real visible prop geometry; browser MMD grants and continuous visual aesthetics require separate scene review' },
  recipes, placements, acquisitionEvidence, strictRegressionEvidence: acceptedEvidence, testFiles, hashes, sourceDependencies, sourceStable: true,
  limitations: ['Kinematic authoring, no cloth/body collision or rigid-body physics guarantee',
    'Contact is measured at the actual wrist-to-first-middle-finger palm anchor; fingertip skin contact and grasp force are not simulated',
    'Raw recipe curves are measured from a held-item state; real first acquisition and ownership transfer are recorded separately above',
    'Fixed horizontal tabletop and the explicit supported layout are tested; incompatible existing layouts reject instead of silently moving old props',
    'Rendered PMX grants and continuous visual quality require the separate full browser acceptance'] };
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(path.join(output, 'trajectories.jsonl'), trajectories.map(row => JSON.stringify(row)).join('\n') + '\n');
await writeFile(path.join(output, 'report.md'), `# 固定尺寸持物、真实取放与连续交接的本地实测\n\n实际模型骨架按 60 Hz 采样 ${recipes.reduce((n, row) => n + row.frames, 0)} 个已持物原动作帧和 ${placements.reduce((n, row) => n + row.frames, 0)} 个放物帧。物体始终固定尺寸。五种放物均在实际手锚、可见道具几何、桌面接触与速度达到条件后移交，保留接触时的实际世界姿态；走开后物体仍在原处。\n\n${placements.map(row => `- ${row.id}：${row.release.at.toFixed(3)} 秒实际移交；最大握点误差 ${row.maximumGripError.toFixed(6)}；最大逐帧位移 ${row.maximumStepPer60HzFrame.toFixed(6)}。`).join('\n')}\n\n新增五种取物与原箱子取物均有独立真实首接触记录：物体预先在桌面，掌锚到位并静稳后才获得所有权；授前物体不动、不藏，授后才抬起。\n\n${acquisitionEvidence.map(row => `- ${row.id}：首接触握点误差 ${row.firstContactGripError.toExponential(3)}；初抬起速度 ${row.firstLiftLinearSpeed.toExponential(3)} 单位/秒。`).join('\n')}\n\n严格回归还覆盖实际持物跨活动、运动中取消C1、同一刚体的非共线角速度、桌面转向和全部电脑铰链手目标。完整分区桌、三套多物配方的逐30Hz可见网格三角审计另见同级 layout-review*.json；它们不等于布料、人体或受力物理验收。这里只验证掌心锚点与道具几何，不冒充手指皮肤贴附和真实抓握力；实际PMX附加骨变换和连续观感由主浏览器验收补充。\n`);
console.log(JSON.stringify({ output, recipes: recipes.length, placements: placements.length, acquisitions: acquisitionEvidence.length, frames: trajectories.length, maximumStep: Math.max(...placements.map(row => row.maximumStepPer60HzFrame)) }));
