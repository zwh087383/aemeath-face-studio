import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CHARACTER_ACTIONS, CHARACTER_CATALOG } from '../../realtime/character-center/catalog.mjs';

const flag = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const url = flag('--url', 'http://127.0.0.1:18820/library-expansion/');
const output = path.resolve(flag('--output', 'outputs/library-expansion-20261027/browser-supported-variants.json'));
const heldProps = flag('--props', 'book,mug').split(',');
if (!heldProps.length || heldProps.some(id => !['book', 'mug'].includes(id))) throw Error('--props accepts book,mug');
const actions = ['action:nod', 'action:shake', 'action:tilt', 'action:glance', 'action:glance_left', 'action:glance_right', 'gesture:listen'];
for (const id of actions) if (!CHARACTER_ACTIONS[id]?.variants?.['support-preserving']) throw Error('Missing variant: ' + id);
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE
  ?? path.join(process.env.APPDATA, 'npm/node_modules/@playwright/cli/node_modules/playwright'));
const result = { at: new Date().toISOString(), cloudCalls: 0, sourceCatalogHash: CHARACTER_CATALOG.hash,
  kind: 'actual PMX browser integration with accelerated clock; explicit local commands; not cloud model choice or human continuous-view acceptance',
  actions, heldProps, fixtures: [], cases: [], errors: [], pass: false };
