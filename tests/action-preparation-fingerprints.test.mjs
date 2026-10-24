import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fingerprintDependencies, verifyFingerprints } from '../scripts/action-preparation/source-fingerprints.mjs';

test('a changed transitive solver invalidates its original measurement evidence', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'prep-deps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'entry.mjs'), "import {solve} from './solver.mjs'; export {solve};");
  writeFileSync(path.join(root, 'solver.mjs'), "export {value} from './math.mjs'; export const solve = () => 1;");
  writeFileSync(path.join(root, 'math.mjs'), 'export const value = 1;');
  const snapshot = fingerprintDependencies(['entry.mjs'], root);
  assert.equal(snapshot.length, 3);
  assert.equal(verifyFingerprints(snapshot, root), true);
  writeFileSync(path.join(root, 'math.mjs'), 'export const value = 2;');
  assert.throws(() => verifyFingerprints(snapshot, root), /dependency changed/);
});

test('cyclic local imports terminate without duplicate provenance', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'prep-cycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'a.mjs'), "import './b.mjs';");
  writeFileSync(path.join(root, 'b.mjs'), "import './a.mjs';");
  assert.equal(fingerprintDependencies(['a.mjs'], root).length, 2);
});

test('dependency references cannot silently read outside the declared source root', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'prep-outside-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'entry.mjs'), "import '../outside.mjs';");
  assert.throws(() => fingerprintDependencies(['entry.mjs'], root), /leaves repository/);
});
