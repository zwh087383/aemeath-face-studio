const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(path.join(process.env.APPDATA, 'npm/node_modules/@playwright/cli/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'outputs/native-complete-20261022');
const output = path.join(out, 'browser-body-acceptance.json');
const url = process.env.NATIVE_RESOURCES_URL || 'http://127.0.0.1:18792/native-resources/';
const fractions = [0, .25, .5, .75, 1];

// Independent, in-memory browser profile: never attaches to another agent's
// browser or to the user's visible preview. Only private output receives data.
(async () => {
  fs.mkdirSync(out, {recursive: true});
  const browser = await chromium.launch({channel: 'chrome', headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist']});
  const page = await browser.newPage({viewport: {width: 1520, height: 1050}});
  const errors = [], requests = [];
  const result = {schema: 1, startedAt: new Date().toISOString(), url,
    evidence: 'Independent headless Chrome; real decoded local clips, both live skinned models; no cloud calls.',
    fractions, audits: [], failures: [], browserErrors: errors};
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/native-resources-data\/clips\//.test(request.url())) requests.push(request.url());
  });
  const save = () => fs.writeFileSync(output, JSON.stringify(result, null, 2));
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.nativeResources?.snapshot().ready || window.nativeResourcesError,
      {}, {timeout: 180000});
    assert.equal(await page.evaluate(() => window.nativeResourcesError), undefined);
    const manifest = await page.evaluate(async () => {
      const response = await fetch('/native-resources-data/manifest.json');
      if (!response.ok) throw Error('Manifest unavailable');
      return response.json();
    });
    const clips = manifest.clips.filter(clip => clip.status === 'ready' && clip.resourceKind === 'body');
    assert.ok(clips.length > 1, 'Manifest must have multiple ready body clips');
    assert.equal(new Set(clips.map(clip => clip.id)).size, clips.length, 'Body IDs must be unique');
    const initial = await page.evaluate(() => {
      const n = window.nativeResources, s = n.snapshot();
      n.pause(true);n.clearLayers();document.getElementById('sequence').checked = false;
      return {ready: s.ready, currentId: s.currentId, environment: s.environment, frame: s.frame};
    });
    result.manifest = {schema: manifest.schema, experimental: manifest.experimental,
      clipCount: manifest.clips.length, readyBodyCount: clips.length};
    result.initial = initial;result.initialRequests = [...requests];
    assert.equal(requests.length, 1, 'Initial loading must request exactly one clip');
    console.log(`Both model renderers ready; auditing ${clips.length} body clips at ${fractions.length} time points.`);

    // Helpers stay inside this isolated page. Vertex arrays and complete bone
    // matrices are used for comparison but are never written per frame.
    await page.evaluate(() => {
      const n = window.nativeResources;
      function skinSample(mesh, budget) {
        const positions = mesh.geometry.attributes.position, step = Math.max(1, Math.floor(positions.count / budget));
        const vector = n.clip.world[0].p.clone(), points = [];
        let sum = 0, sumSq = 0, finite = true;
        for (let index = 0; index < positions.count; index += step) {
          vector.fromBufferAttribute(positions, index);mesh.applyBoneTransform(index, vector);
          finite &&= [vector.x, vector.y, vector.z].every(Number.isFinite);
          points.push(vector.x, vector.y, vector.z);
          sum += vector.x * 1.3 + vector.y * .7 + vector.z * .2;sumSq += vector.lengthSq();
        }
        return {points, hash: {sum, sumSq, count: points.length / 3}, finite};
      }
      function displacement(first, current) {
        if (first.length !== current.length) return Infinity;
        let maximum = 0;
        for (let i = 0; i < first.length; i += 3)
          maximum = Math.max(maximum, Math.hypot(current[i] - first[i], current[i + 1] - first[i + 1], current[i + 2] - first[i + 2]));
        return maximum;
      }
      function capture(fraction, entry) {
        const snapshot = n.seek(entry.duration * fraction), sourceSkins = [];
        let sourceBoneMatricesFinite = true, sourceBoneCount = 0;
        n.source.traverse(object => {
          if (object.isBone) {sourceBoneCount++;sourceBoneMatricesFinite &&= object.matrixWorld.elements.every(Number.isFinite);}
          if (object.isSkinnedMesh) sourceSkins.push(skinSample(object, 512));
        });
        const targetSkin = skinSample(n.mesh, 1024), target = n.retarget.snapshot();
        const finite = sourceBoneMatricesFinite && n.mesh.skeleton.bones.every(bone => bone.matrixWorld.elements.every(Number.isFinite)) &&
          n.clip.world.every(t => [...t.p, ...t.q, ...t.s].every(Number.isFinite)) &&
          sourceSkins.length > 0 && sourceSkins.every(sample => sample.finite) && targetSkin.finite;
        return {fraction, time: snapshot.time, finite, sourceBoneCount,
          maxLengthError: target.maxLengthError, lastStepMs: snapshot.lastStepMs,
          sourcePoints: sourceSkins.flatMap(sample => sample.points), targetPoints: targetSkin.points,
          sourceSkin: sourceSkins.map(sample => sample.hash), targetSkin: targetSkin.hash};
      }
      function audit(entry, fractions) {
        const samples = fractions.map(fraction => capture(fraction, entry)), first = samples[0];
        const sourceMaxDisplacement = Math.max(...samples.map(sample => displacement(first.sourcePoints, sample.sourcePoints)));
        const targetMaxDisplacement = Math.max(...samples.map(sample => displacement(first.targetPoints, sample.targetPoints)));
        return {id: entry.id, name: entry.name, category: entry.category, loop: entry.loop,
          duration: n.clip.data.duration, sourceFrames: n.clip.data.frameCount,
          sourceBones: n.clip.data.bones.length, targetMappedBones: n.retarget.mapping.length,
          finite: samples.every(sample => sample.finite),
          maxLengthError: Math.max(...samples.map(sample => sample.maxLengthError)),
          sourceMaxDisplacement, targetMaxDisplacement,
          sourceMoves: sourceMaxDisplacement > 1e-6, targetMoves: targetMaxDisplacement > 1e-6,
          samples: samples.map(({sourcePoints, targetPoints, sourceBoneCount, ...sample}) => sample)};
      }
      function state() {
        const matrices = n.mesh.skeleton.bones.flatMap(bone => bone.matrixWorld.elements);
        const skins = [];n.source.traverse(object => {if (object.isSkinnedMesh) skins.push(skinSample(object, 128).hash);});
        return {matrices, sourceSkin: skins, targetSkin: skinSample(n.mesh, 256).hash};
      }
      window.__nativeBodyAudit = {audit, state};
    });

    for (const entry of clips) {
      try {
        const audit = await page.evaluate(async ({entry, fractions}) => {
          const n = window.nativeResources;await n.select(entry.id);n.pause(true);
          const s = n.snapshot();
          if (s.currentId !== entry.id || s.error) throw Error(s.error || 'Wrong body selected');
          return window.__nativeBodyAudit.audit(entry, fractions);
        }, {entry, fractions});
        result.audits.push(audit);
        const checks = [
          [audit.finite, 'nonfinite bone matrix or sampled skinned vertex'],
          [audit.maxLengthError < 1e-6, `PMX bone length changed: ${audit.maxLengthError}`],
          [audit.sourceFrames === entry.frameCount, 'frame count differs from manifest'],
          [audit.sourceBones === entry.boneCount, 'bone count differs from manifest'],
          [!audit.sourceMoves || audit.targetMoves, 'source mesh moves but target sampled skin is static'],
        ];
        for (const [ok, problem] of checks) if (!ok) result.failures.push({id: entry.id, problem});
      } catch (error) {
        result.failures.push({id: entry.id, problem: error.message});
      }
      const completed = result.audits.length + result.failures.filter(failure => !result.audits.some(audit => audit.id === failure.id)).length;
      if (completed % 25 === 0 || completed === clips.length) {
        console.log(`BODY ${completed}/${clips.length}; failures ${result.failures.length}`);save();
      }
    }

    const a = clips.find(clip => /Stand2\.uasset$/i.test(clip.sourceAsset)) || clips[0];
    const b = clips.find(clip => clip.id !== a.id && /Salut|Turn|Walk/i.test(clip.name)) || clips[1];
    result.switchRestoration = await page.evaluate(async ({a, b}) => {
      const n = window.nativeResources;
      async function selectAt(entry) {await n.select(entry.id);n.pause(true);n.seek(entry.duration * .37);return window.__nativeBodyAudit.state();}
      const before = await selectAt(a);await selectAt(b);const after = await selectAt(a);
      let maxMatrixError = 0;
      before.matrices.forEach((value, index) => {maxMatrixError = Math.max(maxMatrixError, Math.abs(value - after.matrices[index]));});
      return {a: a.id, b: b.id, maxMatrixError,
        sourceSkinRestored: JSON.stringify(before.sourceSkin) === JSON.stringify(after.sourceSkin),
        targetSkinRestored: JSON.stringify(before.targetSkin) === JSON.stringify(after.targetSkin)};
    }, {a, b});
    const restored = result.switchRestoration;
    assert.ok(restored.maxMatrixError < 1e-8, 'A-B-A changes the original target pose');
    assert.ok(restored.sourceSkinRestored && restored.targetSkinRestored, 'A-B-A skin samples drift');

    result.transport = [];
    for (const entry of [clips.find(clip => clip.loop), clips.find(clip => !clip.loop && clip.duration > .2)].filter(Boolean)) {
      await page.evaluate(async entry => {
        const n = window.nativeResources;await n.select(entry.id);n.pause(true);n.seek(entry.duration * .2);
      }, entry);
      const before = await page.evaluate(() => {
        const n = window.nativeResources, s = n.snapshot();
        return {time: s.time, frame: s.frame, state: window.__nativeBodyAudit.state()};
      });
      await page.waitForTimeout(250);
      const paused = await page.evaluate(() => ({time: window.nativeResources.snapshot().time, state: window.__nativeBodyAudit.state()}));
      assert.equal(before.time, paused.time, `${entry.id}: paused time advances`);
      assert.deepEqual(before.state, paused.state, `${entry.id}: paused skin/bones change`);
      await page.evaluate(() => window.nativeResources.pause(false));
      await page.waitForFunction(time => window.nativeResources.snapshot().time !== time, before.time, {timeout: 10000});
      const resumed = await page.evaluate(() => {const n = window.nativeResources;n.pause(true);return {time: n.snapshot().time};});
      await page.evaluate(duration => {const n = window.nativeResources;n.seek(Math.max(0, duration - .04));n.pause(false);}, entry.duration);
      if (entry.loop) await page.waitForFunction(duration => window.nativeResources.snapshot().time < duration - .05, entry.duration, {timeout: 10000});
      else await page.waitForFunction(() => !window.nativeResources.snapshot().playing, {}, {timeout: 10000});
      const ended = await page.evaluate(() => {const n = window.nativeResources, s = n.snapshot();n.pause(true);return {time: s.time, playing: s.playing};});
      if (entry.loop) assert.ok(ended.playing && ended.time < entry.duration, `${entry.id}: did not wrap`);
      else assert.ok(!ended.playing && Math.abs(ended.time - entry.duration) < 1e-8, `${entry.id}: did not stop at end`);
      result.transport.push({id: entry.id, loop: entry.loop, pausedTime: paused.time, resumedTime: resumed.time, ended});
    }

    assert.deepEqual(errors, [], 'Unexpected browser exceptions');
    result.completedAt = new Date().toISOString();result.requests = requests;
    result.acceptance = {readyBodyCount: clips.length, auditedClips: result.audits.length,
      samplesPerClip: fractions.length, totalPoses: result.audits.length * fractions.length,
      lazyInitialSingleClip: result.initialRequests.length === 1, switchRestoration: true,
      transportSamples: result.transport.length, failures: result.failures.length,
      browserErrors: errors.length, passed: !result.failures.length && result.audits.length === clips.length};
    save();console.log(JSON.stringify(result.acceptance));
    if (result.failures.length) {
      console.error(JSON.stringify(result.failures));process.exitCode = 1;
    }
  } catch (error) {
    result.failure = {message: error.message, stack: error.stack,
      diagnostic: await page.evaluate(() => ({status: document.getElementById('status')?.textContent,
        error: window.nativeResourcesError, current: window.nativeResources?.snapshot().currentId})).catch(() => null)};
    save();await page.screenshot({path: path.join(out, 'browser-body-failure.png'), fullPage: true}).catch(() => {});
    throw error;
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
