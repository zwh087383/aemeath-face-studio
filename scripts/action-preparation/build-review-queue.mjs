import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = 'aemeath-review-queue/v1';
const unique = xs => [...new Set(xs)];
const hash = value => createHash('sha256').update(value).digest('hex');
const strings = value => (Array.isArray(value) ? value : value == null ? [] : [value]).filter(x => typeof x === 'string');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const byKind = items => Object.fromEntries(unique(items.map(x => x.kind)).sort().map(kind => [kind, items.filter(x => x.kind === kind).length]));
const round = number => Number.isFinite(number) ? Math.round(number * 1e6) / 1e6 : null;
const durationOf = item => item.durationSeconds ?? item.measurements.nominalDurationSeconds ?? item.measurements.elapsedSeconds
  ?? (Number.isFinite(item.measurements.samples) && item.measurements.fps > 0 ? (item.measurements.samples - 1) / item.measurements.fps : null);
const dataRefOf = item => item.sourceDataRef ?? (typeof item.sourceRef === 'object' ? item.sourceRef?.file : null) ?? null;
const sourceTextOf = source => typeof source === 'string' ? source : JSON.stringify(source);

// These thresholds only sort SOURCE endpoint problems into a useful review order.
// They are deliberately not PMX/contact/collision/automatic admission thresholds.
export const SOURCE_SORT_THRESHOLDS = Object.freeze({
  positionGapCm: 0.5, rotationGapDeg: 5,
  linearVelocityGapCmPerSec: 5, angularVelocityGapDegPerSec: 20,
  purpose: '只安排源接缝先看哪里；不是接入、落脚、自然度或自动使用的合格线。',
});

export function sourceIdentity(sourceRef) {
  if (typeof sourceRef !== 'string' || !sourceRef.endsWith('.uasset') || sourceRef.includes('\\')) {
    throw Error(`Invalid native source reference: ${sourceRef}`);
  }
  const parsed = path.posix.parse(sourceRef);
  const phaseMatch = /_(start|end|loop\d*)$/i.exec(parsed.name);
  const nameFamily = phaseMatch ? parsed.name.slice(0, phaseMatch.index) : parsed.name;
  return { family: path.posix.join(parsed.dir, nameFamily), nameFamily, phase: phaseMatch ? phaseMatch[1].toLowerCase() : 'single', directory: parsed.dir };
}

function checkInputs(catalog, rules) {
  if (catalog?.schema !== 'aemeath-preparation/v1' || !Array.isArray(catalog.items)) throw Error('Unsupported preparation catalog');
  if (!Array.isArray(rules?.rules)) throw Error('Missing native usage rules');
  const ids = new Set(), ruleIds = new Set();
  for (const rule of rules.rules) {
    if (!rule.id || ruleIds.has(rule.id) || !rule.match?.sourceRegex) throw Error(`Invalid/duplicate usage rule: ${rule.id}`);
    ruleIds.add(rule.id);
  }
  for (const item of catalog.items) {
    if (!item.id || ids.has(item.id) || !item.kind || !item.sourceRef || !item.usage || !item.measurements) throw Error(`Invalid/duplicate preparation item: ${item.id}`);
    ids.add(item.id);
    if (item.automaticEligible !== false) throw Error(`Preparation has accidental automatic admission: ${item.id}`);
    if (item.kind === 'native-body') {
      const identity = sourceIdentity(item.sourceRef);
      if (item.family !== identity.family || item.phase !== identity.phase) throw Error(`Wrong source family/phase mapping: ${item.id}`);
      const matched = rules.rules.filter(rule => new RegExp(rule.match.sourceRegex, 'i').test(item.sourceRef)).map(rule => rule.id).sort();
      const declared = [...(item.usageRuleIds ?? [])].sort();
      if (matched.length !== 1 || JSON.stringify(matched) !== JSON.stringify(declared)) throw Error(`Wrong source usage rule mapping: ${item.id}`);
    }
  }
  const itemById = new Map(catalog.items.map(item => [item.id, item]));
  const familyMembers = new Set();
  for (const family of catalog.families ?? []) {
    for (const id of family.memberIds ?? []) {
      const item = itemById.get(id);
      if (!item || item.kind !== 'native-body' || item.family !== family.family || familyMembers.has(id)) throw Error(`Wrong family member mapping: ${id}`);
      familyMembers.add(id);
    }
  }
  for (const item of catalog.items.filter(x => x.kind === 'native-body')) {
    if (!familyMembers.has(item.id)) throw Error(`Missing source family member: ${item.id}`);
    for (const candidate of item.clothCandidates ?? []) {
      if (itemById.get(candidate.id)?.kind !== 'native-ribbon') throw Error(`Wrong clothing source mapping: ${item.id} -> ${candidate.id}`);
    }
  }
  const seamKeys = new Set();
  for (const seam of catalog.seams ?? []) {
    const from = itemById.get(seam.from), to = itemById.get(seam.to);
    if (!from || !to || from.kind !== 'native-body' || to.kind !== 'native-body' || from.family !== to.family) throw Error(`Wrong source seam mapping: ${seam.from} -> ${seam.to}`);
    const key = `${seam.from}\n${seam.to}`;
    if (seamKeys.has(key) || seam.automaticTransitionApproved === true) throw Error(`Duplicate seam or accidental transition admission: ${seam.from} -> ${seam.to}`);
    seamKeys.add(key);
  }
  for (const sequence of catalog.items.filter(x => x.kind === 'sequence')) {
    for (const segment of sequence.measurements.segments ?? []) {
      const activity = itemById.get(segment.id);
      if (!activity || activity.kind !== 'activity' || activity.runtimeId !== segment.runtimeId) throw Error(`Wrong sequence source mapping: ${sequence.id} -> ${segment.id}`);
    }
  }
}

