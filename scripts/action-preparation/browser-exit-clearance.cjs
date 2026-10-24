async page => {
  await page.waitForFunction(() => window.activityLab?.ready, null, { timeout: 180000 });
  const result = await page.evaluate(async () => {
    const THREE = await import('three'), api = window.activityLab, mode = window.activityClearanceMode ?? 'exit';
    if (!['exit', 'seated-entry', 'seated-full', 'seated-empty-full'].includes(mode)) throw Error('Unknown clearance check mode');
    const seatedMode = mode !== 'exit', emptySeated = mode === 'seated-empty-full';
    api.reset(); api.setManualClock(true); api.setView('side');
    const scene = api.scene, body = scene.body, director = api.director;
    let wall = 0, warmupFrames = 0; director.tick(0);
    if (seatedMode) {
      const initialProps = emptySeated ? api.sequences.reading_break.steps[1].setupProps : { table: true, book: { visible: true, attachment: 'table', openness: .8 } };
      const initialActivity = emptySeated ? 'sit_listen' : 'read_seated';
      scene.props.update(initialProps, { anchor: body.anchor, time: 0 });
      body.setRenderedPropsSnapshot(scene.props.snapshot()); director.play(initialActivity, { context: emptySeated ? { deskLayout: 'partitioned' } : {} });
      for (let i = 0; i < 30 * 90 && !(body.done && body.activeId === initialActivity); i++) {
        wall += 1 / 30; const clock = director.tick(wall); scene.step(clock.now, clock.dt, { render: i % 8 === 0 }); warmupFrames++;
      }
      if (!body.done || body.pose.support !== 'seated' || scene.props.snapshot().props.book.attachment !== (emptySeated ? 'table' : 'both')) throw Error('Real measured seated entry was not prepared');
    }
    if (!director.playSequence('reading_break')) throw Error('Reading recipe was not admitted from reset');
    const expected = api.sequences.reading_break.steps.map(step => typeof step === 'string' ? step : step.activity);
    const hits = [], selected = [], weights = scene.mesh.geometry.getAttribute('skinWeight'), indices = scene.mesh.geometry.getAttribute('skinIndex');
    for (let i = 0; i < indices.count; i++) {
      for (let k = 0; k < 4; k++) if (weights.getComponent(i, k) > .1 && /^(左足|右足|左ひざ|右ひざ|下半身|腰)(?:D)?$/.test(scene.mesh.skeleton.bones[indices.getComponent(i, k)]?.name ?? '')) { selected.push(i); break; }
    }
    const point = new THREE.Vector3(), ray = new THREE.Ray(), direction = new THREE.Vector3(1, .173, .319).normalize();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hitPoint = new THREE.Vector3();
    const solids = [];
    for (const id of mode === 'seated-entry' ? ['table'] : ['table', 'chair']) scene.props.objects[id].traverse(node => {
      if (node.isMesh) solids.push({ mesh: node, id: `${id}:${node.name}`, inverse: new THREE.Matrix4() });
    });
    function insideSolid(local, solid) {
      if (!solid.box.containsPoint(local)) return false;
      const geometry = solid.mesh.geometry, positions = geometry.getAttribute('position'), index = geometry.index, intersections = new Set();
      ray.set(local, direction);
      for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
        a.fromBufferAttribute(positions, index ? index.getX(i) : i);
        b.fromBufferAttribute(positions, index ? index.getX(i + 1) : i + 1);
        c.fromBufferAttribute(positions, index ? index.getX(i + 2) : i + 2);
        if (ray.intersectTriangle(a, b, c, false, hitPoint)) {
          const distance = local.distanceTo(hitPoint); if (distance > 1e-6) intersections.add(Math.round(distance * 1e6));
        }
      }
      return intersections.size % 2 === 1;
    }
    const exitStart = expected.lastIndexOf('stand_up_from_desk');
    let frames = 0, exitFrames = 0, skinSamples = 0, ended = false, segmentComplete = false, seatedReadingFrames = 0;
    const unexpectedEntryActivities = new Set();
    for (let i = 0; i < 30 * 180; i++) {
      wall += 1 / 30; const clock = director.tick(wall), out = scene.step(clock.now, clock.dt, { render: i % 8 === 0 }); frames++;
      if (seatedMode && director.sequence?.index <= 3) {
        if (body.activeId !== 'read_seated' && !(emptySeated && body.activeId === 'take_book_seated')) unexpectedEntryActivities.add(body.activeId);
        if (director.sequence?.index >= 3 && body.activeId === 'read_seated' && body.pose.support === 'seated') seatedReadingFrames++;
      }
      const exit = director.sequence && (seatedMode || director.sequence.index > exitStart);
      if (exit) {
        exitFrames++;
        const worldVertices = selected.map(index => {
          const value = new THREE.Vector3(); scene.mesh.getVertexPosition(index, value); value.applyMatrix4(scene.mesh.matrixWorld); skinSamples++;
          return { index, value };
        });
        for (const solid of solids) {
          if (seatedMode && director.sequence.index <= exitStart && solid.id.startsWith('chair:')) continue;
          if (!solid.mesh.visible || !solid.mesh.parent.visible) continue;
          solid.mesh.geometry.computeBoundingBox(); solid.mesh.updateMatrixWorld(true); solid.inverse.copy(solid.mesh.matrixWorld).invert();
          solid.box = solid.mesh.geometry.boundingBox.clone().expandByScalar(-.001);
          const worldBox = solid.box.clone().applyMatrix4(solid.mesh.matrixWorld);
          for (const side of ['left', 'right']) {
            const hip = new THREE.Vector3(...out.bones[`${side}Hip`]).applyMatrix4(solid.inverse), knee = new THREE.Vector3(...out.bones[`${side}Knee`]).applyMatrix4(solid.inverse);
            const middle = solid.box.getCenter(new THREE.Vector3()).y, t = (middle - hip.y) / (knee.y - hip.y);
            if (t >= 0 && t <= 1 && insideSolid(hip.clone().lerp(knee, t), solid)) hits.push({ type: 'actual-thigh-centerline-in-solid-furniture', solid: solid.id, side, local: hip.clone().lerp(knee, t).toArray(), activity: body.activeId, time: clock.now });
          }
          for (const vertex of worldVertices) {
            if (!worldBox.containsPoint(vertex.value)) continue;
            point.copy(vertex.value).applyMatrix4(solid.inverse);
            if (insideSolid(point, solid)) { hits.push({ type: 'actual-skinned-leg-vertex-in-solid-furniture', solid: solid.id, index: vertex.index, local: point.toArray(), activity: body.activeId, time: clock.now }); break; }
          }
          if (hits.length) break;
        }
        if (hits.length) break;
      }
      if (mode === 'seated-entry' && seatedReadingFrames >= 15) { segmentComplete = true; break; }
      if (director.sequence === null) { ended = true; segmentComplete = true; break; }
    }
    api.drawFrame(director.time, 0);
    const satisfied = director.events.filter(event => event.type === 'step-satisfied' && event.generation === director.generation).map(event => ({ id: event.id, reason: event.reason }));
    const entryCorrect = !seatedMode || (!unexpectedEntryActivities.size && satisfied.length === (emptySeated ? 2 : 3));
    return { passed: segmentComplete && exitFrames > 0 && !hits.length && entryCorrect, mode, ended, segmentComplete, expected, frames, warmupFrames, exitFrames, skinSamples, selectedLegVertices: selected.length, hits,
      seatedReadingFrames, unexpectedEntryActivities: [...unexpectedEntryActivities], satisfied,
      finalRoot: body.root, scope: seatedMode
        ? 'Real measured seated-reading entry (held book or empty hands). Actual PMX/MMD thigh centerlines and selected skinned leg vertices at 30 Hz against the table throughout the checked flow, plus the chair during exit. Legitimate seated chair support excluded. Not general character or clothing collision.'
        : 'Actual MMD/PMX thigh centerlines and all selected skinned leg vertices at 30 Hz versus closed triangle meshes of retained table and chair throughout exit steps after standing. Not general character, clothing or environment collision detection.' };
  });
  await page.screenshot({ path: `outputs/action-execution-preparation-20261023/reading-${result.mode === 'seated-entry' ? 'seated-entry-current' : 'exit-current'}.png` });
  return result;
}
