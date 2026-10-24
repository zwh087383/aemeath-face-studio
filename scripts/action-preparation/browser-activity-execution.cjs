async page => {
  const report = { startedAt: new Date().toISOString(), errors: [], activities: [], sequences: [],
    scope: 'Actual PMX and MMD grants at 30 Hz; render submission and sampled skin at 3.75 Hz. Real fixed-size prop grips and transfer receipts. No collision, physical balance or aesthetic approval.' };
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.activityLab?.snapshot().ready || window.activityLab?.snapshot().error, null, { timeout: 180000, polling: 250 });
  const initial = await page.evaluate(() => window.activityLab.snapshot()); if (initial.error) throw Error(initial.error);
  await page.evaluate(() => window.activityLab.setManualClock(true));
  const definitions = await page.evaluate(() => {
    const api = window.activityLab, selection = window.activityPreparationScope;
    const activities = selection?.activities ?? Object.keys(api.catalog), sequences = selection?.sequences ?? Object.keys(api.sequences);
    if (!Array.isArray(activities) || !Array.isArray(sequences) || activities.some(id => !Object.hasOwn(api.catalog, id)) || sequences.some(id => !Object.hasOwn(api.sequences, id))) throw Error('Invalid explicit browser acceptance scope');
    return { activities, sequences };
  });
  report.requested = definitions;
  const run = async (id, sequence) => page.evaluate(async ({ id, sequence }) => {
    const THREE = await import('three');
    const { ACTIVITY_PROP_LAYOUT, propGripPair, readHandAnchor } = await import('/preview/core/activity-prop-layout.js');
    const api = window.activityLab; api.reset(); api.setManualClock(true);
    const scene = api.scene, body = scene.body, director = api.director; scene.setPropOverride(null);
    const hz = 30, dt = 1 / hz;
    let wall = 0, frames = 0, renders = 0, samples = 0, maximumGripError = 0, maximumArmReach = 0,
      maximumContactError = 0, maximumContactReach = 0, maximumContactElbowOutward = 0, contactSamples = 0,
      previousProps = {}, maximumPlacedDrift = 0, maximumTransferJump = 0, sequenceGeneration = null;
    const errors = new Set(), heldSamples = {}, placementReceipts = new Set(), acquisitionReceipts = new Set(), completed = [];
    const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
    director.tick(0);
    const tick = () => {
      wall += dt; const clock = director.tick(wall), render = frames % 8 === 0;
      const out = scene.step(clock.now, clock.dt, { paused: clock.paused, render }); frames++;
      if (!out.finite) errors.add('nonfinite actual pose');
      if (render) {
        renders++; const attribute = scene.mesh.geometry.getAttribute('position');
        for (let i = 0; i < 32; i++) {
          const index = Math.floor(i * attribute.count / 32), point = new THREE.Vector3(); scene.mesh.getVertexPosition(index, point);
          if (![point.x, point.y, point.z].every(Number.isFinite)) errors.add(`nonfinite sampled skin:${index}`); samples++;
        }
      }
      const props = out.props.props, arms = body.diagnostics.arms;
      for (const [key, contact] of Object.entries(body.pose.propContacts?.props ?? {})) {
        if (!contact.ready) errors.add(`unready prop-contact plan:${key}:${body.activeId}:${body.pose.phase}`);
        for (const [side, target] of Object.entries(contact.targets ?? {})) {
          const prefix = side === 'L' ? 'left' : 'right', hand = readHandAnchor({ bones: out.bones, rotations: out.rotations }, prefix);
          if (!hand || !Array.isArray(target) || target.length !== 3) { errors.add(`missing actual contact target:${key}:${side}`); continue; }
          const gap = distance(hand.position, target); contactSamples++;
          maximumContactError = Math.max(maximumContactError, gap); maximumContactReach = Math.max(maximumContactReach, arms[side].reach);
          if (gap > .025 || arms[side].reach > .995001) errors.add(`unreachable actual surface contact:${key}:${side}:${body.activeId}:${body.pose.phase}`);
          const elbow = out.bones[`${prefix}Elbow`], shoulder = out.bones[`${prefix}Shoulder`];
          if (elbow && shoulder && out.rotations.chest) {
            const local = new THREE.Vector3(...elbow).sub(new THREE.Vector3(...shoulder)).applyQuaternion(new THREE.Quaternion(...out.rotations.chest).invert());
            maximumContactElbowOutward = Math.max(maximumContactElbowOutward, local.x * (side === 'L' ? 1 : -1));
          }
        }
      }
      for (const [key, value] of Object.entries(props)) {
        if (value.visible && value.scale?.some(v => Math.abs(v - 1) > 1e-12)) errors.add(`changed prop scale:${key}`);
        if (value.visible && ['both', 'left', 'right'].includes(value.attachment)) {
          heldSamples[key] = (heldSamples[key] ?? 0) + 1;
          if (!value.measured) errors.add(`unmeasured held prop:${key}`);
          const state = body.pose.props[key] ?? {}, pair = propGripPair(key, value.openness);
          const targets = value.attachment === 'both' ? [['L', pair?.left], ['R', pair?.right]]
            : [[value.attachment === 'left' ? 'L' : 'R', state.grip ?? ACTIVITY_PROP_LAYOUT[key]?.grip]];
          for (const [side, grip] of targets) {
            const hand = readHandAnchor({ bones: out.bones, rotations: out.rotations }, side === 'L' ? 'left' : 'right');
            if (!grip || !hand) { errors.add(`missing actual grip:${key}:${side}`); continue; }
            const point = new THREE.Vector3(...grip).multiply(new THREE.Vector3(...value.scale)).applyQuaternion(new THREE.Quaternion(...value.quaternion)).add(new THREE.Vector3(...value.position));
            const gap = point.distanceTo(new THREE.Vector3(...hand.position)); maximumGripError = Math.max(maximumGripError, gap);
            if (gap > .025) errors.add(`actual grip gap:${key}:${side}:${body.activeId}:${body.pose.phase}`);
            maximumArmReach = Math.max(maximumArmReach, arms[side].reach);
            if (arms[side].reach > .995001) errors.add(`unreachable held grip:${key}:${side}:${body.activeId}`);
          }
        }
        const previous = previousProps[key];
        if (previous?.visible && value.visible && ['book', 'mug', 'pencil', 'box'].includes(key)) {
          const wasPlaced = ['table', 'floor'].includes(previous.attachment), isPlaced = ['table', 'floor'].includes(value.attachment);
          if (wasPlaced && isPlaced && previous.attachment === value.attachment) {
            const movement = distance(previous.position, value.position); maximumPlacedDrift = Math.max(maximumPlacedDrift, movement);
            if (movement > .001) errors.add(`scene-owned prop moved:${key}:${body.activeId}`);
          }
          if (wasPlaced !== isPlaced) {
            const jump = distance(previous.position, value.position); maximumTransferJump = Math.max(maximumTransferJump, jump);
            if (jump > .03) errors.add(`transfer position jump:${key}:${body.activeId}`);
          }
        }
      }
      for (const [key, receipt] of Object.entries(out.props.placementReceipts ?? {})) if (receipt?.released === true && receipt.operation === 'place') placementReceipts.add(key);
      for (const [key, receipt] of Object.entries(out.props.acquisitionReceipts ?? {})) if (receipt?.released === true && receipt.operation === 'take') acquisitionReceipts.add(key);
      previousProps = structuredClone(props);
      for (const event of director.events) if (event.type === 'step-completed' && event.generation === sequenceGeneration && !completed.some(row => row.index === event.index)) completed.push({ index: event.index, id: event.id, variant: event.variant ?? null });
      return out;
    };
    const until = (predicate, seconds) => { for (let i = 0; i < seconds * hz; i++) { tick(); if (predicate()) return true; } return false; };
    const arrangeSource = activity => {
      const definition = api.catalog[activity], propId = definition.propId ?? (definition.reading ? 'book' : definition.kind === 'drink' ? 'mug' : definition.kind === 'write' ? 'pencil' : definition.kind === 'carry' ? 'box' : null);
      if (!propId) return;
      const state = { visible: true, attachment: 'table', ...(propId === 'book' ? { openness: .8 } : {}),
        ...(propId === 'pencil' ? { position: [-2.6, 8.961, 3.2], rotation: [0, 0, -Math.PI / 2] } : {}),
        ...(propId === 'box' ? { position: [0, 8.9, 3.8] } : {}) };
      scene.props.update({ table: true, [propId]: state }, { anchor: body.anchor, time: director.time });
      body.setRenderedPropsSnapshot(scene.props.snapshot());
    };
    const definition = api.catalog[id];
    if (!sequence && definition.kind === 'put_prop') {
      const seated = definition.initialSupport === 'seated';
      const before = definition.propId === 'book' ? seated ? 'study_at_desk' : 'read_standing' : definition.propId === 'mug' ? seated ? 'drink_seated' : 'drink_standing' : 'write_at_desk';
      arrangeSource(before);
      if (!director.play(before) || !until(() => body.done && body.activeId === before, 90)) throw Error('Placement predecessor failed: ' + before);
    } else if (!sequence) arrangeSource(id);
    const accepted = sequence ? director.playSequence(id) : director.play(id);
    sequenceGeneration = sequence ? director.generation : null;
    const ended = accepted && until(() => sequence ? director.sequence === null : body.done && body.activeId === id, sequence ? 300 : 90);
    const relevant = director.events.filter(event => event.generation === sequenceGeneration);
    const rejected = sequence && relevant.some(event => event.type === 'sequence-rejected');
    const expected = sequence ? api.sequences[id].steps.map(step => typeof step === 'string' ? step : step.activity) : [];
    if (sequence && JSON.stringify(completed.map(row => row.id)) !== JSON.stringify(expected)) errors.add('recipe did not complete every own step in order');
    if (!sequence && (definition.kind === 'take_prop' || definition.kind === 'pickup' && definition.propId) && !acquisitionReceipts.has(definition.propId)) errors.add('take ended without actual acquisition receipt');
    if (!sequence && definition.kind === 'put_prop' && !placementReceipts.has(definition.propId)) errors.add('placement ended without actual release receipt');
    return { id, sequence, accepted, ended, rejected, frames, renders, surfaceSamples: samples,
      support: body.pose.support, activeId: body.activeId, variant: body.snapshot().variant ?? null, status: body.status, blocker: body.pose.preparationBlocker,
      maximumGripError, maximumArmReach, maximumContactError, maximumContactReach, maximumContactElbowOutward, contactSamples,
      maximumPlacedDrift, maximumTransferJump, heldSamples,
      placementReceipts: [...placementReceipts], acquisitionReceipts: [...acquisitionReceipts], completed, expected,
      finalProps: scene.props.snapshot(), errors: [...errors], passed: Boolean(accepted && ended && !rejected && !errors.size) };
  }, { id, sequence });
  for (const id of definitions.activities) {
    const row = await run(id, false); report.activities.push(row);
    if (!row.passed) { report.passed = false; return report; }
  }
  for (const id of definitions.sequences) {
    const row = await run(id, true); report.sequences.push(row);
    if (!row.passed) { report.passed = false; return report; }
  }
  report.completedAt = new Date().toISOString();
  report.passed = !report.errors.length && report.activities.every(r => r.passed) && report.sequences.every(r => r.passed);
  const all = [...report.activities, ...report.sequences];
  report.summary = { activities: report.activities.length, sequences: report.sequences.length,
    frames: all.reduce((n, r) => n + r.frames, 0), renders: all.reduce((n, r) => n + r.renders, 0),
    maximumGripError: Math.max(...all.map(row => row.maximumGripError)), maximumArmReach: Math.max(...all.map(row => row.maximumArmReach)),
    maximumContactError: Math.max(...all.map(row => row.maximumContactError)), maximumContactReach: Math.max(...all.map(row => row.maximumContactReach)),
    maximumTransferJump: Math.max(...all.map(row => row.maximumTransferJump)) };
  return report;
}
