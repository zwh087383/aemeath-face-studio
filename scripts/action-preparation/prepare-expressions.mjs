import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {NativeExpression, NativeExpressionBinding, evaluateNativeCurve} from '../../preview/core/native-expression.js';
import {fingerprintDependencies} from './source-fingerprints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SOURCE = path.join(ROOT, 'outputs/native-complete-20261022');
const DEFAULT_OUTPUT = path.join(ROOT, 'outputs/action-preparation-20261023');
const ACTIVE_EPSILON = 1e-6; // Reporting only. Original signed weights are never rounded or clamped.
const STATIC_EPSILON = 1e-10;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unique = values => [...new Set(values)];
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const relative = file => path.relative(ROOT, file).replaceAll('\\', '/');

// This audits existing files. It does not install a new renderer or write weights to a model.
export function expandMorphLeaves(morphs, index, ratio = 1, ancestry = []) {
  const morph = morphs[index];
  if (!Number.isInteger(index) || !morph) return {leaves:[], errors:[`missing-morph:${index}`]};
  if (!Number.isFinite(ratio)) return {leaves:[], errors:[`nonfinite-ratio:${index}`]};
  if (ancestry.includes(index)) return {leaves:[], errors:[`group-cycle:${[...ancestry, index].join('>')}`]};
  if (morph.type !== 0) return {leaves:[{index, name:morph.name, ratio, type:morph.type, panel:morph.panel,
    englishName:morph.englishName ?? '', path:[...ancestry, index]}], errors:[]};
  const result = {leaves:[], errors:[]};
  for (const element of morph.elements ?? []) {
    if (!Number.isFinite(element.ratio)) {result.errors.push(`nonfinite-group-ratio:${index}>${element.index}`);continue;}
    const child = expandMorphLeaves(morphs, element.index, ratio * element.ratio, [...ancestry, index]);
    result.leaves.push(...child.leaves);result.errors.push(...child.errors);
  }
  return result;
}

function affectedVertices(morph) {
  if (morph?.type !== 1) return new Set();
  return new Set((morph.elements ?? []).filter(element => Array.isArray(element.position)
    && element.position.some(value => value !== 0)).map(element => element.index));
}

export function createMorphAudit(morphs) {
  const dictionary = Object.fromEntries(morphs.map((morph, index) => [morph.name, index]));
  const binding = new NativeExpressionBinding(dictionary);
  const speechNames = ['S_01', 'I', 'U', 'E', 'O', 'A', 'Aa', 'M_A', 'M_O'];
  const speechIndices = speechNames.map(name => binding.resolve(name)?.index).filter(Number.isInteger);
  const speechVertices = new Set(speechIndices.flatMap(index => [...affectedVertices(morphs[index])]));
  const leafAudit = leaf => {
    const vertices = affectedVertices(morphs[leaf.index]);
    const mouthOverlap = [...vertices].filter(index => speechVertices.has(index)).length;
    return {...leaf, affectedVertexCount:vertices.size, speechVertexOverlap:mouthOverlap,
      mouthRelated:leaf.panel === 3 || mouthOverlap > 0,
      note:'Shared vertices prove a geometry overlap, not perceived speech quality or a safe numerical limit.'};
  };
  const resolve = name => {
    if (name === 'SeqMouthAlpha') return {sourceChannel:name, state:'control-not-applied', leaves:[], errors:[]};
    const match = binding.resolve(name);
    if (!match) return {sourceChannel:name, state:'unmapped', leaves:[], errors:[]};
    const expanded = expandMorphLeaves(morphs, match.index);
    const leaves = expanded.leaves.map(leafAudit);
    return {sourceChannel:name, state:expanded.errors.length ? 'invalid-group' : 'mapped', ...match,
      type:morphs[match.index].type, leaves, errors:expanded.errors,
      touchesMouth:leaves.some(leaf => leaf.mouthRelated),
      touchesNonVertex:leaves.some(leaf => leaf.type !== 1),
      groupExpanded:morphs[match.index].type === 0};
  };
  const groups = morphs.map((morph, index) => ({morph, index})).filter(({morph}) => morph.type === 0)
    .map(({morph, index}) => {
      const expanded = expandMorphLeaves(morphs, index), leaves = expanded.leaves.map(leafAudit);
      return {index, name:morph.name, leaves, errors:expanded.errors,
        touchesMouth:leaves.some(leaf => leaf.mouthRelated),
        hasSignedRatio:leaves.some(leaf => leaf.ratio < 0), automaticEligible:false};
    });
  return {resolve, groups, dictionary, modelMorphCount:morphs.length,
    speechReferenceMorphs:speechIndices.map(index => ({index, name:morphs[index].name})),
    speechReferenceVertexCount:speechVertices.size};
}

