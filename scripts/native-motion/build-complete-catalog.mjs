import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw new Error('Expected --option value pairs');
  options.set(process.argv[i], process.argv[i + 1]);
}
const indexFile = options.get('--index') ?? path.join(root, 'outputs/native-motion-20261022/resource-index.txt');
const existingFile = options.get('--existing') ?? path.join(root, 'scripts/native-motion/common-candidates.json');
const outputFile = options.get('--out') ?? path.join(root, 'scripts/native-motion/complete-candidates.json');
const assets = [...new Set(fs.readFileSync(indexFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s.endsWith('.uasset')))];
const assetSet = new Set(assets);
const existing = JSON.parse(fs.readFileSync(existingFile, 'utf8')).clips;
const existingBySource = new Map(existing.map(row => [row.sourceAsset, row]));
const base = source => path.posix.basename(source, '.uasset');
const shortId = (prefix, source) => `${prefix}-${base(source).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 38)}-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 10)}`;
const under = prefix => assets.filter(source => source.startsWith(prefix));
const bodyPrefix = 'Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/';
const lookPrefix = 'Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/AimOffset/';
const ribPrefix = 'Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Rib/';
const ribbonPrefix = 'Client/Content/Aki/Character/Role/FemaleM/Aimisi/R2T1AimisiMd10011/RibbonAnim/';
const motorRibbonPrefix = 'Client/Content/Aki/Character/Role/FemaleM/Aimisi/R2T1AimisiMd10011/Gameplay/Motor/RibbonAnim/';
const expressionPrefix = 'Client/Content/Aki/Character/NPC/RoleNPC/FemaleM/Aimisi/Expression/';
const modelPrefix = 'Client/Content/Aki/Character/Role/FemaleM/Aimisi/R2T1AimisiMd10011/Model/';
const mouthPrefix = 'Client/Content/Aki/Sequence/SequenceAnim/VoiceMouth/';
const facePrefix = 'Client/Content/Aki/Sequence/SequenceAnim/DefaultFace/';
const propPrefix = 'Client/Content/Aki/Character/Weapon/Prop/Role/AimisiProp/';
const propGroups = [
  ['EAimisiBaizhifeijiMd10011', '白纸飞机'],
  ['EAimisiBlueDiscMd10011', '蓝色唱片'],
  ['EAimisiCidaiMd10011', '磁带'],
  ['EAimisiHuatongMd10011', '话筒'],
  ['EAimisiZhiFeiJiMd10011', '纸飞机'],
];
const sealPrefix = 'Client/Content/Aki/Character/Weapon/Prop/Shipin/EAimisiHaibaoMd10011/';
const excluded = [];
const clips = [];
const objects = [];
const seenSources = new Set();

