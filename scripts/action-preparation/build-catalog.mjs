import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyFingerprints } from './source-fingerprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const count = (items, key) => Object.fromEntries([...new Set(items.map(x => x[key]))].sort().map(k => [k, items.filter(x => x[key] === k).length]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));

export function validateCatalog(catalog, manifest) {
  if (catalog.schema !== 'aemeath-preparation/v1' || !Array.isArray(catalog.items)) throw Error('Invalid preparation catalog');
  const ids = new Set();
  for (const item of catalog.items) {
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw Error(`Duplicate or missing item ID: ${item.id}`);
    ids.add(item.id);
    if (!item.name || !item.kind || !item.sourceRef || !item.usage || !item.measurements) throw Error(`Incomplete source/use record: ${item.id}`);
    if (!Array.isArray(item.blockers) || !Array.isArray(item.evidence)) throw Error(`Missing evidence/blockers: ${item.id}`);
    if (item.automaticEligible !== false) throw Error(`Offline preparation cannot grant automatic use: ${item.id}`);
    for (const field of ['purpose', 'trigger', 'preconditions', 'prohibited', 'entry', 'exit', 'cancel']) {
      if (item.usage[field] === undefined || item.usage[field] === null) throw Error(`Missing ${field}: ${item.id}`);
    }
  }
  for (const row of manifest.clips) if (!ids.has(row.id)) throw Error(`Source clip omitted: ${row.id}`);
  for (const row of manifest.resources.filter(x => ['expression', 'default-face'].includes(x.kind))) {
    if (!ids.has(row.id)) throw Error(`Expression resource omitted: ${row.id}`);
  }
  return true;
}

