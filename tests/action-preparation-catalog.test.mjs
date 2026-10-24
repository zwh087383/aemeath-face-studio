import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog } from '../scripts/action-preparation/build-catalog.mjs';

const record = (id, kind = 'native-body') => ({ id, kind, name: id, sourceRef: 'fixture', measurements: {},
  usage: { purpose: 'fixture', trigger: 'manual', preconditions: [], prohibited: [], entry: 'review', exit: 'review', cancel: 'review' },
  evidence: [], blockers: ['not accepted'], automaticEligible: false });
const manifest = { clips: [{ id: 'body-a' }, { id: 'archived-ribbon' }], resources: [{ id: 'face-a', kind: 'expression' }] };
const fixture = () => ({ schema: 'aemeath-preparation/v1', items: [record('body-a'), record('archived-ribbon', 'native-ribbon'), record('face-a', 'expression')] });

test('preserves archived resources in preparation coverage', () => assert.equal(validateCatalog(fixture(), manifest), true));
test('rejects a missing source even if record count remains unchanged', () => {
  const catalog = fixture(); catalog.items[1].id = 'different';
  assert.throws(() => validateCatalog(catalog, manifest), /Source clip omitted/);
});
test('rejects accidental automatic admission during offline preparation', () => {
  const catalog = fixture(); catalog.items[0].automaticEligible = true;
  assert.throws(() => validateCatalog(catalog, manifest), /cannot grant/);
});
test('does not hide expression omissions inside body counts', () => {
  const catalog = fixture(); catalog.items.pop();
  assert.throws(() => validateCatalog(catalog, manifest), /Expression resource omitted/);
});
test('duplicate IDs cannot silently overwrite provenance', () => {
  const catalog = fixture(); catalog.items.push(record('body-a'));
  assert.throws(() => validateCatalog(catalog, manifest), /Duplicate/);
});
