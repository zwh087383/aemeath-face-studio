#!/usr/bin/env node
// Offline preparation only. Existing source profiles and runtime are never changed.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { GESTURES, GESTURE_IDS, EXPANDED_GESTURE_IDS, POSTURES } from '../../preview/core/motion-profile.js';
import { PRESETS, ACTIONS, CHANNELS, C, VOWELS } from '../../preview/core/profile.js';
import { ACTIVITY_LIBRARY, ACTIVITY_IDS, ACTIVITY_SEQUENCES, sampleActivity } from '../../preview/core/activity-library.js';
import { MotionController } from '../../preview/core/motion-controller.js';
import { FaceController } from '../../preview/core/controller.js';
import { FullBodyController } from '../../preview/core/full-body-controller.js';
import { forwardKinematics, skeletonFromInspection } from '../../preview/core/motion-skeleton.js';
import { sampleGestureExpression } from '../../preview/core/expression-choreography.js';
import { fingerprintDependencies } from './source-fingerprints.mjs';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SIDES = ['L', 'R'];
const MOUTH = [...VOWELS, C.mouthWide, C.mouthNarrow, C.mouthFlat];
const round = n => Number.isFinite(n) ? Number(n.toFixed(7)) : null;
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const copy = v => structuredClone(v);
const countBy = (items, key) => items.reduce((out, item) => { const k = typeof key === 'function' ? key(item) : item[key]; out[k] = (out[k] ?? 0) + 1; return out; }, {});
const source = (path, symbol) => `${path}#${symbol}`;
const evidence = (type, ref, detail) => ({ type, sourceRef: ref, detail });
const commonBlockers = ['尚未在真实 PMX 蒙皮上连续观看正面、侧面及中途切换；CPU 轨迹不能证明自然度或衣发无穿插。', '尚未接入统一调度中心；语音、情绪、道具和其它动作同时发生的组合须分别验收。'];
const gestureSituations = Object.freeze({
  explain: '回复正在解释一件事，且这一段有一个适合展开的重点', wave: '你明确要求挥手，或明确的一次相见/告别',
  shrug: '回复明确表示不确定或无可奈何；不能仅因请求返回慢', chest: '表达自己、认真感谢或承诺的一次短强调',
  bow_smile: '明确的礼貌致意或感谢', laugh: '内容确实带笑意，且当前处境允许笑', curious: '她确实有需要追问或弄清的内容',
  shy: '数学情绪与处境共同支持拘谨害羞，而不是每次赞许都固定表演', explain_firm: '明确解释自己的判断或立场，需要一次克制强调',
  surprise: '发生了值得惊讶的新信息，且数学情绪有相应变化', think: '有明确要梳理的内容或真实分析任务，不能由网络等待代替',
  greet: '确认新一次相见或用户请求招呼，避免每个新语音片段重招呼', listen: '注意从原活动转到用户，确实需要一次可见倾听调整',
  comfort: '用户处境需要安慰且当前回复确实表达关怀', look_up: '用户请求舒展，或当前休息活动允许仰头舒展',
  agree: '语义明确赞同或理解，不把用户开始发声等同赞同', micro_ack: '已听完并理解一小段补充，需要轻应一声',
  double_ack: '语义有进一步确认，且刚才没有连续点头', attentive_tilt: '用户仍在说明，适合一次轻微注意调整',
  refocus: '注意目标确实从别处回到用户', thinking_glance: '正在比较或梳理明确内容，允许短暂移开视线',
  recall_up: '回复明确涉及回忆信息，且无需保持强注视', doubtful_tilt: '回复对某项说法提出真实疑问或保留',
  breath_settle: '一段紧张或忙碌阶段结束，需要一次放松收稳', weight_settle: '闲时或较长倾听后调整站姿，支撑条件允许',
  finger_release: '手已经空闲且需要从紧张/保持姿态松开', listening_pause: '对方尚在组织补充，保持等待而非催促',
  small_no: '明确的轻微否定或纠正，不从孤立的“不”字触发', offer_turn: '当前回复确实把说话机会交给对方',
  invite_continue: '用户停顿后仍有继续表达的意思，回复明确邀请继续', clarify: '当前回复正在澄清一个误解或问清条件',
  compare_options: '回复实际比较两个选项，有左右区分的交流作用', enumerate_two: '回复确实列出两项，且能在相应段落及时开始',
  outline_space: '当前解释涉及范围或空间，需要一次展开表达', emphasize_down: '回复有一个值得强调的结论，不跟每个重音重复下压',
  gently_decline: '语义明确婉拒请求，且没有与同意指令冲突', reassure: '回复正在让对方安心，已有事实支持该安慰',
  ask_check: '回复确实询问对方是否理解或确认', present_left: '左侧有可信对象或回复明确把左侧作为选项位置',
  present_right: '右侧有可信对象或回复明确把右侧作为选项位置', relieved: '压力来源确实解除且数学情绪支持放松',
  proud_soft: '成果或赞许事件引发数学情绪变化，适合克制得意', disappointed: '预期落空且数学情绪与处境支持失落',
  embarrassed: '处境明确尴尬或不好意思，并与数学状态相容', skeptical: '对当前说法有明确保留，需要表达怀疑',
  delighted: '值得高兴的新信息使数学状态明显变得积极', concerned: '当前信息涉及关切对象，回复确实表达关心',
  determined: '已经决定一个行动或立场，需要一次坚定表达', grateful: '有具体值得感谢的帮助或回应',
  amused: '轻松内容确实引发笑意，且不是严肃/低落的处境', warm_welcome: '明确的欢迎场合，持续时间允许较完整展开',
  explain_sequence: '回复确实有多个连续解释阶段，且后续语音没有过早结束', celebration_compact: '真实完成或成功事件，用户处境允许庆祝',
  storytelling_arc: '回复正在讲一个有展开和收束的故事，而非很短的答复', reset_and_resolve: '刚才阶段已结束，回复明确转向新的处理决定',
  farewell_linger: '明确告别且当前没有新问题或待续回复',
});

