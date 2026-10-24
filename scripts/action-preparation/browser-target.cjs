async page => {
  const report = { schema: 1, startedAt: new Date().toISOString(),
    url: page.url(), evidence: 'Independent playwright-cli Chrome profile; current native-resources viewer, real PMX, GLTF, NativeRetarget and exact authored ribbon companion; native skirt binding enabled.',
    scope: 'All current ready body clips sampled at up to 31 positions. Matrix/length/sampled CPU skin checks in a real GPU-rendered page; screenshot observations kept separate.',
    exclusions: ['Not arbitrary interruptibility, collision clearance, physical balance or aesthetic acceptance.', 'Render step time is CPU submission and not GPU completion.', '31 time samples do not cover all between-sample motion.'], clips: [], errors: [], screenshots: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  const ready = await page.evaluate(() => ({ ready: window.nativeResources?.snapshot().ready, error: window.nativeResourcesError }));
  if (!ready.ready || ready.error) throw Error(`Viewer unavailable: ${JSON.stringify(ready)}`);
  const entries = await page.evaluate(async () => (await (await fetch('/native-resources-data/manifest.json')).json()).clips.filter(row => row.resourceKind === 'body' && row.status === 'ready'));
  const ids = ['body-stand2-84d0c0a158','body-wuzui02-start-ea77396c2f','body-stand1-action01-39d6c0f416',
    'aimisi-turn-left90','aimisi-turn-right90','aimisi-salut01','aimisi-breath01',
    'aimisi-thinking01-start','aimisi-thinking01-loop','aimisi-thinking01-end',
    'aimisi-showhand01-start','aimisi-showhand01-loop','aimisi-showhand01-end',
    'aimisi-sit-talk01-start','aimisi-sit-talk01-loop','aimisi-sit-talk01-end',
    'aimisi-sit-thinking01-start','aimisi-sit-thinking01-loop','aimisi-sit-thinking01-end',
    'female-m-walk-forward','female-m-walk-backward','body-run-f-6bc12c76c6',
    'aimisi-walk-talk01','aimisi-walk-thinking01','body-aimisi-fanclub-6e686ba208'];
  const selected = entries;
  if (selected.some(row => !row)) throw Error('Representative ID missing from current manifest');
  report.initial = await page.evaluate(() => {
    const n = window.nativeResources; n.pause(true); n.clearLayers(); n.setClothEnabled(true);
    document.getElementById('sequence').checked = false;
    const s=n.snapshot(); return {ready:s.ready,currentId:s.currentId,environment:s.environment,cloth:s.cloth};
  });
  await page.evaluate(() => {
    const n = window.nativeResources, mesh = n.mesh, attr = mesh.geometry.attributes;
    const part = index => {
      for (let bone = mesh.skeleton.bones[index]; bone?.isBone; bone = bone.parent) {
        const name = bone.name;
        if (bone.userData.nativeClothVirtual || /^(?:スカート_|[左右]侧裙_|[左右]裙[A-D]|Bone_(?:Skirt|Piao27))/.test(name)) return 'skirt';
        if (/髪|发|辫|Bone_Hair/.test(name)) return 'hair';
        if (/^左(?:肩|腕|ひじ|手|親指|人指|中指|薬指|小指)/.test(name)) return 'left-arm-hand';
        if (/^右(?:肩|腕|ひじ|手|親指|人指|中指|薬指|小指)/.test(name)) return 'right-arm-hand';
        if (/^左(?:足|ひざ|つま先)/.test(name)) return 'left-leg-foot';
        if (/^右(?:足|ひざ|つま先)/.test(name)) return 'right-leg-foot';
        if (/^(?:頭|首|[左右]目)/.test(name)) return 'head-neck';
        if (/^(?:腰|下半身|上半身)/.test(name)) return 'torso';
      }
      return 'other';
    };
    const groups = {};
    for (let i = 0; i < attr.position.count; i++) {
      let weight = -Infinity, dominant = 0;
      for (let k = 0; k < 4; k++) if (attr.skinWeight.getComponent(i, k) > weight) {
        weight = attr.skinWeight.getComponent(i, k); dominant = attr.skinIndex.getComponent(i, k);
      }
      const name = part(dominant); (groups[name] ??= []).push(i);
    }
    const samples = Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, Array.from({ length: Math.min(128, rows.length) }, (_, k) => rows[Math.floor(k * rows.length / Math.min(128, rows.length))])]));
    const vector = n.clip.world[0].p.clone();
    const capture = () => {
      const parts = {}, pelvisP = n.retarget.bones.get('腰').getWorldPosition(vector.clone()), pelvisInv = n.retarget.bones.get('腰').getWorldQuaternion(n.clip.world[0].q.clone()).invert();
      for (const [name, rows] of Object.entries(samples)) {
        const world = [], relative = []; let finite = true;
        for (const i of rows) {
          vector.fromBufferAttribute(attr.position, i); mesh.applyBoneTransform(i, vector);
          finite &&= [...vector].every(Number.isFinite); world.push(...vector);
          vector.sub(pelvisP).applyQuaternion(pelvisInv); relative.push(...vector);
        }
        parts[name] = { world, relative, finite };
      }
      return { parts, finite: mesh.skeleton.bones.every(bone => bone.matrixWorld.elements.every(Number.isFinite)), length: n.retarget.snapshot().maxLengthError };
    };
    const displacement = (a, b) => {
      let maximum = 0; for (let i = 0; i < a.length; i += 3) maximum = Math.max(maximum, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2])); return maximum;
    };
    window.__targetPreparationAudit = { capture, displacement, samples, groups: Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, rows.length])) };
  });
  report.surfaceCoverage = await page.evaluate(() => ({ originalVerticesPerGroup: window.__targetPreparationAudit.groups, sampledVerticesPerGroup: Object.fromEntries(Object.entries(window.__targetPreparationAudit.samples).map(([name, rows]) => [name, rows.length])) }));
  for (const entry of selected) {
    const result = await page.evaluate(async entry => {
      const n = window.nativeResources, audit = window.__targetPreparationAudit;
      await n.select(entry.id); n.pause(true); const state = n.snapshot();
      if (state.currentId !== entry.id || state.error) throw Error(state.error || 'Wrong body selected');
      let first, finite = true, maxLengthError = 0, maxSubmitMs = 0;
      const parts = {}, poseCount = Math.min(31, n.clip.data.frameCount);
      for (let j = 0; j < poseCount; j++) {
        n.seek(entry.duration * j / (poseCount - 1 || 1)); const current = audit.capture();
        first ??= current; finite &&= current.finite; maxLengthError = Math.max(maxLengthError, current.length); maxSubmitMs = Math.max(maxSubmitMs, n.snapshot().lastStepMs);
        for (const [name, value] of Object.entries(current.parts)) {
          const row = parts[name] ??= { finite: true, maxWorldDisplacement: 0, maxPelvisRelativeDisplacement: 0 };
          row.finite &&= value.finite;
          row.maxWorldDisplacement = Math.max(row.maxWorldDisplacement, audit.displacement(first.parts[name].world, value.world));
          row.maxPelvisRelativeDisplacement = Math.max(row.maxPelvisRelativeDisplacement, audit.displacement(first.parts[name].relative, value.relative));
        }
      }
      return { id: entry.id, name: entry.name, poses: poseCount, finite, maxLengthError, maxSubmitMs,
        sourceFrames: n.clip.data.frameCount, mappedBones: n.retarget.mapping.length,
        longHairMapped: n.retarget.snapshot().nativeLongHairMapped, layers: n.snapshot().layers.map(row=>({id:row.id,kind:row.kind,automatic:row.automatic,nativeMapped:row.native?.mapped,targetMapped:row.target?.mapped})), cloth: n.snapshot().cloth,
        parts, passed: finite && maxLengthError < 1e-7 && Object.values(parts).every(row => row.finite) };
    }, entry).catch(error => ({ id: entry.id, error: error.message, passed: false }));
    report.clips.push(result);
  }
  report.restoration = await page.evaluate(async () => {
    const n = window.nativeResources;
    const get = async id => { await n.select(id); n.pause(true); n.seek(n.clip.data.duration * .37); return { matrices: n.mesh.skeleton.bones.flatMap(bone => bone.matrixWorld.elements), surface: window.__targetPreparationAudit.capture() }; };
    const before = await get('body-stand2-84d0c0a158'); await get('body-wuzui02-start-ea77396c2f'); const after = await get('body-stand2-84d0c0a158');
    return { maxMatrixError: Math.max(...before.matrices.map((x, i) => Math.abs(x - after.matrices[i]))), sameSurface: JSON.stringify(before.surface) === JSON.stringify(after.surface) };
  });
  for (const id of ['body-stand2-84d0c0a158','body-wuzui02-start-ea77396c2f','aimisi-turn-left90']) {
    await page.evaluate(async id => { const n = window.nativeResources; await n.select(id); n.pause(true); n.seek(n.clip.data.duration * .5); }, id);
    for (const view of ['front','side']) {
      await page.evaluate(view => window.nativeResources.setView(view), view);
      const filename = `${id}-${view}.png`;
      await page.locator('#comparison').screenshot({ path: filename }); report.screenshots.push(filename);
    }
  }
  report.completedAt = new Date().toISOString();
  report.acceptance = { requested: selected.length, audited: report.clips.length, poses: report.clips.reduce((sum, row) => sum + (row.poses ?? 0), 0),
    passed: report.clips.every(row => row.passed) && !report.errors.length && report.restoration.maxMatrixError < 1e-8 && report.restoration.sameSurface,
    failures: report.clips.filter(row => !row.passed).map(row => row.id), repairedWuzuiActuallyLoaded: report.clips.some(row => row.id === 'body-wuzui02-start-ea77396c2f' && row.passed) };
  return report;
}