function isStatic(curve) {
  if (curve.keys.length < 2) return true;
  const first = curve.keys[0].value;
  if (!curve.keys.every(key => Math.abs(key.value - first) <= STATIC_EPSILON)) return false;
  return curve.keys.slice(0, -1).every((key, i) => ['Linear', 'Constant'].includes(key.interpolation)
    || (key.leaveTangent === 0 && curve.keys[i + 1].arriveTangent === 0));
}

function curveMeasurements(curve, duration) {
  const values = curve.keys.length ? curve.keys.map(key => key.value) : [curve.defaultValue];
  const samples = Array.from({length:65}, (_, i) => evaluateNativeCurve(curve, duration * i / 64));
  if (samples.some(value => !Number.isFinite(value))) throw Error(`Non-finite evaluated native curve: ${curve.name}`);
  const min = Math.min(...values), max = Math.max(...values);
  return {name:curve.name, keyCount:curve.keys.length, min, max, first:values[0], last:values.at(-1),
    sampleMin:Math.min(...samples), sampleMax:Math.max(...samples), static:isStatic(curve),
    hasNegative:values.some(value => value < 0), active:Math.max(Math.abs(min), Math.abs(max)) > ACTIVE_EPSILON,
    interpolation:unique(curve.keys.map(key => key.interpolation)),
    signedValuesPreserved:true, firstValue:values[0]};
}

function asymmetry(curves) {
  const byName = new Map(curves.map(curve => [curve.name, curve]));
  const result = curves.filter(curve => /_R(?:_Add)?$/.test(curve.name)).map(right => {
    const leftName = right.name.replace(/_R(?=(_Add)?$)/, '_L'), left = byName.get(leftName);
    if (!left) return {right:right.name, left:leftName, state:'left-absent-not-zero', rightFirst:right.first};
    return {right:right.name, left:leftName, state:'paired', rightFirst:right.first, leftFirst:left.first,
      firstDifference:right.first - left.first,
      unequalFirst:Math.abs(right.first - left.first) > STATIC_EPSILON};
  });
  for (const left of curves.filter(curve => /_L(?:_Add)?$/.test(curve.name))) {
    const rightName = left.name.replace(/_L(?=(_Add)?$)/, '_R');
    if (!byName.has(rightName)) result.push({right:rightName, left:left.name,
      state:'right-absent-not-zero', leftFirst:left.first});
  }
  return result;
}