export function numericEntries(value, prefix = '', out = {}) {
  if (typeof value === 'number') out[prefix] = value;
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) numericEntries(child, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

export function validateTimedDefinition(def, { keyed = false } = {}) {
  const errors = [];
  if (!Number.isFinite(def?.duration) || def.duration <= 0) errors.push('duration 必须是正的有限秒数');
  if (keyed) for (const [name, keys] of Object.entries(def.keys ?? {})) {
    if (!Array.isArray(keys) || !keys.length) { errors.push(`${name} 没有关键帧`); continue; }
    keys.forEach((key, i) => {
      if (!Number.isFinite(key[0]) || key[0] < 0 || key[0] > def.duration + 1e-7) errors.push(`${name}[${i}] 时间超出范围`);
      if (i && !(key[0] > keys[i - 1][0])) errors.push(`${name}[${i}] 时间不递增`);
      if (Object.values(numericEntries(key[1])).some(v => !Number.isFinite(v))) errors.push(`${name}[${i}] 含非有限值`);
    });
  }
  if (def?.phases) {
    let end = 0;
    for (const name of ['prepare', 'stroke', 'hold', 'recover']) {
      const range = def.phases[name];
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] < range[0]) errors.push(`${name} 阶段无效`);
      else { if (Math.abs(range[0] - end) > 1e-5) errors.push(`${name} 阶段有间隙或重叠`); end = range[1]; }
    }
    if (Number.isFinite(def.duration) && Math.abs(end - def.duration) > 1e-5) errors.push('退出阶段没有覆盖到结束');
  }
  return errors;
}

function rangesFromFrames(frames, extract = frame => frame) {
  const ranges = {}, nonFinite = [];
  frames.forEach((frame, index) => {
    for (const [key, value] of Object.entries(numericEntries(extract(frame)))) {
      if (!Number.isFinite(value)) { if (nonFinite.length < 20) nonFinite.push({ index, key }); continue; }
      const r = ranges[key] ??= { min: value, max: value };
      r.min = Math.min(r.min, value); r.max = Math.max(r.max, value);
    }
  });
  return { ranges: Object.fromEntries(Object.entries(ranges).map(([k, r]) => [k, { min: round(r.min), max: round(r.max), travel: round(r.max - r.min) }])), nonFinite };
}

export function scanActivity(def, sampler, fps = 60) {
  const errors = validateTimedDefinition(def);
  if (errors.length) return { errors, samples: 0 };
  if (!Number.isFinite(fps) || fps < 10 || fps > 240) throw new RangeError('fps must be between 10 and 240');
  const count = Math.ceil(def.duration * fps);
  const frames = Array.from({ length: count + 1 }, (_, i) => copy(sampler(def.id, Math.min(i / fps, def.duration))));
  const summary = rangesFromFrames(frames, p => ({ root: p.root, pelvis: p.pelvis, body: p.body, hands: p.hands, feet: p.feet }));
  const phaseWindows = [];
  frames.forEach((p, i) => {
    const last = phaseWindows.at(-1), phase = p.phase ?? 'unlabelled';
    if (last?.phase === phase) last.lastSampleSeconds = round(p.time ?? i / fps);
    else phaseWindows.push({ phase, firstSampleSeconds: round(p.time ?? i / fps), lastSampleSeconds: round(p.time ?? i / fps) });
  });
  const props = {}, contacts = Object.fromEntries(SIDES.map(s => [s, { plantedSamples: 0, unplantedSamples: 0, maxPlantedStep: 0, plantedSlipIntervals: 0, maxQuaternionNormError: 0 }]));
  let airborneSamples = 0, maxRootStep = 0;
  const attachmentChanges = [];
  frames.forEach((p, i) => {
    if (p.support === 'airborne') airborneSamples++;
    for (const [id, value] of Object.entries(p.props ?? {})) {
      const entry = props[id] ??= { firstSeenSeconds: p.time, attachments: [], finalValue: null };
      const attach = value && typeof value === 'object' ? value.attachment : 'scene';
      if (!entry.attachments.includes(attach)) entry.attachments.push(attach);
      entry.finalValue = value;
      const before = frames[i - 1]?.props?.[id];
      if (i && typeof value === 'object' && before && typeof before === 'object' && value.attachment !== before.attachment) attachmentChanges.push({ id, seconds: round(p.time), from: before.attachment ?? 'scene', to: value.attachment ?? 'scene' });
    }
    for (const side of SIDES) {
      const foot = p.feet?.[side], previous = frames[i - 1]?.feet?.[side], entry = contacts[side];
      if (!foot) { errors.push(`sample ${i}: 缺少 ${side} 脚`); continue; }
      if (foot.contact) entry.plantedSamples++; else entry.unplantedSamples++;
      if (foot.rotation) entry.maxQuaternionNormError = Math.max(entry.maxQuaternionNormError, Math.abs(Math.hypot(...foot.rotation) - 1));
      if (previous?.contact && foot.contact) {
        const step = distance(previous.position, foot.position);
        entry.maxPlantedStep = Math.max(entry.maxPlantedStep, step);
        if (step > 1e-7) entry.plantedSlipIntervals++;
      }
    }
    if (i) maxRootStep = Math.max(maxRootStep, distance(p.root.position, frames[i - 1].root.position));
  });
  const endpoint = p => ({ support: p.support, phase: p.phase, root: p.root, pelvis: p.pelvis, feet: p.feet, hands: p.hands, props: p.props, face: p.face });
  const last = frames.at(-1), held = sampler(def.id, def.duration + 1);
  return { errors, samples: frames.length, fps, units: 'PMX 模型单位；角为弧度；+Y向上、+Z向前、+X角色左；默认模型体型和默认家具位置', numeric: summary,
    observedPhaseWindows: phaseWindows, phaseBoundaryAccuracySeconds: round(1 / fps), supports: countBy(frames, 'support'), airborneSamples,
    contacts: Object.fromEntries(Object.entries(contacts).map(([s, value]) => [s, { ...value, maxPlantedStep: round(value.maxPlantedStep), maxQuaternionNormError: round(value.maxQuaternionNormError) }])),
    maxRootStep: round(maxRootStep), maxRootSpeed: round(maxRootStep * fps), props, attachmentChanges,
    entryPose: endpoint(frames[0]), exitPose: endpoint(last), endpointHeldBeyondDuration: JSON.stringify(endpoint(last)) === JSON.stringify(endpoint(held)),
    actuallyVaryingNumericChannels: Object.entries(summary.ranges).filter(([, r]) => r.travel > 1e-7).map(([k]) => k),
  };
}

