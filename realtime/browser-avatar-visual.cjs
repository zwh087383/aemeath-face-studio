async page => {
  // Set __avatarEvidencePath to an existing absolute output directory. Invoke
  // separately with __avatarVisualPart='faces' and 'body' to keep calls short.
  const configuration = await page.evaluate(() => ({ path: window.__avatarEvidencePath, part: window.__avatarVisualPart || 'faces' }));
  if (typeof configuration.path !== 'string' || !/^(?:[A-Za-z]:[\\/]|\/)/.test(configuration.path)) {
    throw new Error('Set window.__avatarEvidencePath to an existing absolute output directory');
  }
  if (!['faces', 'body'].includes(configuration.part)) throw new Error(`Unknown visual part: ${configuration.part}`);
  const directory = configuration.path.replace(/[\\/]+$/, ''), captures = [], errors = [];
  const pageError = error => errors.push(error.message);
  page.on('pageerror', pageError);
  const read = () => page.evaluate(() => window.avatarLab.snapshot());
  const accept = result => result === true || result?.accepted === true;
  const start = async () => {
    const result = await page.evaluate(() => window.avatarLab.start({ sidecar: false, autoSubtitles: false,
      providerFast: false, starve: false, chunkMs: 20 }));
    if (result !== true) throw new Error('Visual reply did not start');
    await page.waitForFunction(() => {
      const s = window.avatarLab.snapshot(); return s.session.audio.status === 'playing' && s.session.audio.time > .08;
    }, undefined, { timeout: 7000 });
  };
  const capture = async (name, intended) => {
    const before = await read();
    if (!before.rendered.finite || before.rendered.missingBindings.length || before.session.scheduler.fault || before.session.audio.fault) {
      throw new Error(`Invalid rendered state for ${name}`);
    }
    const path = `${directory}/${name}.png`;
    await page.locator('canvas').first().screenshot({ path });
    const after = await read();
    captures.push({ name, path, intended,
      before: { frame: before.rendered.frame, mouthOpen: before.rendered.mouthOpen,
        audioTime: before.session.audio.time, audioStatus: before.session.audio.status,
        face: before.face, motion: before.motion, rendered: before.rendered },
      after: { frame: after.rendered.frame, audioTime: after.session.audio.time, audioStatus: after.session.audio.status,
        preset: after.face.preset, gestures: after.motion.gestures } });
  };
  try {
    await page.waitForFunction(() => window.avatarLab?.ready, undefined, { timeout: 30000 });
    await page.evaluate(() => { window.avatarLab.setIdle(false); window.avatarLab.setNatural(false); });
    if (configuration.part === 'faces') {
      await page.evaluate(() => window.avatarLab.setView('face'));
      for (const preset of ['neutral', 'smile', 'happy', 'curious', 'focus', 'surprise', 'shy', 'playful']) {
        await start();
        const queued = await page.evaluate(preset => {
          const lab = window.avatarLab, epoch = lab.snapshot().session.owner.epoch;
          return lab.enqueue({ id: `visual-face-${epoch}-${preset}`, kind: 'expression', preset });
        }, preset);
        if (!accept(queued)) throw new Error(`Expression cue rejected: ${preset}: ${JSON.stringify(queued)}`);
        await page.waitForFunction(preset => {
          const s = window.avatarLab.snapshot();
          return s.face.preset === preset && s.session.audio.time >= .65 && s.session.audio.status === 'playing';
        }, preset, { timeout: 5000 });
        await capture(`avatar-face-${preset}`, { preset, view: 'face', actualAudioRunning: true });
        await page.evaluate(() => window.avatarLab.cancel('visual_face_complete'));
      }
    } else {
      for (const view of ['body', 'angle']) {
        await page.evaluate(view => window.avatarLab.setView(view), view);
        for (const [gesture, phase] of [['explain', 'hold'], ['wave', 'stroke'], ['shrug', 'hold'], ['chest', 'hold']]) {
          await start();
          await page.waitForFunction(() => window.avatarLab.snapshot().motion.gestures.length === 0, undefined, { timeout: 5000 });
          const queued = await page.evaluate(({ gesture, view }) => {
            const lab = window.avatarLab, epoch = lab.snapshot().session.owner.epoch;
            const face = lab.enqueue({ id: `visual-neutral-${epoch}`, kind: 'expression', preset: 'neutral' });
            const id = `visual-${view}-${gesture}-${epoch}`;
            return { id, face, body: lab.enqueue({ id, kind: 'gesture', gesture }) };
          }, { gesture, view });
          if (!accept(queued.face) || !accept(queued.body)) throw new Error(`Visual gesture rejected: ${JSON.stringify(queued)}`);
          await page.waitForFunction(({ id, phase }) => window.avatarLab.snapshot().motion.gestures.some(g => g.id === id && g.phase === phase && !g.recovering),
            { id: queued.id, phase }, { timeout: 10000 });
          await capture(`avatar-${view}-${gesture}`, { gesture, id: queued.id, phase, view,
            timingBoundary: 'Captured during live playback, not a frozen authored key. Before/after phases document any phase transition while the screenshot was taken.' });
          await page.evaluate(() => window.avatarLab.cancel('visual_body_complete'));
          await page.waitForFunction(() => window.avatarLab.snapshot().motion.gestures.length === 0, undefined, { timeout: 5000 });
        }
      }
    }
    if (errors.length) throw new Error(`Visual page errors: ${JSON.stringify(errors)}`);
    const result = { passed: true, generatedAt: new Date().toISOString(), part: configuration.part, captures, errors,
      boundary: 'Actual live PMX canvas screenshots with local streamed audio and its precomputed lip track, physics disabled. Saving screenshots does not itself confirm visual quality or absence of sleeve/hair intersections; inspect the images.' };
    await page.evaluate(({ part, result }) => { window.__avatarVisual ||= {}; window.__avatarVisual[part] = result; }, { part: configuration.part, result });
    return { passed: true, part: configuration.part, captures: captures.map(({ name, path }) => ({ name, path })), evidenceGlobal: `__avatarVisual.${configuration.part}` };
  } catch (error) {
    const final = await read().catch(() => null);
    const result = { passed: false, generatedAt: new Date().toISOString(), part: configuration.part, error: error.message, captures, errors, final };
    await page.evaluate(({ part, result }) => { window.__avatarVisual ||= {}; window.__avatarVisual[part] = result; }, { part: configuration.part, result }).catch(() => {});
    throw error;
  } finally { page.off('pageerror', pageError); }
}