function purposeFromName(name) {
  const candidates = [
    [/sleep/i, '睡意或闭目休息', '已有生活状态确认需要休息，并且当前不在等待用户回答'],
    [/wink|halfcloseeyes/i, '单侧眨眼式俏皮回应', '有明确轻松交流意图，且最近未重复同类回应'],
    [/close.?eyes|biyan/i, '闭眼或闭眼微笑', '已确认有短暂闭眼的交流目的；不可取代倾听注视'],
    [/jingya|surpris|alert|stare/i, '惊讶、警觉或集中注视', '对话模型或真实事件提供具体原因，再由本地判断强度'],
    [/angry|anger|weixie|nuyan/i, '生气、严肃或不满', '已有数学情绪或明确交流意图支持，不靠台词关键词直接触发'],
    [/sad|sorry|fear|afraid|scary|worry/i, '低落、担忧或歉意', '已有数学情绪或明确交流意图支持，需结合实际画面确认区别'],
    [/wunai|wuyu|speechless|contempt/i, '无奈或克制的反应', '存在值得回应的具体事件，且没有更强的倾听或发音任务'],
    [/think|serious/i, '认真或思考', '确有需要理解或消化的内容，不把网络等待当思考理由'],
    [/smile|happy|kawaii|grin/i, '微笑、愉快或轻松回应', '数学情绪允许且当前交流适合，不因每句话出现而重复'],
    [/lookaside/i, '侧向观察', '有真实注视目标，不能用它随意打断当前用户注视'],
    [/default/i, '默认面部或基础变化', '仅在曲线与角色关系确认后作为基础候选'],
  ];
  const match = candidates.find(([pattern]) => pattern.test(name));
  return {label:match?.[1] ?? '用途尚未确认的面部组合',
    trigger:match?.[2] ?? '需人工连续观看与事件关联确认后才能设定触发条件',
    basis:'name-inference-only', semanticVerified:false,
    note:'这里只根据名称给整理建议；真实曲线证明控制内容，不能单独证明人物在表达什么。'};
}