function makeMotion(skeleton, continuity = false) {
  const c = new MotionController({ skeleton, seed: 20261023 });
  c.setOptions({ natural: false, continuity, intensity: 1, speed: 1 }); c.setPosture('relaxed', 0);
  for (let i = 0; i <= 48; i++) c.update(i / 30, 1 / 30);
  return c;
}

function motionPointFrame(c) {
  const fk = forwardKinematics(c.rig, c.locals), points = {};
  for (const side of SIDES) {
    const n = c.rig.sides[side].names;
    for (const [key, name] of [['wrist', n.wrist], ['elbow', n.elbow], ['shoulder', n.arm]]) points[`${side}.${key}`] = [...fk.get(name).position];
  }
  for (const [key, value] of Object.entries(c.rig.torso)) points[key] = [...fk.get(value.name).position];
  return { points, body: { ...c.bodyState }, head: { ...c.head }, reach: Object.fromEntries(SIDES.map(s => [s, c.diag[s].reach])), supportError: c.snapshot().support.error };
}

export function scanGestureKeys(def) {
  const errors = validateTimedDefinition(def, { keyed: true });
  const tracks = Object.fromEntries(Object.entries(def.keys ?? {}).map(([name, keys]) => [name, {
    keyCount: keys.length, first: keys[0], last: keys.at(-1), stopTimes: keys.filter(k => k[2] === 'stop').map(k => k[0]),
    ...rangesFromFrames(keys, k => k[1]),
  }]));
  return { errors, tracks, declaredPhases: copy(def.phases), nominalDurationSeconds: def.duration, nominalApexSeconds: def.apex,
    declaredInterruptRecoverSeconds: def.recover, additive: !!def.additive, declaredParticipatingTracks: [...def.tracks] };
}

function scanGesture(id, skeleton, fps) {
  const def = GESTURES[id], c = makeMotion(skeleton), start = c.now;
  if (!c.trigger(id, `prepare-${id}`, start)) throw new Error(`gesture not accepted: ${id}`);
  const frames = [], observed = [], faces = []; let maxWristStep = 0, maxElbowLateralFromShoulder = 0;
  const limit = Math.ceil((def.duration * 2 + 2) * fps);
  for (let i = 0; i <= limit; i++) {
    c.update(start + i / fps, 1 / fps); const frame = motionPointFrame(c), g = c.snapshot().gestures[0];
    frames.push(frame);
    if (g) { const last = observed.at(-1); if (last?.phase === g.phase) last.lastSeconds = round(i / fps); else observed.push({ phase: g.phase, firstSeconds: round(i / fps), lastSeconds: round(i / fps), prepareStretch: g.stretch, recoverStretch: g.recoverStretch }); faces.push(Array.from(sampleGestureExpression(id, g.age))); }
    for (const side of SIDES) {
      if (i) maxWristStep = Math.max(maxWristStep, distance(frame.points[`${side}.wrist`], frames[i - 1].points[`${side}.wrist`]));
      maxElbowLateralFromShoulder = Math.max(maxElbowLateralFromShoulder, Math.abs(frame.points[`${side}.elbow`][0] - frame.points[`${side}.shoulder`][0]));
    }
    if (i > 1 && !g && c.pending.length === 0) break;
  }
  return { ...scanGestureKeys(def), cpuPose: { method: '真实 inspection 骨位置导入，现有 MotionController 和 forwardKinematics；固定 relaxed 入口、关闭自然摆动、continuity=false', fps, frames: frames.length,
    runSeconds: round((frames.length - 1) / fps), observedPhases: observed, numeric: rangesFromFrames(frames), entryPose: frames[0], exitPose: frames.at(-1),
    maxWristStep: round(maxWristStep), maxWristSpeed: round(maxWristStep * fps), maxElbowLateralFromShoulder: round(maxElbowLateralFromShoulder),
    expressionMax: Object.fromEntries(CHANNELS.map((name, i) => [name, round(Math.max(0, ...faces.map(f => f[i])))]).filter(([, v]) => v > 0)),
    limitation: '不含 three-mmd grants 后的蒙皮、衣发模拟和渲染；单一入口轨迹不是任意姿态或组合验收。' } };
}

