import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function inside(root, file) { const relative = path.relative(root, file); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
export async function verifyFacePlaybackSources(data, root, sourceRoot = path.join(root, 'outputs/native-complete-20261022')) {
  const manifestBytes = await readFile(path.join(sourceRoot, 'manifest.json'));
  if (sha(manifestBytes) !== data.manifestSha256) throw Error('Native manifest changed; rebuild face playback');
  const rows = new Map(JSON.parse(manifestBytes).resources.map(row => [row.id, row]));
  const target = path.resolve(root, data.model.file);
  if (!inside(root, target) || sha(await readFile(target)) !== data.model.sha256) throw Error('Target changed; rebuild face playback');
  for (const recipe of data.recipes.filter(row => row.nativeData)) {
    const source = rows.get(recipe.id), file = path.resolve(sourceRoot, source?.file ?? '');
    if (!source || !inside(sourceRoot, file) || sha(await readFile(file)) !== recipe.source.sha256) throw Error('Native face resource changed: ' + recipe.id);
  }
  return true;
}