export async function buildCatalog(directory, manifestFile) {
  const names = ['native', 'authored', 'expressions'];
  const inputs = [];
  for (const name of names) {
    const file = path.join(directory, `${name}.json`), bytes = await readFile(file);
    const parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (parsed.schema !== 'aemeath-preparation/v1' || !Array.isArray(parsed.items)) throw Error(`Unsupported input: ${name}`);
    inputs.push({ name, parsed, sha256: digest(bytes) });
  }
  const manifestBytes = await readFile(manifestFile), manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const native = inputs.find(x => x.name === 'native').parsed;
  if (native.manifestSha256 !== digest(manifestBytes)) throw Error('Native measurements belong to another manifest; rebuild them');
  if (native.measurementScriptSha256 !== digest(await readFile(path.join(root, 'scripts/action-preparation/prepare_native.py')))) throw Error('Native measurement program changed; regenerate preparation');
  if (native.usageRulesSha256 !== digest(await readFile(path.join(root, 'preparation/native-usage-rules.json')))) throw Error('Native usage rules changed; regenerate preparation');
  const expressions = inputs.find(x => x.name === 'expressions').parsed;
  if (expressions.source?.sha256 !== digest(manifestBytes)) throw Error('Expression measurements belong to another manifest; rebuild them');
  const authored = inputs.find(x => x.name === 'authored').parsed;
  if (!authored.sources?.length || !expressions.source?.dependencies?.length) throw Error('Missing measurement dependency fingerprints; regenerate authored and expressions');
  verifyFingerprints(authored.sources, root);
  verifyFingerprints(expressions.source.dependencies, root);
  const nativeRows = new Map(manifest.clips.map(row => [row.id, row]));
  for (const item of native.items) {
    if (!item.sourceSha256) continue;
    const relative = nativeRows.get(item.id)?.file;
    const sourceFile = path.resolve(path.dirname(manifestFile), relative ?? '');
    const boundary = path.relative(path.dirname(manifestFile), sourceFile);
    if (!relative || boundary.startsWith('..') || path.isAbsolute(boundary) || digest(await readFile(sourceFile)) !== item.sourceSha256) throw Error(`Native clip bytes changed: ${item.id}`);
  }
  const resourceRows = new Map(manifest.resources.map(row => [row.id, row]));
  for (const item of expressions.items) {
    const hash = item.sourceRef?.sha256;
    if (!hash) continue;
    const relative = resourceRows.get(item.id)?.file;
    const sourceFile = path.resolve(path.dirname(manifestFile), relative ?? '');
    const boundary = path.relative(path.dirname(manifestFile), sourceFile);
    if (!relative || boundary.startsWith('..') || path.isAbsolute(boundary) || digest(await readFile(sourceFile)) !== hash) throw Error(`Expression resource bytes changed: ${item.id}`);
  }
  if (expressions.source?.model?.file && expressions.source.model.sha256) {
    const file = path.resolve(root, expressions.source.model.file);
    if (!file.startsWith(root + path.sep) || digest(await readFile(file)) !== expressions.source.model.sha256) throw Error('Expression target model changed; rebuild measurements');
  }
  const items = inputs.flatMap(x => x.parsed.items.map(item => ({ ...item, sourceCatalog: x.name })));
  const result = {
    schema: 'aemeath-preparation/v1', experimental: true, preparationOnly: true,
    evidenceLevel: 'offline-source-and-controller-analysis; no unified-runtime-admission',
    items, families: native.families, seams: native.seams,
    inputFingerprints: inputs.map(({ name, sha256 }) => ({ name, sha256 })),
    summary: {
      records: items.length, byKind: count(items, 'kind'), bySource: count(items, 'sourceCatalog'), byStatus: count(items, 'preparationStatus'),
      native: native.summary, authored: inputs.find(x => x.name === 'authored').parsed.summary,
      expressions: inputs.find(x => x.name === 'expressions').parsed.summary,
      automaticEligible: 0,
      sourceMouthResourcesNotCountedAsActions: manifest.resources.filter(x => x.kind === 'mouth').length,
    },
    limitations: [
      '动作使用条件、源轨迹测量和控制器测试是前期准备，不等于统一系统已接通。',
      '每个拟自动使用版本还需当前模型的进入、退出、取消、衣发及场景组合验证。',
      '用途来自名称推断的条目已标明；低速时段不证明落脚或可以立刻打断。',
      '所有条目保持自动使用关闭；手动预览和前期信息覆盖单独统计。',
      '全游戏台词口型、其它角色默认脸和衣发片段不充当新增身体动作。',
    ],
  };
  validateCatalog(result, manifest);
  const report = [
    '# 动作前期准备目录', '',
    '本报告来自真实本机资源与控制器分析；只反映前期准备覆盖，没有开放自动调度。', '',
    `共 ${items.length} 条使用记录。源身体 ${native.summary.byKind['native-body'] ?? 0} 段，按目录与阶段分为 ${native.summary.bodyFamilies} 个家族；测量 ${native.summary.phaseSeamsMeasured} 条阶段接缝。`, '',
    '| 资源或动作类型 | 记录数 |', '| --- | ---: |',
    ...Object.entries(result.summary.byKind).map(([kind, total]) => `| ${kind} | ${total} |`), '',
    '## 已准备的资料', '',
    '- 每条记录的来源、用途依据、触发、前置条件、禁止条件、进入、退出、取消和缺口。',
    '- 原生全帧数值、参与部位、运动幅度、源脚低速时段、起止姿态与阶段速度接缝。',
    '- 原创控制器与活动采样、表情曲线和发音嘴形冲突说明。',
    '- 衣发按配套资源统计，注视和道具单列；默认脸异角色内容标明。', '',
    '## 仍需实模逐组确认', '',
    '- 具体语义、入口与出口是否自然，身体幅度、近身肘部和利落挥手是否保持。',
    '- 不同阶段取消、落脚、持物、道具承接、衣发穿插与说话时脸部组合。',
    '- 正式调度状态连接、唯一合成、真实语音和历史保护；本批不改正式链路。', '',
    '没有源数据的条目也保留为明确缺口，未从统计里静默删除。所有自动使用许可仍为关闭。', '',
  ].join('\n');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'catalog.json'), JSON.stringify(result, null, 2) + '\n');
  await writeFile(path.join(directory, 'preparation-report.md'), report);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = (flag, fallback) => { const i = process.argv.indexOf(flag); return i < 0 ? fallback : path.resolve(process.argv[i + 1]); };
  const result = await buildCatalog(value('--output-dir', path.join(root, 'outputs/action-preparation-20261023')),
    value('--manifest', path.join(root, 'outputs/native-complete-20261022/manifest.json')));
  console.log(JSON.stringify({ records: result.summary.records, byKind: result.summary.byKind, automaticEligible: 0 }));
}