function gestureCancelProbes(id, skeleton, fps) {
  const def = GESTURES[id], probes = [];
  for (const phase of ['prepare', 'stroke', 'hold', 'recover']) {
    const targetAge = (def.phases[phase][0] + def.phases[phase][1]) / 2;
    const c = makeMotion(skeleton), start = c.now; c.begin(1); c.trigger(id, `cancel-${id}-${phase}`, start);
    let elapsed = 0, active;
    for (let i = 0; i < (def.duration * 2 + 2) * fps; i++) {
      elapsed = i / fps; c.playback(1, 'playing', elapsed); c.update(start + elapsed, 1 / fps);
      active = c.snapshot().gestures[0]; if (active?.age >= targetAge) break;
    }
    const before = motionPointFrame(c), accepted = c.cancel(1, c.now), staleAccepted = c.enqueue({ id: `stale-${id}-${phase}`, kind: 'gesture', gesture: id, epoch: 1, at: elapsed });
    let pendingAtEnd = null, maxFirstStep = 0, nonFinite = false, endedAfterSeconds = null;
    for (let i = 1; i <= fps * 5; i++) {
      c.update(start + elapsed + i / fps, 1 / fps); const pose = motionPointFrame(c);
      nonFinite ||= Object.values(numericEntries(pose)).some(v => !Number.isFinite(v));
      if (i === 1) maxFirstStep = Math.max(...SIDES.map(s => distance(before.points[`${s}.wrist`], pose.points[`${s}.wrist`])));
      pendingAtEnd = c.snapshot().gestures.length;
      if (!pendingAtEnd) { endedAfterSeconds = round(i / fps); break; }
    }
    probes.push({ requestedPhase: phase, nominalAge: round(targetAge), actualAgeAtCancel: round(active?.age), actualPhaseAtCancel: active?.phase ?? null,
      cancelAccepted: accepted, staleEpochAcceptedAfterCancel: staleAccepted, remainingGestures: pendingAtEnd, exitedAfterSeconds: endedAfterSeconds,
      firstPostCancelWristStep: round(maxFirstStep), nonFinite,
      limitation: '固定单手势、单入口、continuity=false 的控制器取消探针；第一步位移不是速度连续、碰撞或真实语音打断证明。' });
  }
  return probes;
}

function faceState(c) { return { weights: Object.fromEntries(CHANNELS.map((key, i) => [key, c.weights[i]])), head: { ...c.head } }; }

function scanPreset(preset, fps) {
  const c = new FaceController(); c.headSway = false; c.setPreset(preset.id, 1);
  const frames = []; for (let i = 0; i <= fps * 2; i++) { c.update(i / fps, 1 / fps, null, false); frames.push(faceState(c)); }
  const speech = new FaceController(), reference = new FaceController(); speech.headSway = false; reference.headSway = false;
  speech.setPreset(preset.id, 1); speech.begin(1); reference.begin(1);
  const weights = new Float32Array(CHANNELS.length); weights[C.a] = .18; weights[C.u] = .11; weights[C.mouthNarrow] = .22;
  let mouthDeviation = 0;
  for (let i = 0; i <= fps * 2; i++) {
    const lip = { weights, closure: i > fps ? 1 : 0 };
    speech.update(i / fps, 1 / fps, lip, false, { mouthMode: 'speech' }); reference.update(i / fps, 1 / fps, lip, false, { mouthMode: 'speech' });
    mouthDeviation = Math.max(mouthDeviation, ...MOUTH.map(ch => Math.abs(speech.weights[ch] - reference.weights[ch])));
  }
  speech.cancel(1); const baseAfterCancel = speech.base;
  const authoredMouthChannels = Object.keys(preset.morphs).filter(name => MOUTH.includes(C[name]));
  return { kind: 'static-semantic-target', authoredTargets: copy(preset.morphs), authoredTiltRadians: preset.tilt, recommendedMicroAction: preset.microAction ?? null,
    fps, samples: frames.length, elapsedSeconds: 2, numeric: rangesFromFrames(frames), settledOutput: frames.at(-1), authoredMouthChannels,
    speechOwnershipProbe: { method: '相同 lip 输入下与 neutral 控制器逐帧比较，仅检查元音/口宽/口窄/平口，不把嘴角作为发音通道', protectedMouthMaximumDeviation: round(mouthDeviation), baseAfterCancel,
      limitation: '仅现有 FaceController 语义权重，未验证 PMX group morph 展开后的蒙皮或另一路原生表情合成。' } };
}

export function scanMicroAction(id, definition, fps = 60) {
  const c = new FaceController(); c.headSway = false; c.begin(1);
  if (!c.trigger(id, `micro-${id}`, 0)) throw new Error(`Unknown controller micro-action: ${id}`);
  const frames = [];
  for (let i = 0; i <= Math.ceil((definition.duration + .8) * fps); i++) {
    const now = i / fps; c.playback(1, 'playing', now); c.update(now, 1 / fps, null, false); frames.push(faceState(c));
  }
  const cancel = new FaceController(); cancel.headSway = false; cancel.begin(1); cancel.trigger(id, `cancel-micro-${id}`, 0);
  const cut = Math.ceil(definition.duration * .5 * fps);
  for (let i = 0; i <= cut; i++) { cancel.playback(1, 'playing', i / fps); cancel.update(i / fps, 1 / fps, null, false); }
  const before = faceState(cancel), accepted = cancel.cancel(1);
  for (let i = 1; i <= fps; i++) cancel.update(cut / fps + i / fps, 1 / fps, null, false, { mouthMode: 'closed' });
  return { durationSeconds: definition.duration, axis: definition.axis ?? 'blink', authoredKeys: definition.keys ?? null, fps, samples: frames.length,
    numeric: rangesFromFrames(frames), entryPose: frames[0], exitPose: frames.at(-1),
    cancellationProbe: { ageSeconds: round(cut / fps), accepted, before, afterOneSecond: faceState(cancel), remainingCues: cancel.cues.length, baseAfterCancel: cancel.base },
    limitation: '实际 FaceController 单反应采样；头部与身体控制器同时写头、眼球真实注视及任意时刻取消的速度接缝未验收。' };
}