// Scope is deliberate: Weapon is a storage directory for ordinary props too.
// Reject leaf action names and known combat-only scopes, never that parent word.
function rejectReason(source) {
  const name = base(source);
  if (/\/(?:Montage|Rogue)\//i.test(source) || /^(?:AM_|BS_|ABP_)/i.test(name) || /Montage/i.test(name)) return 'montage-or-controller';
  if (/attack|skill|burst|execute|behit|death|dodge|rogue|(?:^|_)hit(?:_|[0-9]|$)|hitglass|(?:^|_)weapon(?:_|$)/i.test(name)) return 'combat-or-weapon-display';
  // Capture, manipulation and summon are combat/skill companions in this role.
  if (/^(?:Rib_)?(?:Captured|Manipulate|Summon)(?:_|$)/i.test(name)) return 'combat-skill-companion';
  return null;
}

function addClip(source, resourceKind, category, name, notes = '') {
  const reason = rejectReason(source);
  if (reason) { excluded.push({sourceAsset: source, reason}); return; }
  if (seenSources.has(source)) return;
  seenSources.add(source);
  const prior = existingBySource.get(source);
  const leaf = base(source);
  const loop = /(?:^|_)Loop[0-9]*(?:_|$)/i.test(leaf) || /^(?:Rib_)?(?:Idle|Stand[0-9]*)$/i.test(leaf) || resourceKind === 'look';
  const row = {
    id: prior?.id ?? shortId(resourceKind === 'ribbon' ? 'rib' : resourceKind === 'prop-animation' ? 'prop-anim' : resourceKind, source),
    name: prior?.name ?? name ?? leaf,
    category: prior?.category ?? category,
    sourceAsset: source,
    loop: prior?.loop ?? loop,
    resourceKind,
    notes: prior ? '已有常用动作库条目；沿用既有标识，并在完整批次中保留原始包与解码证据。' : '候选元数据；需解码确认类型、骨架、additive 与实际姿态。资源名分类不等于已确认演出含义，loop 仅为循环提示。',
  };
  if (notes) row.notes += ` ${notes}`;
  if (prior) row.existingId = prior.id;
  clips.push(row);
}

function addObject(source, kind, name) {
  if (seenSources.has(source)) throw new Error(`Duplicate source: ${source}`);
  seenSources.add(source);
  objects.push({id: shortId(kind, source), name: name ?? base(source), kind, sourceAsset: source});
}

function bodyCategory(source) {
  const name = base(source);
  if (/^Sit|^Weak_Sit|^DZ_Sit/i.test(name)) return '坐姿';
  if (/^Squat/i.test(name)) return '蹲姿';
  if (/^Turn|zhuanshen/i.test(name)) return '转身';
  if (/^Walk|^Run|_Walk_|^Weakness_walk/i.test(name)) return '行走';
  if (/^(?:Angry|Calm|Complain|Embarrassment|Shy|Tsundere)/i.test(name)) return '情绪';
  if (/^(?:Thinking)/i.test(name)) return '思考';
  if (/^(?:Talk|Whisper|Showhand|Zhixiang|Promise)/i.test(name)) return '交流';
  if (/^(?:Stand01|Breath01|Relax01)$/i.test(name)) return '待机';
  return '场景交互';
}

for (const source of under(bodyPrefix)) addClip(source, 'body', bodyCategory(source));
// Character-specific ordinary idles and dormitory/ecology performances are
// useful beside dialogue clips. Unknown story E/combined skills are excluded.
for (const source of under('Client/Content/Aki/Character/Role/FemaleM/Aimisi/CommonAnim/')) {
  if (/^(?:Stand(?:2|Change|1_Action0[1-3])|Team_Stand[1-3]|Ui_(?:Chip|Nature|Resonant)_(?:Start|Loop|End)|XA_Loop_Stand)$/.test(base(source)))
    addClip(source,'body',/\/UiAnim\//.test(source)?'展示待机':'待机',base(source));
}
for (const source of under('Client/Content/Aki/Character/NPC/RoleNPC/FemaleM/Aimisi/BaseAnim/')) addClip(source,'body','场景交互',base(source));
for (const source of assets.filter(s=>s.includes('/SequenceAnim/ShengtaiAnim/')&&s.includes('/RoleNPC/FemaleM/Aimisi/BaseAnim/')))
  addClip(source,'body','宿舍与生态',base(source),'原生场景动作；家具、乐器、手机或纸飞机等场景锚点需另外匹配。');
// Preserve the two shared walking clips already accepted in the previous batch.
for (const prior of existing) if (!seenSources.has(prior.sourceAsset)) addClip(prior.sourceAsset, 'body', prior.category, prior.name);
for (const source of under(lookPrefix)) {
  if (base(source) === 'AO_LookAt') addObject(source, 'look-config', 'LookAt 混合配置');
  else addClip(source, 'look', '注视', base(source), '方向样本可能为叠加姿态，不能直接当完整身体绝对姿态。');
}
for (const source of [...under(ribPrefix), ...under(ribbonPrefix), ...under(motorRibbonPrefix)]) {
  addClip(source, 'ribbon', '衣带', base(source), '只驱动衣带或伴随骨骼；需配套身体动作和原骨架，不能当独立全身动作。');
}
for (const source of under(expressionPrefix)) addObject(source, 'expression');
for (const source of under(facePrefix)) addObject(source, 'default-face');
for (const source of under(mouthPrefix)) addObject(source, 'mouth');
for (const source of under(modelPrefix)) if (/^MI_.*(?:Face|Eye|Hair|Bangs)/i.test(base(source))) addObject(source, 'material');
for (const [group, label] of propGroups) {
  const prefix = `${propPrefix}${group}/`;
  const model = `${prefix}Model/${group}.uasset`;
  if (!assetSet.has(model)) throw new Error(`Required prop mesh is absent: ${model}`);
  addObject(model, 'prop-model', label);
  for (const source of under(prefix)) {
    if (/\/(?:BaseAnim|CommonAnim)\//.test(source)) addClip(source, 'prop-animation', '道具', `${label} · ${base(source)}`, '原生道具伴随动画，需按原生锚点与身体动作同步；并非当前 PMX 身体动作。');
    if (/\/Model\/MI_/.test(source)) addObject(source, 'material', `${label} · ${base(source)}`);
  }
}
addObject(`${sealPrefix}Model/EAimisiHaibaoMd10011.uasset`, 'prop-model', '海豹配饰');
for (const source of under(sealPrefix)) {
  if (/\/CommonAnim\//.test(source)) addClip(source, 'prop-animation', '道具', `海豹 · ${base(source)}`, '海豹自身骨架动画，不能直接重定向为人物身体姿态。');
  if (/\/Model\/MI_/.test(source)) addObject(source, 'material', `海豹 · ${base(source)}`);
}

clips.sort((a, b) => a.sourceAsset.localeCompare(b.sourceAsset, 'en'));
objects.sort((a, b) => a.sourceAsset.localeCompare(b.sourceAsset, 'en'));
const ids = new Set();
for (const row of [...clips, ...objects]) {
  if (!assetSet.has(row.sourceAsset)) throw new Error(`Catalog references missing asset: ${row.sourceAsset}`);
  if (!/^[a-z0-9-]+$/.test(row.id) || ids.has(row.id)) throw new Error(`Invalid or repeated id: ${row.id}`);
  ids.add(row.id);
}
const counts = (rows, field) => Object.fromEntries([...new Set(rows.map(row => row[field]))].map(value => [value, rows.filter(row => row[field] === value).length]));
const catalog = {
  schema: 1,
  description: '爱弥斯剩余非战斗资源候选目录；精确路径来自本机索引。它是候选白名单，并不代表全部已解码、已适配或已完成浏览器验收。',
  notes: [
    'VoiceMouth 为全游戏按台词 ID 命名的静态口型资源，不宣称为爱弥斯专属，也不等同任意语音实时口型模型。',
    'DefaultFace 包含不同角色/体型的共用与 NPC 表情，需逐项确认骨架和当前模型兼容性。',
    '主角色衣带保留攀爬、跳跃、游泳等非战斗伴随动画；配套角色全身素材可能来自公共移动库，当前目录不扩大采集所有公共库。',
    '未收录变形剑、战斗武器、浮游炮与战斗特效模型；普通纸飞机、话筒等即使存放在 Weapon 路径仍允许。',
  ],
  selection: {clips: clips.length, objects: objects.length, existingClips: clips.filter(row => row.existingId).length, clipKinds: counts(clips, 'resourceKind'), objectKinds: counts(objects, 'kind'), excluded: excluded.length, exclusionReasons: counts(excluded, 'reason')},
  clips,
  objects,
};
fs.mkdirSync(path.dirname(outputFile), {recursive: true});
fs.writeFileSync(outputFile, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(JSON.stringify(catalog.selection, null, 2));