const PARTNER_RULES = new Set(['handshake-partner', 'holding-hands-partner', 'hug-partner', 'pulled-or-grabbed', 'nose-contact', 'touch-or-pat', 'seated-partner-arm']);
const PROP_RULES = new Set(['cassette-context', 'vehicle-context', 'microphone-taking', 'keyboard-entry', 'dorm-guitar', 'dorm-paperplane', 'dorm-writing', 'dorm-texting', 'fanclub-performance']);
const SPECIAL_RULES = new Set(['ready-to-act', 'standing-alternate', 'long-character-idles', 'fool-expression-body', 'seated-fool', 'sit-up-unknown', 'collapse-seat', 'self-look', 'raised-hand-unknown', 'uncertain-bi', 'uncertain-awareness', 'uncertain-dramatic', 'uncertain-mofang', 'uncertain-viewfinder', 'lying-crawling-uncertain', 'water-context', 'aerial-or-unconscious']);
const STEP_RULES = new Set(['turn-90', 'turn-backhand-story', 'walk-common', 'walk-talk', 'walk-greet', 'walk-shy', 'walk-weak', 'running-general', 'salute-movement']);
const CORE_RULES = new Set(['standing-baseline', 'standing-talk', 'calm-dialogue', 'show-hand', 'turn-in-explanation', 'thinking-standing-one', 'thinking-standing-two', 'greeting-hand', 'breathing-full-pose']);

function dependencyProfile(items, ruleIds) {
  const rules = new Set(ruleIds), native = items.every(x => x.kind === 'native-body');
  const sourceText = items.map(x => x.name).join(' ');
  const supports = unique(items.flatMap(x => Object.keys(x.measurements.supports ?? {})));
  const props = unique(items.flatMap(x => Object.keys(x.measurements.props ?? {})));
  const seatedName = /(?:^|[_\s])sit|sit(?:talk|calm|thinking|fool|promise|back|_)/i.test(sourceText);
  const seated = supports.includes('seated') || native && (seatedName || ruleIds.some(id => id.startsWith('seated-')));
  const airborne = supports.includes('airborne') || rules.has('aerial-or-unconscious');
  const maxRootTravelCm = Math.max(0, ...items.map(x => x.measurements.rootTravelCm ?? 0));
  const maxRootRotationDeg = Math.max(0, ...items.map(x => x.measurements.rootEndRotationDeg ?? 0));
  const sourceRootMovement = maxRootTravelCm > 0.5 || maxRootRotationDeg > 5;
  const explicitRoute = ruleIds.some(id => STEP_RULES.has(id)) || items.some(x => ['locomotion', 'running', 'jumping'].includes(x.category));
  const authoredMoving = items.some(x => x.kind === 'activity' && (x.measurements.maxRootSpeed ?? 0) > 0.01);
  const partner = ruleIds.some(id => PARTNER_RULES.has(id));
  const propContext = props.length > 0 || ruleIds.some(id => PROP_RULES.has(id));
  const special = ruleIds.some(id => SPECIAL_RULES.has(id) || id.startsWith('ui-'));
  return {
    stance: native ? seated ? '名称提示坐姿，仍须实模确认' : '名称未确认坐站，先看真实姿态' : supports.length ? supports.join(' → ') : items.every(x => x.kind === 'gesture') ? '控制器固定空手站姿采样；其它入口未验' : '单项或配套层，不凭它指定身体入口',
    seatedCandidate: seated, airborneCandidate: airborne, partnerCandidate: partner, propContextCandidate: propContext,
    routeReviewRequired: explicitRoute || sourceRootMovement || authoredMoving, specialContextCandidate: special, props,
    sourceRootMovement: { maximumTravelCm: round(maxRootTravelCm), maximumEndRotationDeg: round(maxRootRotationDeg), measuredOnly: true },
    basis: native ? '用途规则与源名提示场景，源root测量提示位移；两者不证明接触或实际语义。' : '读取程序全程采样的支撑、道具及位移，不据类别名称批准现场。',
    unknown: '现场、坐站或对象不清时只安排对应人工审阅；不把无道具标签理解成已证实空手。',
  };
}