function activityCancelProbes(id, skeleton, fps) {
  const d = ACTIVITY_LIBRARY[id], probes = [];
  for (const fraction of [.2, .5, .8]) {
    const c = new FullBodyController({ skeleton }); c.play(id); let now = 0, ready = false;
    for (let i = 0; i < 15 * fps; i++) {
      now += 1 / fps; c.update(now, 1 / fps);
      if (c.activeId === id && !c.bridge) { ready = true; break; }
    }
    if (!ready) { probes.push({ fraction, setupFailed: true }); continue; }
    for (let i = 0; i < Math.ceil(d.duration * fraction * fps) && !c.done; i++) { now += 1 / fps; c.update(now, 1 / fps); }
    const before = c.snapshot(); c.stop(); const immediate = c.snapshot(); let timeToDone = null, nonFinite = false;
    for (let i = 1; i <= fps * (d.duration + 6); i++) {
      now += 1 / fps; c.update(now, 1 / fps); nonFinite ||= Object.values(numericEntries({ pose: c.pose, locals: Object.fromEntries(c.locals) })).some(v => !Number.isFinite(v));
      if (c.done) { timeToDone = round(i / fps); break; }
    }
    const after = c.snapshot();
    probes.push({ fraction, activityAgeAtStop: round(before.elapsed), phaseAtStop: before.phase, supportAtStop: before.support,
      immediateStatus: immediate.status, immediateStopMode: immediate.stopMode, done: after.done, finalStatus: after.status,
      finalSupport: after.support, finalContacts: after.contacts, finalProps: Object.keys(after.pose.props ?? {}),
      rootPreservedXZError: round(Math.hypot(after.root.position[0] - before.root.position[0], after.root.position[2] - before.root.position[2])),
      timeToDoneSeconds: timeToDone, nonFinite, limitation: '真实骨架控制器、默认场景的停止探针；运行时道具承接、脚掌接触与衣发画面未验收。' });
  }
  return probes;
}

function gestureUsage(id, d) {
  const micro = d.category === 'micro';
  const emotion = d.category === 'emotion' || ['shy', 'surprise', 'laugh', 'comfort'].includes(id);
  return { purpose: d.description ?? d.note ?? d.name,
    trigger: `${gestureSituations[id] ?? '已有事件明确需要该交流作用'}。${emotion ? '模型辅助理解发生的事，最终情绪读取已有数学系统；本地决定是否表现。' : '当前 Qwen 理解语义或本地程序报告真实事件，本地核实当前时机。'}`,
    triggerBasis: '这是一份为未来调度编写的使用约定；未声称当前模型已稳定输出此含义。读当前上下文、否定/引用/更正、有效轮次、数学状态与实际身体。',
    triggerUnknown: '目的、对象或时机不清楚时不启动这个动作；保留倾听或当前可靠姿态，语音继续。',
    preconditions: ['当前会话/轮次或闲时活动仍有效。', '先使用本次采样覆盖的空手站姿入口；坐姿与持物版本未开放。', `${d.tracks.join('、')} 的写入权限已取得。`, ...(micro ? ['即使为增量微动作，也需确认当前原生姿态允许这个叠加。'] : [])],
    prohibited: ['攻击用途。', '持书、持杯或双手约束时直接覆盖手臂。', '站坐转换、腾空、落座途中直接套用。', '同类反应反复触发，或动作到达时表达时机已过。'],
    entry: '先读取当前显示的姿态和速度；本次证据只测了 relaxed 空手站姿，不代表任意入口。',
    exit: `按原有 recover 阶段收回；名义取消回收基准 ${d.recover}s，实际会按手到目标的距离延长。保留身体幅度、近身肘部与挥手主体节奏。`,
    cancel: { judge: '本地主机确认旧轮次失效后调用 MotionController.cancel；手动审阅使用 retract。', basis: '已执行阶段与当前显示手势贡献；撤销未来 audio cues，随后用本地时钟回收。', unknown: '不接受新冲突动作；继续可信的当前回收，不能突然归位。', caveat: '默认 continuity=false；现有局部连续功能不是原生全身、持物或衣发统一过渡。' } };
}

function activityUsage(d, measurement) {
  const props = [...new Set([...(d.requires ?? []), ...Object.keys(measurement.props ?? {})])];
  const moving = ['locomotion', 'running', 'jumping'].includes(d.category), seated = d.initialSupport === 'seated';
  return { purpose: d.description ?? d.name, trigger: moving || d.category === 'exercise' ? '用户明确请求，或已有活动计划选择；不因普通解释一句话自行跑跳。' : '用户请求或仍有效的闲时活动计划；交谈优先时先检查可停阶段。',
    preconditions: [`入口支撑为 ${d.initialSupport}，结束要求 ${d.endSupport}。`, ...(props.length ? [`必须确认道具/支撑存在且可达：${props.join('、')}。`] : ['空手且所需身体部位可用。']),
      ...(moving ? ['路径、落脚区和落地区可用；本次只按默认平地采样，没有场景导航或障碍物检查。'] : []), ...(seated ? ['座椅位置、高度与本次默认体型相容；不能只相信 requires 标签。'] : [])],
    prohibited: ['攻击用途。', '其它控制器同时写同一身体、嘴形或持物位置。', '道具失效、路径被占用或入口姿势不明时盲目开始。'],
    entry: '现有 FullBodyController 会补坐下/站起前置，并用踏步桥接；是否真的应该起身由新调度器判断，不能由文件所需姿态反推用户意图。',
    exit: '保留动作实际位移、朝向、支撑和仍持有的物品；不能把 ended 解释成自动站回原点或完成放物。',
    cancel: { judge: '本地取消旧活动或切换交谈后调用 FullBodyController.stop。', basis: '实际 support、双脚 contact、骨盆下降量与当前阶段。',
      behavior: '腾空先落地；已明显下降的落座先坐稳；已坐姿保持当前手和道具；其余进入站姿回稳。', unknown: '保留可信支撑与持物，禁止新危险移动；需要现场恢复，不假设椅子或桌面仍存在。',
      caveat: 'stop 保护是控制器规则；不是每个道具交接与每个任意帧都已自然。坐姿 holdSeat 可保留运动中手部，仍需补单独收势。' } };
}