await fs.mkdir(path.dirname(output), { recursive: true });
const save = () => fs.writeFile(output, JSON.stringify(result, null, 2));
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', error => result.errors.push(String(error)));

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.motionLibrary?.snapshot().ready || window.motionLibrary?.snapshot().fault, null, { timeout: 120000 });
  const initial = await page.evaluate(() => { const s = motionLibrary.snapshot(); return { ready: s.ready, fault: s.fault, catalogHash: s.catalogHash }; });
  result.browserCatalogHash = initial.catalogHash;
  if (!initial.ready || initial.fault) throw Error('Browser not ready: ' + initial.fault);
  if (initial.catalogHash !== result.sourceCatalogHash) throw Error('Browser/server source catalogue mismatch');

  // The page already owns the real meshes. This observer only measures them;
  // it does not modify poses, supports, props, clocks or command admission.
  await page.evaluate(async () => {
    const THREE = await import('three');
    const { propGripPair, ACTIVITY_PROP_LAYOUT, readHandAnchor } = await import('/preview/core/activity-prop-layout.js');
    const vec = value => new THREE.Vector3(...value);
    const distance = (a, b) => Array.isArray(a) && Array.isArray(b) ? vec(a).distanceTo(vec(b)) : Infinity;
    const angle = (a, b) => Array.isArray(a) && Array.isArray(b)
      ? new THREE.Quaternion(...a).angleTo(new THREE.Quaternion(...b)) : Infinity;
    function measure(propId, s) {
      const actor = s.actorState, prop = s.props.props[propId], chair = motionLibrary.scene.props.objects.chair;
      const seat = chair.getObjectByName('seat'); seat.updateWorldMatrix(true, false); seat.geometry.computeBoundingBox();
      const local = vec(actor.bones.pelvis).applyMatrix4(seat.matrixWorld.clone().invert());
      const box = seat.geometry.boundingBox, footprint = chair.visible && local.x >= box.min.x - .05 && local.x <= box.max.x + .05
        && local.z >= box.min.z - .05 && local.z <= box.max.z + .05;
      const chairWorld = chair.getWorldPosition(new THREE.Vector3()).toArray(), chairQuaternion = chair.getWorldQuaternion(new THREE.Quaternion()).toArray();
      const sides = prop.attachment === 'both' ? ['left', 'right'] : [prop.attachment];
      const pair = propGripPair(propId, prop.openness), palms = {}, errors = [];
      for (const side of sides) {
        const hand = readHandAnchor(actor, side);
        if (!hand?.measured) { errors.push(Infinity); continue; }
        palms[side] = hand.position;
        const grip = prop.attachment === 'both' ? pair?.[side] : ACTIVITY_PROP_LAYOUT[propId].grip;
        if (!grip) { errors.push(Infinity); continue; }
        const target = vec(grip).multiply(vec(prop.scale)).applyQuaternion(new THREE.Quaternion(...prop.quaternion)).add(vec(prop.position));
        errors.push(target.distanceTo(vec(hand.position)));
      }
      return { support: actor.support, seatSupported: actor.seatSupported, footprint,
        pelvis: actor.bones.pelvis, pelvisAboveSeat: local.y - box.max.y, root: actor.root.position,
        ankles: [actor.bones.leftAnkle, actor.bones.rightAnkle], head: actor.rotations.head,
        chairWorld, chairQuaternion, palms, gripError: Math.max(...errors),
        prop: { visible: prop.visible, attachment: prop.attachment, position: prop.position, quaternion: prop.quaternion, measured: prop.measured },
        finite: s.finite };
    }
    window.supportedVariantObserver = { measure, distance, angle };
  });

  for (const propId of heldProps) {
    const fixture = await page.evaluate(async propId => {
      const api = motionLibrary; api.setManual(true);
      const id = `activity:take_${propId}_seated`, admitted = await api.inspect(id), started = performance.now();
      let last, receipt;
      for (let i = 0; i < 3600; i++) {
        last = api.step(1 / 30, i % 6 === 0);
        receipt = last.body.events.find(e => e.action === id && ['action_completed', 'action_failed', 'action_rejected', 'action_skipped'].includes(e.type));
        if (receipt) break;
        if (i % 15 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      last = api.step(0, true);
      const measured = supportedVariantObserver.measure(propId, last);
      return { propId, action: id, admitted, receipt: receipt && { type: receipt.type, reason: receipt.reason },
        measured, wallMs: performance.now() - started,
        sequence: last.body.events.filter(e => ['action_completed', 'action_rejected', 'action_failed', 'action_skipped'].includes(e.type))
          .map(e => ({ action: e.action, type: e.type, reason: e.reason })),
        pass: receipt?.type === 'action_completed' && measured.finite && measured.support === 'seated'
          && measured.seatSupported && measured.footprint && measured.prop.visible && measured.prop.measured
          && ['left', 'right', 'both'].includes(measured.prop.attachment) && measured.gripError <= .05 };
    }, propId);
    result.fixtures.push(fixture); await save();
    if (!fixture.pass) throw Error('Physical fixture failed: ' + propId + ' ' + JSON.stringify(fixture.receipt));

    for (const action of actions) {
      const row = await page.evaluate(async ({ propId, action }) => {
        const api = motionLibrary, { measure, distance, angle } = supportedVariantObserver;
        const before = measure(propId, api.step(0, false)), started = performance.now();
        const admitted = api.submit([{ action, anchor: 'immediate', performance: { variant_set: ['support-preserving'] } }]);
        const id = api.scene.bodyDirector.rows.at(-1)?.id;
        let receipt, frames = 0, actualSupportedFrames = 0, invalidFrame = null, last, after;
        const maximum = { root: 0, pelvis: 0, ankle: 0, chair: 0, chairAngle: 0, prop: 0, propAngle: 0, palm: 0, grip: 0, seatHeight: 0, headAngle: 0 };
        for (let i = 0; i < 1200; i++) {
          last = api.step(1 / 30, i % 6 === 0); frames++;
          const m = measure(propId, last); after = m;
          maximum.root = Math.max(maximum.root, distance(m.root, before.root));
          maximum.pelvis = Math.max(maximum.pelvis, distance(m.pelvis, before.pelvis));
          maximum.ankle = Math.max(maximum.ankle, ...m.ankles.map((p, k) => distance(p, before.ankles[k])));
          maximum.chair = Math.max(maximum.chair, distance(m.chairWorld, before.chairWorld));
          maximum.chairAngle = Math.max(maximum.chairAngle, angle(m.chairQuaternion, before.chairQuaternion));
          maximum.prop = Math.max(maximum.prop, distance(m.prop.position, before.prop.position));
          maximum.propAngle = Math.max(maximum.propAngle, angle(m.prop.quaternion, before.prop.quaternion));
          maximum.palm = Math.max(maximum.palm, ...Object.entries(before.palms).map(([side, p]) => distance(m.palms[side], p)));
          maximum.grip = Math.max(maximum.grip, m.gripError);
          maximum.seatHeight = Math.max(maximum.seatHeight, Math.abs(m.pelvisAboveSeat - before.pelvisAboveSeat));
          maximum.headAngle = Math.max(maximum.headAngle, angle(m.head, before.head));
          if (last.executor === 'supported' && last.body.active?.id === id && last.body.active.selectedVariant === 'support-preserving') actualSupportedFrames++;
          if (!invalidFrame && (!m.finite || m.support !== 'seated' || !m.seatSupported || !m.footprint || !m.prop.visible
            || !m.prop.measured || m.prop.attachment !== before.prop.attachment)) invalidFrame = { frame: i, measured: m };
          receipt = last.body.events.find(e => e.id === id && ['action_completed', 'action_failed', 'action_rejected', 'action_cancelled', 'action_skipped'].includes(e.type));
          if (receipt) break;
          if (i % 15 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        api.step(0, true);
        const checks = { admitted: admitted.accepted === true, completed: receipt?.type === 'action_completed',
          actualSupportedExecution: actualSupportedFrames > 0, actualHeadMovement: maximum.headAngle > .003,
          statePreserved: invalidFrame === null, rootPreserved: maximum.root <= .025, pelvisPreserved: maximum.pelvis <= .025,
          feetPreserved: maximum.ankle <= .025, seatPreserved: maximum.chair <= .001 && maximum.chairAngle <= .001 && maximum.seatHeight <= .025,
          propPreserved: maximum.prop <= .05 && maximum.propAngle <= .02, gripPreserved: maximum.palm <= .05 && maximum.grip <= .05 };
        return { propId, action, variant: 'support-preserving', id, checks, pass: Object.values(checks).every(Boolean),
          before, after, maximum, invalidFrame, actualSupportedFrames, frames, wallMs: performance.now() - started,
          receipt: receipt && { type: receipt.type, reason: receipt.reason, actualDuration: receipt.actualDuration }, fault: api.snapshot().fault };
      }, { propId, action });
      result.cases.push(row); await save();
      console.log(JSON.stringify({ propId, action, pass: row.pass, checks: row.checks, maximum: row.maximum }));
    }
  }
  result.pass = result.errors.length === 0 && result.fixtures.every(row => row.pass)
    && result.cases.length === actions.length * heldProps.length && result.cases.every(row => row.pass && !row.fault);
} catch (error) {
  result.errors.push(String(error));
  console.error(error);
} finally {
  await browser.close(); result.finishedAt = new Date().toISOString(); await save();
}
if (!result.pass) process.exitCode = 1;