function laneFor(items, rules, dependency) {
  const native = items.every(x => x.kind === 'native-body');
  if (!items.some(x => ['native-body', 'gesture', 'activity', 'sequence'].includes(x.kind))) return { rank: 90, label: '配套层单独审阅，不计身体动作', reason: '眉眼、头眼、衣发、注视和道具动画按配套关系核对；不能用它们增加身体动作数量。' };
  if (items.some(x => x.kind === 'sequence')) return { rank: 70, label: '连续活动的跨段审阅', reason: '先有子动作证据再看完整接续，重点找物品消失、坐站和世界位置重置。' };
  if (dependency.specialContextCandidate) return { rank: 80, label: '特殊或含义未确认，先解读再试接', reason: '先确认真实含义、排除攻击和武器内容，再考虑日常使用；完整演出和UI姿态不自动充当闲时反应。' };
  if (dependency.partnerCandidate) return { rank: 60, label: '另一人物或承接对象依赖', reason: '必须先准备真实对象与配对接触；单人在空场摆姿态不能证明互动已支持。' };
  if (dependency.propContextCandidate && !(dependency.seatedCandidate && dependency.props.every(x => x === 'chair') && !native)) return { rank: 50, label: '持物、桌面或特殊现场', reason: '确认物体、握点、尺寸和拿放过程后才有可执行入口；静态道具模型不等于已配套。' };
  if (dependency.routeReviewRequired || dependency.airborneCandidate) return { rank: 40, label: '转向、位移、支撑和落地', reason: '这些素材能补自然转身和活动，但先要有路线、落脚与保留实际位置的退出办法。' };
  if (dependency.seatedCandidate || items.some(x => x.category === 'seated')) return { rank: 30, label: '坐姿交流与起坐', reason: '先固定座面和脚部环境，逐坐姿版本核对；坐姿End不能直接当通用起身。' };
  if (native && rules.some(x => CORE_RULES.has(x.id)) || items.some(x => x.kind === 'gesture' && ['original', 'conversation'].includes(x.category))) return { rank: 10, label: '常用交流与站姿基准', reason: '最常用于倾听、解释、招呼和思考，先得到可靠站姿基准，再比较原生和程序版本的用途与控制差别。' };
  return { rank: 20, label: '事件反应与日常身体表达', reason: '补充具体事件的表情身体反应，先核对用途与幅度，避免把心情小变化反复演成整套动作。' };
}