function checkBlockers(measurement, extras = []) {
  const blockers = [...commonBlockers, ...extras];
  if (measurement.errors?.length) blockers.push(...measurement.errors);
  if (measurement.numeric?.nonFinite?.length || measurement.cpuPose?.numeric?.nonFinite?.length) blockers.push('实际采样出现非有限数，必须修复后才可使用。');
  return blockers;
}

export async function buildAuthoredCatalog({ fps = 60, root = REPOSITORY_ROOT, select = null, cancellation = true } = {}) {
  if (!Number.isFinite(fps) || fps < 10 || fps > 240) throw new RangeError('fps must be between 10 and 240');
  const started = performance.now(), inspection = JSON.parse(readFileSync(resolve(root, 'assets/Aemeath-inspection.json'), 'utf8'));
  const skeleton = skeletonFromInspection(inspection), items = [], use = (kind, id) => !select || select.includes(`${kind}:${id}`);
  const files = ['preview/core/motion-profile.js', 'preview/core/expanded-motion-library.js', 'preview/core/profile.js', 'preview/core/expanded-expression-library.js',
    'preview/core/activity-library.js', 'preview/core/motion-controller.js', 'preview/core/full-body-controller.js', 'preview/core/controller.js', 'preview/core/expression-choreography.js', 'assets/Aemeath-inspection.json'];
  const sources = fingerprintDependencies([...files, 'scripts/action-preparation/prepare-authored.mjs'], root);
  for (const id of GESTURE_IDS) if (use('gesture', id)) {
    const d = GESTURES[id], ref = source(EXPANDED_GESTURE_IDS.includes(id) ? 'preview/core/expanded-motion-library.js' : 'preview/core/motion-profile.js', `GESTURES.${id}`);
    const measurements = scanGesture(id, skeleton, fps); measurements.cancellationProbes = cancellation ? gestureCancelProbes(id, skeleton, fps) : [];
    items.push({ id: `authored-gesture:${id}`, runtimeId: id, kind: 'gesture', name: d.name, category: d.category ?? 'original', sourceRef: ref,
      measurements, usage: gestureUsage(id, d), blockers: checkBlockers(measurements),
      evidence: [evidence('source-profile', ref, '读取全部关键帧、阶段、手位和关联表情；标签用于组织，轨迹单独采样。'), evidence('cpu-real-skeleton-sampling', 'preview/core/motion-controller.js#MotionController', '使用当前真实 inspection 骨位置，固定入口和随机种子；无渲染、无云。')],
      automaticEligible: false, preparationStatus: 'source-and-cpu-sampled-awaiting-visual-and-integration' });
  }
  for (const p of PRESETS) if (use('expression', p.id)) {
    const ref = source('preview/core/profile.js', `PRESET_BY_ID.${p.id}`), measurements = scanPreset(p, fps);
    items.push({ id: `authored-expression:${p.id}`, runtimeId: p.id, kind: 'expression', name: p.name, category: p.category ?? 'original', sourceRef: ref, measurements,
      usage: { purpose: p.note, trigger: '已有数学情绪/处境的有效变化，或有依据的一次短表达；不能据预设名称反推内心状态。',
        preconditions: ['表情合成器已获得相关眉眼/嘴角的写入权。', '配方只定义目标形状；进入、保持、退回上次情绪另由导演决定。'],
        prohibited: ['直接覆盖实时发音通道。', '重复刷新并重启相同表情。', '将推荐微动作无条件同时触发。'],
        entry: '由当前显示权重逐渐接近目标；本次测试从 neutral 开始。', exit: '应回到持续的数学情绪底色；现有 FaceController.cancel 会把 base 设 neutral，尚不能冒充保留情绪已完成。',
        cancel: { judge: '本地旧表达失效，或权威数学状态更新。', basis: '表达所属轮次和实际显示权重。', unknown: '维持最后可信眉眼状态，并继续让发音层拥有嘴形。' } },
      blockers: checkBlockers(measurements, ['尚未验证形变分组展开和真实蒙皮可见效果；目标权重不是完成动画。', '取消后恢复数学情绪底色的桥接待做。']),
      evidence: [evidence('semantic-controller-sampling', ref, '实际 FaceController 2 秒权重采样，并以相同 lip 输入与 neutral 对照发音通道。')], automaticEligible: false,
      preparationStatus: 'target-and-speech-ownership-sampled-awaiting-morph-and-timing-review' });
  }
  for (const [id, d] of Object.entries(ACTIONS)) if (use('micro', id)) {
    const ref = source('preview/core/profile.js', `ACTIONS.${id}`), measurements = scanMicroAction(id, d, fps);
    items.push({ id: `authored-micro:${id}`, runtimeId: id, kind: 'micro', name: d.name, category: d.category ?? 'original', sourceRef: ref, measurements,
      usage: { purpose: d.note ?? d.name, trigger: id === 'blink' ? '独立眨眼时机；当前眼闭合约束允许。' : '当前事件确实有应声、赞同、否认或注意转移的含义；从语义而非发声开始猜赞同。',
        preconditions: ['头眼通道与正在执行的身体动作不冲突。', '头部目标朝向和用户方向仍可信。'], prohibited: ['当作真实眼球注视。', '重复点头来填满沉默。', '叠加到已经强烈转头或落座的过程而未检查。'],
        entry: '从当前头部姿态接入小幅增量；本次单反应从 neutral 测。', exit: '关键帧回到零增量，再随现有控制器平滑收住；不是回到世界固定正前方。',
        cancel: { judge: '旧轮次失效或新的注意任务。', basis: '实际头部输出与动作剩余关键帧。', unknown: '停止新反应并逐步收住；不瞬间清空头部姿态。', caveat: '当前 cancel 会清空 cues 并把 base 设 neutral；头部平滑不等于任意时刻速度连续。' } },
      blockers: checkBlockers(measurements, ['与全身/原生头部共同合成的唯一写入者待接入。']), evidence: [evidence('controller-sampling', ref, '真实 FaceController 单反应全程及中段取消；关闭闲时摆头和自主眨眼。')],
      automaticEligible: false, preparationStatus: 'single-controller-sampled-awaiting-composition-review' });
  }
  const activityMeasurements = new Map();
  for (const id of ACTIVITY_IDS) if (use('activity', id) || !select) {
    const d = ACTIVITY_LIBRARY[id], ref = source('preview/core/activity-library.js', `ACTIVITY_LIBRARY.${id}`), measurements = scanActivity(d, sampleActivity, fps);
    activityMeasurements.set(id, measurements); measurements.cancellationProbes = cancellation ? activityCancelProbes(id, skeleton, fps) : [];
    const extras = [];
    if (Object.keys(measurements.props ?? {}).length) extras.push('道具可见/attachment 标签不证明拿放完成；固定尺寸握点、承接与场景持续性须逐项验收。');
    if (measurements.attachmentChanges.length) extras.push('检测到按时间切换的 attachment；尚未检查松手/抓取是否满足真实接触条件。');
    if (Object.values(measurements.contacts).some(c => c.plantedSlipIntervals)) extras.push('默认参数采样发现双帧均标接触时足目标发生移动；须检查源动作或接触标签。');
    if (d.reading) extras.push('当前持书显示会按双手距离缩放书；固定尺寸持书与放书过程尚未完成。');
    items.push({ id: `authored-activity:${id}`, runtimeId: id, kind: 'activity', name: d.name, category: d.category, sourceRef: ref, measurements,
      usage: activityUsage(d, measurements), blockers: checkBlockers(measurements, extras),
      evidence: [evidence('sampled-procedural-activity', ref, `sampleActivity 默认模型参数下 ${fps} Hz 全程采样，实际支撑/脚接触/道具/根位移与阶段。`), evidence('real-skeleton-stop-probes', 'preview/core/full-body-controller.js#FullBodyController.stop', '在20%、50%、80%时调用真实控制器 stop；自动前置和桥接也通过现有控制器。')],
      automaticEligible: false, preparationStatus: 'source-and-cpu-sampled-awaiting-scene-and-visual-review' });
  }
  for (const [id, sequence] of Object.entries(ACTIVITY_SEQUENCES)) if (use('sequence', id)) {
    const segments = sequence.steps.map(step => {
      if (!activityMeasurements.has(step)) activityMeasurements.set(step, scanActivity(ACTIVITY_LIBRARY[step], sampleActivity, fps));
      const m = activityMeasurements.get(step); return { id: `authored-activity:${step}`, runtimeId: step, durationSeconds: ACTIVITY_LIBRARY[step].duration,
        startSupport: m.entryPose.support, endSupport: m.exitPose.support, startProps: Object.keys(m.entryPose.props ?? {}), endProps: Object.keys(m.exitPose.props ?? {}) };
    });
    const boundaries = segments.slice(0, -1).map((a, i) => {
      const b = segments[i + 1], am = activityMeasurements.get(a.runtimeId), bm = activityMeasurements.get(b.runtimeId);
      return { from: a.id, to: b.id, supportMatches: a.endSupport === b.startSupport,
        omittedPriorProps: a.endProps.filter(p => !b.startProps.includes(p)),
        rawRootGapModelUnits: round(distance(am.exitPose.root.position, bm.entryPose.root.position)),
        rawWristGapModelUnits: Object.fromEntries(SIDES.map(s => [s, round(distance(am.exitPose.hands[s].hand, bm.entryPose.hands[s].hand))])),
        interpretation: '原始片段局部端点比较，只提示需要桥接/保留道具；不能当作 director 最终世界姿态接缝。' };
    });
    items.push({ id: `authored-sequence:${id}`, runtimeId: id, kind: 'sequence', name: sequence.name, category: 'continuous-activity', sourceRef: source('preview/core/activity-library.js', `ACTIVITY_SEQUENCES.${id}`),
      measurements: { segments, nominalDurationSeconds: round(segments.reduce((sum, p) => sum + p.durationSeconds, 0)), boundaryRequirements: boundaries,
        limitation: '这里只准备组合配方和子片段证据；未把独立采样拼接成完整演出，也未给自动就绪资格。' },
      usage: { purpose: sequence.description, trigger: '已有活动计划或用户明确请求，且全部相关场景资源存在。',
        preconditions: ['每段入口已核实，跨段物品和座椅保留方式已准备。', '允许在交谈/打断后停止剩余步骤，并从真实现场重新判断恢复。'],
        prohibited: ['把列表顺序当作已验证自然过渡。', '取消后无条件从头重播，或重放已经完成的拿放。'],
        entry: '逐段检查真实身体和现场；不按局部坐标从原点重放。', exit: '完成最后片段后保留实际现场；业务活动是否完成由业务系统确认。',
        cancel: { judge: '本地活动计划失效或交谈接管。', basis: '当前子段实际执行阶段、支撑和持物状态。', unknown: '暂停后续步骤，保留可信身体/现场，重新验证后再恢复。' } },
      blockers: [...commonBlockers, '跨段完整播放、所有阶段打断、场景持物持续性和活动恢复尚未验收。'],
      evidence: [evidence('recipe-and-child-sampling', 'preview/core/activity-library.js#ACTIVITY_SEQUENCES', '实际读取每个步骤并引用对应子动作全程样本，记录入口出口不匹配与道具省略。')],
      automaticEligible: false, preparationStatus: 'recipe-and-child-evidence-prepared-awaiting-continuous-acceptance' });
  }
  return { schema: 'aemeath-preparation/v1', kind: 'authored', generatedAt: new Date().toISOString(),
    sourceScope: '当前本地原创和程序库；不把同名或变体计为新原生素材，不修改任何原动作。measurements/evidence 记录本次观测，usage 是为未来调度编制的约定，不能当作已接入运行规则。', sources, items,
    summary: { total: items.length, byKind: countBy(items, 'kind'), byCategory: countBy(items, 'category'), automaticEligible: 0,
      fps, generationSeconds: round((performance.now() - started) / 1000), inventory: { publicGestures: GESTURE_IDS.length, expressions: PRESETS.length,
        headAndBlinkActions: Object.keys(ACTIONS).length, activities: ACTIVITY_IDS.length, sequences: Object.keys(ACTIVITY_SEQUENCES).length },
      evidenceScope: '读取原配方 + 实际控制器/程序采样；真实骨位置 FK 仍不等于渲染、衣发、语音时序或完整组合验收。',
      sourceProfileErrors: items.filter(i => i.measurements.errors?.length || i.measurements.numeric?.nonFinite?.length || i.measurements.cpuPose?.numeric?.nonFinite?.length).map(i => i.id),
      cancellationFailures: items.filter(i => i.measurements.cancellationProbes?.some(p => p.setupFailed || p.nonFinite || p.cancelAccepted === false || p.staleEpochAcceptedAfterCancel || p.remainingGestures > 0 || p.done === false)).map(i => i.id) } };
}

