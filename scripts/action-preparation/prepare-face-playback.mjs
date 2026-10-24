import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Parser } from '../../preview/node_modules/mmd-parser/build/mmdparser.module.mjs';
import { createMorphAudit } from './prepare-expressions.mjs';
import { PRESETS, AEMEATH_BINDINGS, CHANNELS } from '../../preview/core/profile.js';
import { NativeExpression } from '../../preview/core/native-expression.js';
import { fingerprintDependencies } from './source-fingerprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prepareFacePlayback(output = path.join(root, 'outputs/action-execution-preparation-20261023/face-playback.json')) {
  const modelPath = 'assets/Aemeath/鸣潮_爱弥斯1.05.pmx', bytes = await fs.readFile(path.join(root, modelPath));
  const model = new Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
  const audit = createMorphAudit(model.morphs);
  const mouthIndices = [...new Set(model.morphs.flatMap(m => audit.resolve(m.name).leaves.filter(leaf => leaf.mouthRelated).map(leaf => leaf.index)))];
  const sourceRoot = path.join(root, 'outputs/native-complete-20261022');
  const manifestBytes = await fs.readFile(path.join(sourceRoot, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  const recipes = [];
  const mapping = names => names.map(source => { const match = audit.resolve(source); return { source,
    leaves: match.leaves.filter(leaf => leaf.type === 1).map(({ index, ratio, mouthRelated }) => ({ index, ratio, mouthRelated })),
    omittedNonVertex: match.leaves.filter(leaf => leaf.type !== 1).map(leaf => leaf.name), errors: match.errors, state: match.state }; });
  for (const row of manifest.resources.filter(row => ['expression', 'default-face'].includes(row.kind))) {
    const packed = await fs.readFile(path.join(sourceRoot, row.file)), data = JSON.parse(packed), expression = new NativeExpression(data);
    recipes.push({ id: row.id, name: row.name, kind: row.kind, source: { asset: row.sourceAsset, sha256: hash(packed) },
      sourceScope: /\/AbuFace\//.test(row.sourceAsset ?? '') ? 'other-character-abu' : row.kind === 'expression' ? 'aimisi-character' : 'generic-or-other-npc',
      nativeData: expression.data, mapping: mapping(expression.data.curves.map(curve => curve.name)), automaticEligible: false });
  }
  for (const preset of PRESETS) {
    const values = {}, links = [];
    for (const [source, value] of Object.entries(preset.morphs)) {
      const pair = AEMEATH_BINDINGS[CHANNELS.indexOf(source)]; if (!pair) throw Error(`No authored binding: ${source}`);
      values[pair[1]] = value; links.push(pair[1]);
    }
    recipes.push({ id: `authored-expression:${preset.id}`, name: preset.name, kind: 'authored-expression', values, mapping: mapping(links),
      note: '原配方只取实际顶点形变；头部倾斜和材质脸红未在此播放器冒充已实现。', automaticEligible: false });
  }
  for (const recipe of recipes) {
    const indices = [...new Set(recipe.mapping.flatMap(m => m.leaves.map(leaf => leaf.index)))];
    recipe.probeVertices = [...new Set(indices.flatMap(index => {
      const elements = model.morphs[index].elements;
      return Array.from({ length: Math.min(12, elements.length) }, (_, i) => elements[Math.floor(i * elements.length / Math.min(12, elements.length))].index);
    }))].slice(0, 128);
    recipe.previewAvailable = recipe.mapping.some(m => m.leaves.length) || (recipe.kind === 'authored-expression' && Object.keys(recipe.values).length === 0);
  }
  const result = { schema: 'prepared-face-playback/v1', model: { file: modelPath, sha256: hash(bytes), morphCount: model.morphs.length },
    manifestSha256: hash(manifestBytes), mouthIndices, recipes,
    dependencies: fingerprintDependencies(['scripts/action-preparation/prepare-face-playback.mjs', 'preview/core/prepared-face-controller.js'], root),
    summary: { recipes: recipes.length, nativeRecipes: recipes.filter(r => r.nativeData).length, authoredRecipes: PRESETS.length,
      mapped: recipes.filter(r => r.mapping.some(m => m.leaves.length)).length, previewAvailable: recipes.filter(r => r.previewAvailable).length,
      unavailable: recipes.filter(r => !r.previewAvailable).map(r => r.id),
      automaticEligible: 0 },
    boundary: '动态包络与取消仅在独立预览使用；持续基调由host提供，不推断或修改数学情绪。发音时全部实际嘴部叶形变归口型。原生完整与说话裁剪版不另算新表情。' };
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(result)); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify((await prepareFacePlayback()).summary));