function assessSeams(items, seams) {
  const native = items.every(x => x.kind === 'native-body');
  if (!native) return { tier: 'controller-entry-exit-needs-model-review', rank: 2, explanation: '程序采样提供检查点；与原生、场景和其它层合成后的姿态及速度还须重测。', sourceSeams: [] };
  const phases = unique(items.map(x => x.phase));
  const named = phases.some(x => x !== 'single');
  const missingStart = named && !phases.includes('start'), missingEnd = named && !phases.includes('end');
  const expectedPairs = items.flatMap(item => {
    const loops = items.filter(x => x.phase.startsWith('loop'));
    const targets = item.phase === 'start' ? loops.length ? loops : items.filter(x => x.phase === 'end') : item.phase.startsWith('loop') ? items.filter(x => x.phase.startsWith('loop') || x.phase === 'end') : [];
    return targets.map(target => ({ from: item.id, to: target.id }));
  });
  const missingPairs = expectedPairs.filter(pair => !seams.some(seam => seam.from === pair.from && seam.to === pair.to));
  const measurable = seams.filter(x => x.measurable === true);
  const valuesKnown = x => ['positionGapCm', 'rotationGapDeg', 'linearVelocityGapCmPerSec', 'angularVelocityGapDegPerSec'].every(key => Number.isFinite(x[key]));
  const poseLarge = measurable.some(x => x.positionGapCm > SOURCE_SORT_THRESHOLDS.positionGapCm || x.rotationGapDeg > SOURCE_SORT_THRESHOLDS.rotationGapDeg);
  const speedLarge = measurable.some(x => x.linearVelocityGapCmPerSec > SOURCE_SORT_THRESHOLDS.linearVelocityGapCmPerSec || x.angularVelocityGapDegPerSec > SOURCE_SORT_THRESHOLDS.angularVelocityGapDegPerSec);
  const tier = missingEnd ? 'missing-named-exit' : missingStart ? 'missing-named-entry' : !named ? 'single-clip-entry-exit-unverified' : !seams.length || missingPairs.length || measurable.length !== seams.length || measurable.some(x => !valuesKnown(x)) ? 'unmeasurable-or-incomplete-source-seam' : poseLarge ? 'source-pose-gap-review' : speedLarge ? 'source-velocity-gap-review' : 'source-endpoints-close-only';
  const text = {
    'missing-named-exit': '没有同源End；先补可靠退出，不能借其它目录同名End，也不能凭低速认为能停。',
    'missing-named-entry': '没有同源Start；先确认/补进入来源，不能站着直接切到循环。',
    'single-clip-entry-exit-unverified': '单段式没有声明完整起收，首尾仅供检查；不能据缺阶段标记为假就判定完整。',
    'unmeasurable-or-incomplete-source-seam': '接缝数据缺失或不足；先核对源数据再安排衔接，未知速度不能按零处理。',
    'source-pose-gap-review': '源端点姿态存在较大差异，先看实际去向再设计中间过程。',
    'source-velocity-gap-review': '源端点姿态较接近，但运动速度差较大；重点看突然减速或反向。',
    'source-endpoints-close-only': '源端点姿态和速度在本次排序范围内；仍不证明循环任意时刻能进End，也不证明实模自然。',
  };
  return { tier, rank: ['source-endpoints-close-only', 'source-velocity-gap-review', 'source-pose-gap-review', 'single-clip-entry-exit-unverified', 'missing-named-entry', 'missing-named-exit', 'unmeasurable-or-incomplete-source-seam'].indexOf(tier), missingNamedStart: missingStart, missingNamedEnd: missingEnd,
    phases, expectedNamedPhasePairs: expectedPairs, missingSourceSeamPairs: missingPairs,
    explanation: text[tier], sourceSeams: seams.map(x => ({ from: x.from, to: x.to, measurable: x.measurable, positionGapCm: x.positionGapCm ?? null, rotationGapDeg: x.rotationGapDeg ?? null,
      linearVelocityGapCmPerSec: x.linearVelocityGapCmPerSec ?? null, angularVelocityGapDegPerSec: x.angularVelocityGapDegPerSec ?? null, automaticTransitionApproved: false })) };
}

function endpoints(items, assessment) {
  const native = items.every(x => x.kind === 'native-body');
  if (native) {
    const starts = items.filter(x => x.phase === 'start'), ends = items.filter(x => x.phase === 'end'), singles = items.filter(x => x.phase === 'single');
    return {
      entry: (starts.length ? starts : singles).map(item => ({ id: item.id, sourceRef: item.sourceRef, timeSeconds: 0, approved: false, basis: starts.length ? '同源Start首帧候选；须匹配真实当前姿态、速度、坐站和持物。' : '单段首帧只供预览检查；进入过程未证实。' })),
      exit: (ends.length ? ends : singles).map(item => ({ id: item.id, sourceRef: item.sourceRef, timeSeconds: item.durationSeconds ?? null, approved: false, basis: ends.length ? '同源End末帧候选；先查从哪里能接入以及最终支撑与持物。' : '单段末帧只供检查，不是可打断证明。' })),
      unknown: assessment.missingNamedEnd ? '出口候选为空；不得用低速区间代替收势，先补实际退出片段或当前姿态收稳过程。' : '入口出口都是审阅位置，不是可随时跳入的运行指令。',
    };
  }
  return {
    entry: items.map(item => ({ id: item.id, sourceRef: item.sourceRef, timeSeconds: 0, approved: false, basis: item.usage.entry })),
    exit: items.map(item => ({ id: item.id, sourceRef: item.sourceRef, timeSeconds: durationOf(item), approved: false, basis: item.usage.exit })),
    unknown: '现有控制器固定入口与退出不代表任意原生姿态可接入；先保留可信身体和现场。',
  };
}