export function renderNotes(catalog) {
  const s = catalog.summary;
  return `# 原创动作前期准备记录\n\n这次实际读取并采样了 ${s.total} 项：${Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join('、')}。这是整理和离线检查，自动开放数仍为 0。\n\n` +
    `手势使用当前模型 inspection 的真实骨位置和现有控制器，关闭自然摆动，固定 relaxed 空手站姿；采样 ${s.fps} Hz，保留现有幅度、近身肘部、利落挥手。表情用真实 FaceController 检查目标和语音口型所有权。活动实际采样支撑脚、位移、道具和阶段，并在 20%、50%、80%调用现有控制器停止。\n\n` +
    `不能据此声称所有组合自然：没有在 three-mmd grants 后的真实蒙皮上看连续画面，没有检验头发裙摆、任意家具位置、持物承接和真实语音时序。阶段标签只说明源程序如何分段，未把它冒充已验可停窗口。\n\n` +
    `## 实际发现的准备缺口\n\n` +
    `- FaceController.cancel 当前把 base 改为 neutral，仍需接回数学情绪底色。\n- MotionController 默认 continuity=false；局部接续能力不能代替原生全身和道具过渡。\n- 持书仍有按手距缩放的问题；合书仍然持书，不是放书。\n- 物品 attachment 的时间切换只证明程序切换，未证明手到握点或物品落到承接面。\n- 坐姿 stop 会保持手和道具，未证明中途运动的双手都有自然收势。\n- 全部连续序列只整理配方与子段证据，跨段需要保留世界位置、支撑和道具，并重新验收。\n\n` +
    `源定义或非有限值问题：${s.sourceProfileErrors.length ? s.sourceProfileErrors.join('、') : '本轮未检出'}。取消探针失败：${s.cancellationFailures.length ? s.cancellationFailures.join('、') : '本轮未检出'}。未检出失败不等于完整验收。\n\n` +
    `## 每个动作的说明\n\n` + catalog.items.map(item => `### ${item.name}（${item.id}）\n\n用途：${item.usage.purpose}。触发：${item.usage.trigger}\n\n先满足：${item.usage.preconditions.join(' ')}\n\n不要用于：${item.usage.prohibited.join(' ')}\n\n进入：${item.usage.entry}\n\n退出：${item.usage.exit}\n\n取消由谁判断：${item.usage.cancel.judge} 依据：${item.usage.cancel.basis} 判断不出：${item.usage.cancel.unknown}\n\n还缺：${item.blockers.join(' ')}\n`).join('\n');
}

export function parseArgs(args) {
  const options = { output: resolve(REPOSITORY_ROOT, 'outputs/action-preparation-20261023/authored.json'), notes: resolve(REPOSITORY_ROOT, 'outputs/action-preparation-20261023/authored-notes.md'), fps: 60 };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--output' || flag === '--notes') { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${flag} needs a path`); options[flag.slice(2)] = resolve(args[++i]); }
    else if (flag === '--fps') { options.fps = Number(args[++i]); if (!Number.isFinite(options.fps) || options.fps < 10 || options.fps > 240) throw new RangeError('--fps must be between 10 and 240'); }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.output === options.notes) throw new Error('output and notes must have different paths');
  return options;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2)), catalog = await buildAuthoredCatalog({ fps: options.fps });
    mkdirSync(dirname(options.output), { recursive: true }); mkdirSync(dirname(options.notes), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8'); writeFileSync(options.notes, renderNotes(catalog), 'utf8');
    console.log(JSON.stringify({ output: relative(REPOSITORY_ROOT, options.output), notes: relative(REPOSITORY_ROOT, options.notes), ...catalog.summary }, null, 2));
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