function sourceScope(entry) {
  if (entry.kind === 'expression' && /\/Aimisi\/Expression\//.test(entry.sourceAsset ?? '')) return 'aimisi-character';
  if (/\/AbuFace\//.test(entry.sourceAsset ?? '')) return 'other-character-abu';
  if (/\/NPCFace\//.test(entry.sourceAsset ?? '')) return 'generic-or-other-npc';
  return 'generic-default-face';
}

export function prepareExpression(entry, data, morphAudit, sourceRef = {}) {
  const base = {id:entry.id, kind:entry.kind, name:entry.name,
    sourceRef:{sourceAsset:entry.sourceAsset ?? null, file:entry.file ?? null, ...sourceRef},
    automaticEligible:false, preparationStatus:'offline-measured-awaiting-model-review'};
  try {
    const expression = new NativeExpression(data);
    const curves = expression.data.curves.map(curve => curveMeasurements(curve, expression.duration));
    const channels = curves.map(curve => ({...curve, mapping:morphAudit.resolve(curve.name)}));
    const active = channels.filter(channel => channel.active);
    const mouth = active.filter(channel => channel.mapping.touchesMouth);
    const unmapped = active.filter(channel => channel.mapping.state === 'unmapped');
    const invalid = channels.filter(channel => channel.mapping.errors.length);
    const controls = channels.filter(channel => channel.mapping.state === 'control-not-applied');
    const upper = active.filter(channel => channel.mapping.state === 'mapped'
      && !channel.mapping.touchesMouth && !channel.mapping.touchesNonVertex
      && channel.mapping.leaves.length && channel.mapping.leaves.every(leaf => [1, 2].includes(leaf.panel))
      && !/^Pupil_/.test(channel.name));
    const corners = mouth.filter(channel => /^M_(Smile|Ennui)_[RL]$/.test(channel.name));
    const gaze = active.filter(channel => /^Pupil_/.test(channel.name));
    const purpose = purposeFromName(entry.name), scope = sourceScope(entry);
    const blockers = ['real-model-continuous-review-required', 'shared-morph-owner-integration-required',
      'entry-exit-cancel-envelope-required'];
    if (!curves.length) blockers.push('no-facial-curves');
    if (unmapped.length) blockers.push('unmapped-source-controls');
    if (invalid.length) blockers.push('invalid-pmx-group-reference');
    if (controls.length) blockers.push('control-channel-needs-explicit-owner');
    if (mouth.length) blockers.push('original-recipe-overlaps-speech-mouth');
    if (scope !== 'aimisi-character') blockers.push('not-aemeath-specific-review-required');
    if (expression.data.warnings.length) blockers.push('source-parser-warning');
    const allStatic = curves.length > 0 && curves.every(curve => curve.static);
    const fingerprintData = expression.data.curves.map(curve => ({name:curve.name,
      shape:allStatic ? evaluateNativeCurve(curve, 0) : curve})).sort((a, b) => a.name.localeCompare(b.name));
    return {...base, sourceScope:scope, semanticSuggestion:purpose,
      sourceRecipeFingerprint:hash(JSON.stringify(fingerprintData)),
      measurements:{durationSeconds:expression.duration, curveCount:curves.length,
        keyCount:curves.reduce((sum, curve) => sum + curve.keyCount, 0), allCurvesStatic:allStatic,
        dynamicCurveCount:curves.filter(curve => !curve.static).length,
        sampleResolution:65, finite:true, negativeChannels:curves.filter(curve => curve.hasNegative).map(curve => curve.name),
        negativeValuePolicy:'Preserve signed source values. The observed range is not an approved runtime range.',
        significantThreshold:ACTIVE_EPSILON, asymmetry:asymmetry(curves),
        mappedCurveCount:channels.filter(channel => channel.mapping.state === 'mapped').length,
        unmappedCurveCount:channels.filter(channel => channel.mapping.state === 'unmapped').length,
        activeUnmappedChannels:unmapped.map(channel => channel.name),
        controlChannels:controls.map(channel => channel.name),
        activeMouthChannels:mouth.map(channel => channel.name),
        mappedGroupChannels:channels.filter(channel => channel.mapping.groupExpanded).map(channel => channel.name),
        curves:channels, sourceWarnings:expression.data.warnings},
      usage:{purpose:`候选用途：${purpose.label}。${purpose.note}`, trigger:purpose.trigger,
        preconditions:['读取已有数学情绪与对话目的，不由表情模块改写情绪',
          '当前模型已确认可见形变；已有眉眼、注视、口型控制在同一处协商',
          ...(scope !== 'aimisi-character' ? ['此资源来自通用或其它角色，先核对模型适配与表达强度'] : [])],
        prohibited:['不按文件名直接把模型情绪设为该标签', '说话时不整套覆盖发音嘴形',
          '缺省单侧通道不等于强行清空另一侧', '不得将合法负值统一压到0至1',
          '不将静态配方的文件时长当作自然起势、保持或收势时长'],
        entry:allStatic ? '该素材只有组合姿态；需从当前眉眼权重与变化速度接近目标，起势过程尚待制作与实模检查'
          : '保留源曲线时序，但仍需检查当前姿态到首帧的衔接；不能直接从零权重跳入',
        exit:'只撤销本次临时表达的贡献，回到仍有效的数学情绪与注视；不能将整张脸清零',
        cancel:'先作废旧轮次未开始的表情；已显示部分从当前值与速度收回，口型继续服从有效音频，动作失败不挡声音'},
      speechVariants:[
        {id:`${entry.id}:silent-original`, purpose:'无语音时审阅原始组合',
          sourceChannels:channels.map(channel => channel.name), automaticEligible:false,
          blockers:['需实模确认强度和语义', ...unmapped.map(channel => `未映射：${channel.name}`)]},
        {id:`${entry.id}:speech-upper-candidate`, purpose:'说话时优先审阅的眉眼部分',
          sourceChannels:upper.map(channel => channel.name), automaticEligible:false,
          omittedChannels:active.filter(channel => !upper.includes(channel)).map(channel => channel.name),
          note:upper.length ? '仅证明所选PMX叶通道不属于口面板且不与发音顶点重叠；眉眼、眨眼仍需协商并实模检查'
            : '没有可独立保留的眉眼通道，不能把空配方称为已新增一套说话表情'}],
      conditionalMouthCorners:corners.map(channel => ({name:channel.name, min:channel.min, max:channel.max,
        note:'与发音共用嘴部顶点，只能在统一合成中按发音与闭口需要限制；本轮未验证可用强度'})),
      gazeChannels:gaze.map(channel => ({name:channel.name, min:channel.min, max:channel.max,
        note:'由视线统一决定，不能原样叠加到另一个注视目标'})),
      blockers:unique(blockers), evidence:[
        {level:'decoded-source', fact:`实际读取${curves.length}条曲线与${curves.reduce((sum, curve) => sum + curve.keyCount, 0)}个点；静态判断检查相邻插值与切线`},
        {level:'current-binding-and-pmx', fact:'使用现有NativeExpressionBinding解析别名，并递归展开实际PMX组合形变；检查发音参考顶点重叠'},
        {level:'not-performed', fact:'未在真实角色上连续观看本资源、说话叠加或任意阶段打断；自动接纳为false'},
      ],
    };
  } catch (error) {
    return {...base, preparationStatus:'blocked-invalid-data', measurements:{finite:false, error:String(error.message)},
      usage:{purpose:'读取失败，不能确认表情内容', trigger:'禁止自动触发', preconditions:['修复或重新导出后复测'],
        prohibited:['不能使用文件名猜测曲线并播放'], entry:'不开始', exit:'保持已有可信表情', cancel:'撤销该资源请求，不影响语音'},
      blockers:['source-decode-or-analysis-failed'], evidence:[{level:'failed-analysis', fact:String(error.message)}]};
  }
}

export async function buildExpressionPreparation({manifestPath = path.join(DEFAULT_SOURCE, 'manifest.json'),
  resourceRoot = path.dirname(manifestPath), pmxPath = path.join(ROOT, 'assets/Aemeath/鸣潮_爱弥斯1.05.pmx'),
  modelMorphsPath = null} = {}) {
  const manifestBytes = await fs.readFile(manifestPath), manifest = JSON.parse(manifestBytes);
  let morphs, modelEvidence;
  if (modelMorphsPath) {
    const bytes = await fs.readFile(modelMorphsPath), fixture = JSON.parse(bytes);
    morphs = Array.isArray(fixture) ? fixture : fixture.morphs;
    modelEvidence = {kind:'provided-morph-fixture', file:relative(modelMorphsPath), sha256:hash(bytes)};
  } else {
    const bytes = await fs.readFile(pmxPath);
    const {Parser} = await import('../../preview/node_modules/mmd-parser/build/mmdparser.module.mjs');
    morphs = new Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true).morphs;
    modelEvidence = {kind:'actual-pmx-parse', file:relative(pmxPath), sha256:hash(bytes)};
  }
  if (!Array.isArray(morphs) || !morphs.length) throw Error('A nonempty PMX morph array is required');
  const morphAudit = createMorphAudit(morphs);
  const entries = (manifest.resources ?? []).filter(entry => ['expression', 'default-face'].includes(entry.kind));
  const items = [];
  for (const entry of entries) {
    try {
      const fullPath = path.resolve(resourceRoot, entry.file);
      const boundary = path.relative(path.resolve(resourceRoot), fullPath);
      if (boundary.startsWith('..') || path.isAbsolute(boundary)) throw Error('Resource path leaves resource root');
      const bytes = await fs.readFile(fullPath);
      items.push(prepareExpression(entry, JSON.parse(bytes), morphAudit, {sha256:hash(bytes)}));
    } catch (error) {
      const item = prepareExpression(entry, null, morphAudit);
      item.measurements.error = String(error.message);item.evidence[0].fact = String(error.message);items.push(item);
    }
  }
  const ofKind = kind => items.filter(item => item.kind === kind);
  const valid = items.filter(item => item.preparationStatus !== 'blocked-invalid-data');
  const byFingerprint = new Map();
  for (const item of valid) {
    const bucket = byFingerprint.get(item.sourceRecipeFingerprint) ?? [];
    bucket.push(item.id);byFingerprint.set(item.sourceRecipeFingerprint, bucket);
  }
  for (const item of valid) item.sameCurveRecipeAs = byFingerprint.get(item.sourceRecipeFingerprint).filter(id => id !== item.id);
  return {schema:'aemeath-preparation/v1', kind:'expressions',
    evidenceBoundary:'Source/PMX/binding measurements only. No live-model speech, emotion, naturalness, or interruption acceptance.',
    source:{manifest:relative(manifestPath), sha256:hash(manifestBytes), model:modelEvidence,
      binding:'preview/core/native-expression.js',
      dependencies:fingerprintDependencies(['scripts/action-preparation/prepare-expressions.mjs', 'preview/core/native-expression.js'], ROOT),
      generatedAt:new Date().toISOString()},
    items,
    summary:{total:items.length, characterExpressions:ofKind('expression').length,
      defaultFaceResources:ofKind('default-face').length,
      characterStaticRecipes:ofKind('expression').filter(item => item.measurements.allCurvesStatic).length,
      defaultStaticRecipes:ofKind('default-face').filter(item => item.measurements.allCurvesStatic).length,
      characterCurveCount:ofKind('expression').reduce((sum, item) => sum + (item.measurements.curveCount ?? 0), 0),
      characterKeyCount:ofKind('expression').reduce((sum, item) => sum + (item.measurements.keyCount ?? 0), 0),
      dynamicResources:valid.filter(item => !item.measurements.allCurvesStatic).length,
      invalidResources:items.length - valid.length,
      resourcesWithMouthOverlap:valid.filter(item => item.measurements.activeMouthChannels.length).length,
      resourcesWithNegativeValues:valid.filter(item => item.measurements.negativeChannels.length).length,
      resourcesWithActiveUnmappedControls:valid.filter(item => item.measurements.activeUnmappedChannels.length).length,
      resourcesWithUpperFaceCandidate:valid.filter(item => item.speechVariants[1].sourceChannels.length).length,
      uniqueSourceCurveRecipes:byFingerprint.size,
      exactDuplicateResources:valid.length - byFingerprint.size,
      automaticEligible:0,
      mouthInventory:{count:(manifest.resources ?? []).filter(entry => entry.kind === 'mouth').length,
        scope:'whole-game inventory only; not 3039 character expressions or a live phoneme solver',
        analyzedCurvesThisRun:false},
    },
    modelAudit:{morphCount:morphAudit.modelMorphCount, groupCount:morphAudit.groups.length,
      speechReferenceMorphs:morphAudit.speechReferenceMorphs,
      speechReferenceVertexCount:morphAudit.speechReferenceVertexCount,
      groups:morphAudit.groups,
      note:'Expand every group before deciding ownership. The group panel or name alone does not reveal its mouth dependencies.'},
  };
}

export function expressionNotes(result) {
  const s = result.summary;
  const rows = result.items.map(item => {
    const m = item.measurements;
    return `| ${item.name} | ${item.kind === 'expression' ? '爱弥斯角色' : item.sourceScope === 'other-character-abu' ? '其它角色Abu' : '通用或其它NPC'} | ${m.curveCount ?? '失败'} / ${m.allCurvesStatic ? '静态' : '含变化或未确认'} | ${m.activeMouthChannels?.join('、') || '未发现已映射嘴部活动'} | ${item.speechVariants?.[1].sourceChannels.join('、') || '无/未确认'} | ${m.activeUnmappedChannels?.length ?? '未知'} |`;
  });
  return `# 表情接入前准备记录\n\n这次实际读取${s.characterExpressions}份角色表情和${s.defaultFaceResources}份默认面部资源，检查现有映射及原始PMX组合形变。没有改原始资源、模型或运行控制器，也没有调用云模型。\n\n${s.characterExpressions}份角色表情中，${s.characterStaticRecipes}份是静态组合，共${s.characterCurveCount}条曲线、${s.characterKeyCount}个点。文件写着约1秒，并不等于它已经有自然起势与退出。\n\n默认面部资源中有${s.defaultStaticRecipes}份静态组合，其余实际含时序变化；含Abu及其它NPC资源，不能把名字相同视作爱弥斯专属。\n\n准备结果保存在同目录expressions.json；每份都有用途推测、触发来源、进入与退出要求、取消要求、具体阻碍和证据。用途语义仍须实模观看，所有automaticEligible均为false。\n\n## 说话时怎样处理\n\n本次发现${s.resourcesWithMouthOverlap}份原始组合活动了发音嘴部；${s.resourcesWithUpperFaceCandidate}份有可单独审阅的眉眼候选。候选只是排除了实际PMX嘴部面板与发音顶点重叠，仍然要和眨眼、视线协商，不能当成已验收可直接上线。嘴角同样和发音共享顶点，只列作有条件保留；无法拆出的组合先略过，不压住声音。\n\n左右不对称和负值按原始资源保留。例：Jingya的Pupil_Scale为-0.09090781；Wink两侧嘴角约0.6000006和0.6181814。观测范围不是已批准运行范围；不统一压成0至1，也不把缺省单侧当成零。\n\nPMX共有${result.modelAudit.groupCount}个组合形变，已递归展开并保存叶通道、符号系数和嘴部重叠。组合眉眼也可能带嘴形；例如にこりB同时带眉、眼与にやり。当前资源是否真的引用某个组合，要看逐曲线映射，不能看中文或日文名字猜。\n\nSeqMouthAlpha在现有绑定中是已识别但不应用的控制通道，不能假定它已经控制了口型所有权。当前绑定会直接写形变，并重置自己上次写过的通道；未来接入统一表情合成前仍有相互覆盖风险。\n\n## 逐份查阅\n\n| 资源 | 来源 | 曲线数 / 时间性质 | 原始组合中的嘴部活动 | 说话眉眼候选 | 活动但未映射通道数 |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n## 尚需完成\n\n1. 用实际模型正面、侧面连续观看，确认每份表情的可见效果和合适强度。\n2. 制作从当前表情进入、退出与打断的过程；回到数学情绪底色，不能清空整张脸。\n3. 将口型、表情、眨眼、注视放到同一个最终合成入口；口型拥有发音开合。\n4. 对通用及其它角色素材逐份适配，不因通道映射成功就放进自动库。\n5. 测说话中触发、取消、迟到旧指令、重复触发；声音不能等待表情。\n\n全游戏口型资源${s.mouthInventory.count}份此次仅盘点数量，没有逐条适配；它们不是爱弥斯的${s.mouthInventory.count}套动作，也不是实时语音求嘴形的模型。\n`;
}

async function main() {
  const args = process.argv.slice(2), options = {};
  const flags = {'--manifest':'manifestPath', '--resource-root':'resourceRoot', '--pmx':'pmxPath', '--model-morphs':'modelMorphsPath'};
  let out = path.join(DEFAULT_OUTPUT, 'expressions.json'), notes = path.join(DEFAULT_OUTPUT, 'expression-notes.md');
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value) throw Error(`Missing value after ${flag}`);
    if (flags[flag]) options[flags[flag]] = path.resolve(value);
    else if (flag === '--out') out = path.resolve(value);
    else if (flag === '--notes') notes = path.resolve(value);
    else throw Error(`Unknown option ${flag}`);
  }
  const result = await buildExpressionPreparation(options);
  await fs.mkdir(path.dirname(out), {recursive:true});
  await fs.mkdir(path.dirname(notes), {recursive:true});
  await fs.writeFile(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await fs.writeFile(notes, expressionNotes(result), 'utf8');
  console.log(JSON.stringify({out, notes, summary:result.summary}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {console.error(error.message);process.exitCode = 1;});
}