function cancellationChecks(items, dependency) {
  const native = items.every(x => x.kind === 'native-body');
  const times = native ? ['start', 'loop', 'end'].map(phase => {
    const matches = items.filter(x => phase === 'loop' ? x.phase.startsWith('loop') : x.phase === phase);
    if (matches.length) return matches.map(item => ({ id: item.id, timeSeconds: round(item.durationSeconds * 0.5), basis: `名称${item.phase}中点，仅是抽样候选，真实阶段须观看确认。` }));
    return items.filter(x => x.phase === 'single').map(item => ({ id: item.id, timeSeconds: round(item.durationSeconds * ({ start: 0.2, loop: 0.5, end: 0.8 }[phase])), basis: '单段20%/50%/80%抽样，不证明对应准备/主动作/收回；须先看动作再重选。' }));
  }) : [0.2, 0.5, 0.8].map((fraction, index) => items.map(item => {
    const phase = ['prepare', 'stroke', 'recover'][index], observed = item.measurements.cpuPose?.observedPhases?.find(x => x.phase === phase);
    const duration = durationOf(item);
    return { id: item.id, timeSeconds: observed ? round((observed.firstSeconds + observed.lastSeconds) / 2) : Number.isFinite(duration) ? round(duration * fraction) : null,
      basis: observed ? '真实控制器本轮观测阶段中点；渲染层仍需复核。' : '按时长分段的候选点；没有真实阶段时先观看定位，不冒充已测三阶段。' };
  }));
  const existing = items.flatMap(item => (item.measurements.cancellationProbes ?? []).map(probe => ({ id: item.id, actualPhase: probe.actualPhaseAtCancel ?? probe.phaseAtStop ?? null,
    timeSeconds: probe.actualAgeAtCancel ?? probe.activityAgeAtStop ?? null, cancelAccepted: probe.cancelAccepted ?? null, staleEpochAcceptedAfterCancel: probe.staleEpochAcceptedAfterCancel ?? null,
    controllerDone: probe.done ?? (probe.remainingGestures === 0), evidenceScope: probe.limitation ?? '控制器单入口采样，不是完整实际人物打断。' })));
  return ['准备时取消', '主动作/保持时取消', '收回时取消'].map((label, index) => ({ label, candidatePoints: times[index],
    phaseCandidateMissing: times[index].length === 0,
    whoJudges: '本地取消旧任务并拒绝迟到命令；制作人员看实模，程序记录显示姿态、速度、脚和持物。',
    check: [index === 0 ? '确认尚未做出的主体动作不再开始；从当前动作收住，不跳首帧。' : index === 1 ? '确认运动方向和速度延续，不能瞬间反向或以复位掩盖打断。' : '确认回收中再次取消不重启、不瞬间归位，结束后没有偏移或旧动作复活。',
      ...(dependency.routeReviewRequired || dependency.airborneCandidate ? ['正在移动的脚要完成必要落脚；不能原地冻结、滑脚或丢掉真实位移。'] : []),
      ...(dependency.seatedCandidate ? ['保留座面承接；必要的落座完成，不能停在半空或无故站起。'] : []),
      ...(dependency.propContextCandidate || dependency.partnerCandidate ? ['拿放/接触按当前真实阶段处理；物体不消失、不缩放补错，不凭计时假定已交接。'] : []),
      '正侧面看袖口、头发和裙摆；旧轮次包不能复活动作，取消恢复使用独立时间继续，语音按原流程处理。'],
    existingControllerProbes: existing.filter(x => index === 0 ? x.actualPhase === 'prepare' : index === 2 ? x.actualPhase === 'recover' || x.actualPhase === 'gather' : !['prepare', 'recover', 'gather'].includes(x.actualPhase)),
    unknown: times[index].length ? '候选点不合实际阶段就重新标记；连续观看与速度接缝未验前保持待审。' : '先补这一阶段的进入/退出办法，再做打断；不把缺阶段改写成已通过。',
    accepted: false,
  }));
}

