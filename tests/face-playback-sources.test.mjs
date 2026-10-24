import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { verifyFacePlaybackSources } from '../scripts/action-preparation/face-playback-sources.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, file = 'face.json') {
  const root = await mkdtemp(path.join(tmpdir(), 'face-sources-')), source = path.join(root, 'source'); await mkdir(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.stringify({ resources: [{ id: 'face', file }] });
  await writeFile(path.join(source, 'manifest.json'), manifest); await writeFile(path.join(source, 'face.json'), 'original'); await writeFile(path.join(root, 'model.pmx'), 'model');
  return { root, source, data: { model: { file: 'model.pmx', sha256: sha('model') }, manifestSha256: sha(manifest), recipes: [{ id: 'face', nativeData: {}, source: { sha256: sha('original') } }] } };
}
test('changed resource content invalidates playback even when manifest, filename and PMX are unchanged', async t => {
  const { root, source, data } = await fixture(t); assert.equal(await verifyFacePlaybackSources(data, root, source), true);
  await writeFile(path.join(source, 'face.json'), 'changed'); await assert.rejects(verifyFacePlaybackSources(data, root, source), /resource changed/);
});
test('changing the actual target invalidates face evidence', async t => {
  const { root, source, data } = await fixture(t); await writeFile(path.join(root, 'model.pmx'), 'another model');
  await assert.rejects(verifyFacePlaybackSources(data, root, source), /Target changed/);
});
test('even a matching manifest cannot make the face server read a resource outside its source root', async t => {
  const { root, source, data } = await fixture(t, '../private.json'); await writeFile(path.join(root, 'private.json'), 'original');
  await assert.rejects(verifyFacePlaybackSources(data, root, source), /resource changed/);
});