export function buildReviewQueue(catalog, rules, fingerprints = {}) {
  checkInputs(catalog, rules);
  const ruleById = new Map(rules.rules.map(rule => [rule.id, rule]));
  const nativeFamilies = (catalog.families ?? []).map(family => ({ id: `native:${hash(family.family).slice(0, 16)}`, sourceFamily: family.family, items: family.memberIds.map(id => catalog.items.find(x => x.id === id)) }));
  const individual = catalog.items.filter(x => ['gesture', 'activity', 'sequence'].includes(x.kind)).map(item => ({ id: item.id, items: [item] }));
  const auxiliary = new Map();
  for (const item of catalog.items.filter(x => !['native-body', 'gesture', 'activity', 'sequence'].includes(x.kind))) {
    const key = `${item.sourceCatalog ?? 'unknown'}:${item.kind}`;
    if (!auxiliary.has(key)) auxiliary.set(key, { id: `support:${key}`, items: [] });
    auxiliary.get(key).items.push(item);
  }
  const groups = [...nativeFamilies, ...individual, ...auxiliary.values()].map(group => {
    const { items } = group, ruleIds = unique(items.flatMap(x => x.usageRuleIds ?? [])), groupRules = ruleIds.map(id => ruleById.get(id));
    const dependency = dependencyProfile(items, ruleIds), priority = laneFor(items, groupRules, dependency);
    const memberIds = items.map(x => x.id), seams = (catalog.seams ?? []).filter(x => memberIds.includes(x.from) && memberIds.includes(x.to));
    const seamReview = assessSeams(items, seams), endpointCandidates = endpoints(items, seamReview);
    const missing = unique(items.flatMap(x => x.blockers ?? []));
    if (seamReview.missingNamedStart) missing.unshift('缺同源命名Start：先补可靠进入，或证明当前姿态就是允许入口。');
    if (seamReview.missingNamedEnd) missing.unshift('缺同源命名End：先做可执行退出与不同阶段取消，不可借用其它目录的End。');
    if (dependency.seatedCandidate) missing.push('座椅位置、高度、座面/椅背承接、脚部空间及实际起止坐姿待确认。');
    if (dependency.routeReviewRequired) missing.push('实际路线与落脚出口、root只应用一次、结束保留真实位移待确认。');
    if (dependency.propContextCandidate) missing.push('道具实体、固定尺寸握点、拿放/放回、承接与取消持续性待确认。');
    if (dependency.partnerCandidate) missing.push('另一人物/接触表面、配对位置和时序、释放过程待确认。');
    const comparisons = (rules.reuseComparisons ?? []).filter(row => row.nativeRules.some(id => ruleIds.includes(id)) || items.some(item => row.existingAuthored.includes(item.runtimeId)));
    const nativePeers = unique(comparisons.flatMap(row => catalog.items.filter(item => item.kind === 'native-body' && item.usageRuleIds.some(id => row.nativeRules.includes(id))).map(item => item.id)));
    const authoredPeers = unique(comparisons.flatMap(row => catalog.items.filter(item => ['gesture', 'activity', 'micro'].includes(item.kind) && row.existingAuthored.includes(item.runtimeId)).map(item => item.id)));
    return {
      id: group.id, name: group.sourceFamily ? path.posix.basename(group.sourceFamily) : items.length === 1 ? items[0].name : `${items[0].kind}配套层`,
      sourceFamily: group.sourceFamily ?? null, sourceNameFamily: group.sourceFamily ? path.posix.basename(group.sourceFamily) : null,
      reviewPurpose: unique(items.map(x => x.usage.purpose)), kind: items.every(x => x.kind === 'native-body') ? 'native-body-family' : items[0].kind,
      sourceCatalog: items[0].sourceCatalog ?? null, priority, dependencyProfile: dependency,
      memberIds, sources: items.map(item => ({ id: item.id, runtimeId: item.runtimeId ?? null, name: item.name, kind: item.kind, phase: item.phase ?? null,
        sourceRef: item.sourceRef, sourceDataRef: dataRefOf(item), sourceSha256: item.sourceSha256 ?? (typeof item.sourceRef === 'object' ? item.sourceRef?.sha256 : null) ?? null, durationSeconds: durationOf(item) })),
      usageRuleIds: ruleIds, usageRulePriority: Math.max(0, ...groupRules.map(x => x.priority ?? 0)),
      firstLookReason: priority.reason,
      watch: ['先完整看正面与侧面，确认真实含义与参与部位，排除攻击/武器内容；文件名仅是候选。',
        '从已登记当前姿态进入，保持身体幅度、近身肘部和利落挥手主体节奏；看头胸肩与脚，不只看手。',
        '看完整起势→主体/循环→收势，比较实际姿态与速度，不能靠整体慢放掩盖接缝。',
        ...(dependency.seatedCandidate ? ['检查座面高度、椅背、脚是否悬空，不能自动把坐姿End理解成起身。'] : []),
        ...(dependency.propContextCandidate ? ['确认真实道具及握点，物品保持固定尺寸；没有配套时登记缺口，不演空气拿放。'] : []),
        ...(dependency.partnerCandidate ? ['先确认动作究竟接触自己、物品还是另一人；两人版需要真实配对。'] : []),
        ...(dependency.routeReviewRequired ? ['看root实际路径和落脚，低速区间只能帮助找检查位置，不证明触地或能立刻停。'] : []),
        '身体与衣发同进度检查，表情与口型有明确所有权，最后在三阶段取消后再次触发检查漂移。'],
      prerequisitesToResolve: unique(missing), declaredPreconditions: unique(items.flatMap(x => strings(x.usage.preconditions))),
      sourceSeamReview: seamReview, endpointCandidates,
      lowMotionIsNotExitEvidence: true,
      clothCandidates: items.flatMap(item => (item.clothCandidates ?? []).map(row => ({ bodyId: item.id, ...row, approved: false }))),
      cancellationChecks: cancellationChecks(items, dependency),
      reuseComparison: { nativeFirstIds: nativePeers, authoredIds: authoredPeers, reasons: unique(comparisons.map(x => x.comparison)), admissionGranted: false },
      unknownHandling: '含义/入口/出口/现场未确认时保留待审并标明缺项；语音不等动作，未完成项不从全库覆盖统计里删除。',
      automaticEligible: false, reviewCompleted: false,
    };
  });
  groups.sort((a, b) => a.priority.rank - b.priority.rank || Number(b.kind === 'native-body-family') - Number(a.kind === 'native-body-family') || b.usageRulePriority - a.usageRulePriority || a.sourceSeamReview.rank - b.sourceSeamReview.rank || compare(a.id, b.id));
  groups.forEach((group, index) => { group.order = index + 1; });
  const nameFamilies = unique(nativeFamilies.map(group => path.posix.basename(group.sourceFamily))).sort();
  const result = {
    schema, experimental: true, preparationOnly: true, automaticEligible: false,
    fingerprints,
    summary: { recordsCovered: catalog.items.length, byKind: byKind(catalog.items), reviewGroups: groups.length,
      nativeBodyClips: catalog.items.filter(x => x.kind === 'native-body').length, nativeSourceDirectoryGroups: nativeFamilies.length, nativeNameFamilies: nameFamilies.length,
      countingExplanation: '名称家族仅去阶段后缀后按basename去重；源目录分组保留不同目录与骨架，两个口径不互相替代。衣发、注视、道具动画、表情与默认脸不计身体。',
      automaticEligible: 0,
      sourceSeamTiers: Object.fromEntries(unique(groups.filter(x => x.kind === 'native-body-family').map(x => x.sourceSeamReview.tier)).sort().map(tier => [tier, groups.filter(x => x.kind === 'native-body-family' && x.sourceSeamReview.tier === tier).length])),
    },
    sourceSortThresholds: SOURCE_SORT_THRESHOLDS,
    executionInstructions: [
      '按用途和现场分批，先常用原生，再看同用途程序版；原生含义未确认时不为了优先顺序强行使用。',
      '每组先核原ID、目录、骨架和缺口，再正侧连续观看；入口出口和取消点都只是待验证候选。',
      '同名跨目录仅做对照，不能交换Start/Loop/End或合并掉一份来源。',
      '准备、主体/保持、收回三个阶段分别取消；缺阶段先补路线，源低速不当作可停证明。',
      '所有条目仍待真实模型与组合验收；此队列不授权正式自动调用，也不修改模型、记忆或语音。',
    ],
    nameFamilyIndex: nameFamilies.map(name => ({ name, sourceFamilies: nativeFamilies.filter(x => path.posix.basename(x.sourceFamily) === name).map(x => ({ family: x.sourceFamily, groupId: x.id, ids: x.items.map(item => item.id) })) })),
    groups,
  };
  validateReviewQueue(result, catalog);
  return result;
}

export function validateReviewQueue(queue, catalog) {
  if (queue.schema !== schema || queue.automaticEligible !== false) throw Error('Invalid review queue or accidental admission');
  const expected = new Map(catalog.items.map(item => [item.id, item])), seen = new Set(), groupIds = new Set();
  for (const group of queue.groups) {
    if (groupIds.has(group.id) || group.automaticEligible !== false || group.reviewCompleted !== false) throw Error(`Invalid/duplicate review group: ${group.id}`);
    groupIds.add(group.id);
    if (group.cancellationChecks?.length !== 3 || group.cancellationChecks.some(x => x.accepted !== false)) throw Error(`Missing three-stage review: ${group.id}`);
    if (group.memberIds.length !== group.sources.length) throw Error(`Source list size mismatch: ${group.id}`);
    for (const id of group.memberIds) {
      const item = expected.get(id), source = group.sources.find(x => x.id === id);
      if (!item || seen.has(id)) throw Error(`Omitted, extra, or duplicate catalog record: ${id}`);
      if (!isDeepStrictEqual(source?.sourceRef, item.sourceRef) || source?.kind !== item.kind || source?.sourceDataRef !== dataRefOf(item)) throw Error(`Wrong review source mapping: ${id}`);
      if (group.kind === 'native-body-family' && (item.kind !== 'native-body' || item.family !== group.sourceFamily)) throw Error(`Non-body or wrong family in body group: ${id}`);
      if (group.kind !== 'native-body-family' && item.kind === 'native-body') throw Error(`Body hidden in support group: ${id}`);
      seen.add(id);
    }
  }
  for (const id of expected.keys()) if (!seen.has(id)) throw Error(`Review queue omitted catalog record: ${id}`);
  return true;
}

export function renderReviewQueue(queue) {
  const s = queue.summary, lines = ['# 动作逐组审阅顺序', '',
    `本队列覆盖 ${s.recordsCovered} 条准备记录：原生身体 ${s.nativeBodyClips} 段，按名称为 ${s.nativeNameFamilies} 家族，按真实源目录为 ${s.nativeSourceDirectoryGroups} 组。两个分组口径都保留；同名跨目录不能交换阶段。`, '',
    '这里只安排下一步看什么、为什么看、怎样取消复核。没有一条获得自动使用许可；全帧数值、低速区间和端点接近都不证明接触、自然度或任意阶段能停。', '',
    '| 类型 | 保留记录 |', '| --- | ---: |', ...Object.entries(s.byKind).map(([kind, n]) => `| ${kind} | ${n} |`), '',
    '## 怎样使用', '', ...queue.executionInstructions.map((x, i) => `${i + 1}. ${x}`), '',
    '源接缝只用来安排复核重点：位置差0.5厘米、角差5度、线速度差5厘米/秒、角速度差20度/秒是本轮排序参考，不是实模验收合格线。未知的速度保留未知。', '',
    '## 分组索引', '', '| 顺序 | 本轮先看什么 | 组名 | 片段/记录 | 接缝检查重点 |', '| ---: | --- | --- | ---: | --- |',
    ...queue.groups.map(g => `| ${g.order} | ${g.priority.label} | ${g.name.replaceAll('|', '\\|')} | ${g.memberIds.length} | ${g.sourceSeamReview.explanation} |`), '',
    '## 每组具体检查', ''];
  for (const group of queue.groups) {
    lines.push(`### ${group.order}. ${group.name}`, '', `组ID：${group.id}`, '', `用途：${group.reviewPurpose.join('；')}`, '', `为什么先看：${group.firstLookReason}`, '',
      `由谁判断：用途由素材制作/审阅人员在当前模型上核实；Qwen只提供交流目的，本地程序核对真实现场和有效轮次。依据：${group.dependencyProfile.basis}`, '',
      `身体与现场：${group.dependencyProfile.stance}；${group.dependencyProfile.props.length ? `程序记录的对象为 ${group.dependencyProfile.props.join('、')}` : '未记录明确物体不等于已证实空手'}。`, '',
      '必须保留的原来源：', '', ...group.sources.map(x => `- ${x.id}｜${x.name}｜${sourceTextOf(x.sourceRef)}${x.sourceDataRef ? `｜${x.sourceDataRef}` : ''}`), '',
      '需要先解决：', '', ...group.prerequisitesToResolve.map(x => `- ${x}`), '', '看什么：', '', ...group.watch.map(x => `- ${x}`), '',
      `阶段与源接缝：${group.sourceSeamReview.explanation}`, '',
      `入口候选：${group.endpointCandidates.entry.length ? group.endpointCandidates.entry.map(x => `${x.id} @ ${x.timeSeconds ?? '待定'}秒`).join('；') : '空，先补或确认进入来源'}。`, '',
      `出口候选：${group.endpointCandidates.exit.length ? group.endpointCandidates.exit.map(x => `${x.id} @ ${x.timeSeconds ?? '待定'}秒`).join('；') : '空，先补可执行退出'}。${group.endpointCandidates.unknown}`, '',
      '三阶段取消复核：', '');
    for (const check of group.cancellationChecks) {
      lines.push(`- ${check.label}：${check.candidatePoints.length ? check.candidatePoints.map(x => `${x.id} @ ${x.timeSeconds ?? '先观看定位'}秒`).join('；') : '缺阶段候选，先补进入/退出'}。${check.check.join(' ')} ${check.unknown}`);
    }
    if (group.reuseComparison.nativeFirstIds.length || group.reuseComparison.authoredIds.length) lines.push('', `同用途先看原生：${group.reuseComparison.nativeFirstIds.join('、') || '尚未定位，保留检索缺口'}。`, '',
      `再对比已有原创：${group.reuseComparison.authoredIds.join('、') || '尚未定位'}。${group.reuseComparison.reasons.join(' ')}`);
    lines.push('', `判断不出：${group.unknownHandling}`, '', '本组状态：未完成实模和组合审阅，自动使用关闭。', '');
  }
  return lines.join('\n');
}

export async function writeReviewQueue(catalogFile, rulesFile, outputDirectory) {
  const [catalogBytes, ruleBytes] = await Promise.all([readFile(catalogFile), readFile(rulesFile)]);
  const catalog = JSON.parse(catalogBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const rules = JSON.parse(ruleBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const queue = buildReviewQueue(catalog, rules, { catalogSha256: hash(catalogBytes), rulesSha256: hash(ruleBytes) });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'review-queue.json'), JSON.stringify(queue, null, 2) + '\n');
  await writeFile(path.join(outputDirectory, 'review-queue.md'), renderReviewQueue(queue));
  return queue;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    if (index < 0) return fallback;
    if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw Error(`Missing path after ${flag}`);
    return path.resolve(process.argv[index + 1]);
  };
  const directory = arg('--output-dir', path.join(root, 'outputs/action-preparation-20261023'));
  const queue = await writeReviewQueue(arg('--catalog', path.join(root, 'outputs/action-preparation-20261023/catalog.json')),
    arg('--rules', path.join(root, 'preparation/native-usage-rules.json')), directory);
  console.log(JSON.stringify(queue.summary));
}
