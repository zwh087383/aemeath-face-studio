// Standalone, isolated browser regression. Does not attach to an existing CLI
// session. Uses the installed Playwright CLI's runtime when no local package exists.
// node realtime/browser-performance-acceptance.cjs [url] [output-directory]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let playwright;
try { playwright = require('playwright'); }
catch {
  const root = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : '/usr/local/lib/node_modules';
  playwright = require(path.join(root, '@playwright', 'cli', 'node_modules', 'playwright'));
}
const root = path.resolve(__dirname, '..');
const url = process.argv[2] || 'http://127.0.0.1:18768/performance/';
const out = path.resolve(process.argv[3] || path.join(root, 'outputs', 'expressive-motion-20261016'));
const sourceFiles = ['preview/core/controller.js', 'preview/core/profile.js', 'preview/core/motion-controller.js',
  'preview/core/motion-skeleton.js', 'preview/core/motion-math.js', 'preview/core/motion-profile.js',
  'preview/core/expression-choreography.js', 'preview/studio/motion-rig.js', 'realtime/qwen/scene.mjs',
  'realtime/performance/director.mjs', 'realtime/performance/viewer.mjs', 'realtime/browser-performance-acceptance.cjs'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { generatedAt: new Date().toISOString(), url, boundary: 'Actual PMX browser rendering, physics disabled. Silent synthetic mouth test; no microphone, audio provider, cloud, or physical playback.', sourceHashes: hashes(), checks: [], errors: [] };
const assert = (condition, name, detail) => {
  report.checks.push({ name, passed: !!condition, detail });
  if (!condition) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};
const progress = text => console.log(`[performance acceptance] ${text}`);
const read = page => page.evaluate(() => window.performanceLab.snapshot());

(async () => {
  fs.mkdirSync(out, { recursive: true });
  let browser, page;
  try {
    browser = await playwright.chromium.launch({ channel: process.env.PERFORMANCE_BROWSER_CHANNEL || 'chrome', headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', event => { if (event.type() === 'error') report.errors.push(event.text()); });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    progress('independent browser opened; loading PMX');
    await page.waitForFunction(() => window.performanceLab?.ready || window.performanceLab?.snapshot().error, null, { timeout: 60000 });
    await page.waitForFunction(() => window.performanceLab.snapshot().rendered?.frame > 2, null, { timeout: 15000 });
    await page.evaluate(() => { const l = window.performanceLab; l.stop(); l.setOptions({ natural: false, expression: true, speech: false, speed: 1, intensity: 1 }); });
    await page.waitForFunction(() => !window.performanceLab.snapshot().motion.gestures.length, null, { timeout: 6000 });
    const ready = await read(page);
    assert(ready.ready && !ready.error && ready.rendered.finite && !ready.rendered.missingBindings.length, 'real_model_ready', { environment: ready.environment, frame: ready.rendered.frame, bindings: ready.rendered.missingBindings });

    const pause = await page.evaluate(async () => {
      const l = window.performanceLab, frame = () => new Promise(requestAnimationFrame);
      if (!l.play('laugh')) throw new Error('laugh trigger rejected');
      const deadline = performance.now() + 8000;
      while (l.snapshot().rendered.mouthOpen < .12 && performance.now() < deadline) await frame();
      const before = l.snapshot(); l.pause();
      const start = performance.now(); let maxMouth = 0, maxBone = 0, maxRotation = 0, frames = 0;
      while (performance.now() - start < 650) {
        await frame(); const current = l.snapshot(); frames++;
        maxMouth = Math.max(maxMouth, Math.abs(current.rendered.mouthOpen - before.rendered.mouthOpen));
        for (const name of Object.keys(before.rendered.bones)) {
          maxBone = Math.max(maxBone, Math.hypot(...current.rendered.bones[name].map((v,i) => v - before.rendered.bones[name][i])));
          maxRotation = Math.max(maxRotation, Math.hypot(...current.rendered.rotations[name].map((v,i) => v - before.rendered.rotations[name][i])));
        }
      }
      return { beforeMouth: before.rendered.mouthOpen, afterMouth: l.snapshot().rendered.mouthOpen, maxMouth, maxBone, maxRotation, frames, paused: l.snapshot().director.paused };
    });
    assert(pause.beforeMouth > .12 && pause.paused && pause.frames > 3 && pause.maxMouth < 1e-7 && pause.maxBone < 1e-7 && pause.maxRotation < 1e-7, 'silent_laugh_pause_freezes_actual_morphs_and_bones', pause);
    const cancellation = await page.evaluate(async () => {
      const l = window.performanceLab, frame = () => new Promise(requestAnimationFrame);
      l.pause(); await frame(); await frame();
      const before = l.snapshot(); l.stop();
      const start = performance.now(); let previous = before.rendered.mouthOpen, first = null, maxStep = 0, frames = 0, finishedAt = null;
      while (performance.now() - start < 4000) {
        await frame(); const s = l.snapshot(), mouth = s.rendered.mouthOpen; frames++;
        first ??= { mouth, elapsedMs: performance.now() - start };
        maxStep = Math.max(maxStep, Math.abs(mouth - previous)); previous = mouth;
        if (finishedAt === null && !s.motion.gestures.length && mouth < .001) finishedAt = performance.now() - start;
      }
      return { beforeMouth: before.rendered.mouthOpen, first, maxStep, frames, finishedAt, finalMouth: previous, remaining: l.snapshot().motion.gestures.length };
    });
    assert(cancellation.first.mouth > cancellation.beforeMouth * .5 && cancellation.maxStep < .09 && cancellation.finishedAt !== null && cancellation.finalMouth < .001 && cancellation.remaining === 0, 'silent_laugh_cancel_decays_without_instant_mouth_closure', cancellation);
    progress('pause and cancellation actual-morph regressions passed');

    const replacement = await page.evaluate(async () => {
      const l = window.performanceLab, frame = () => new Promise(requestAnimationFrame);
      if (!l.play('bow_smile')) throw new Error('bow trigger rejected');
      const deadline = performance.now() + 6000;
      while (!l.snapshot().motion.gestures.some(g => g.gesture === 'bow_smile' && g.phase === 'stroke') && performance.now() < deadline) await frame();
      const before = l.snapshot(), accepted = l.play('look_up');
      let oldRetracting = false, newStarted = false, finite = true, maxWristStep = 0, prev = before.rendered;
      const start = performance.now();
      while (performance.now() - start < 2200) {
        await frame(); const s = l.snapshot(); finite &&= s.rendered.finite;
        oldRetracting ||= s.motion.gestures.some(g => g.gesture === 'bow_smile' && g.recovering);
        newStarted ||= s.motion.gestures.some(g => g.gesture === 'look_up' && !g.recovering);
        for (const key of ['leftWrist', 'rightWrist']) maxWristStep = Math.max(maxWristStep, Math.hypot(...s.rendered.bones[key].map((v,i) => v-prev.bones[key][i])));
        prev = s.rendered;
      }
      l.stop(); return { accepted, oldRetracting, newStarted, finite, maxWristStep, previousPhase: before.motion.gestures.find(g => g.gesture === 'bow_smile')?.phase };
    });
    assert(replacement.accepted && replacement.previousPhase === 'stroke' && replacement.oldRetracting && replacement.newStarted && replacement.finite && replacement.maxWristStep < .85, 'new_action_replaces_live_pose_continuously', replacement);
    await page.waitForFunction(() => !window.performanceLab.snapshot().motion.gestures.length, null, { timeout: 6000 });

    const speech = await page.evaluate(async () => {
      const { VOWELS, C } = await import('/preview/core/profile.js');
      const l = window.performanceLab, frame = () => new Promise(requestAnimationFrame);
      l.setOptions({ speech: true }); if (!l.play('laugh')) throw new Error('speech laugh rejected');
      const start = performance.now(); let maxError = 0, peakMouth = 0, peakSmileEyes = 0, frames = 0;
      while (performance.now() - start < 2500) {
        await frame(); const s = l.snapshot(); frames++;
        for (const i of [...VOWELS,C.mouthWide,C.mouthNarrow,C.mouthFlat]) maxError = Math.max(maxError, Math.abs(s.rendered.weights[i] - l.scene.face.weights[i]));
        peakMouth = Math.max(peakMouth, s.rendered.mouthOpen); peakSmileEyes = Math.max(peakSmileEyes, s.rendered.weights[C.smileEyes]);
      }
      l.stop(); l.setOptions({ speech: false }); return { maxError, peakMouth, peakSmileEyes, frames };
    });
    assert(speech.frames > 10 && speech.maxError < 1e-7 && speech.peakMouth > .2 && speech.peakSmileEyes > .1, 'synthetic_speech_vowels_remain_owned_by_face_controller', speech);
    progress('replacement and synthetic speech protection passed');
    await page.waitForFunction(() => !window.performanceLab.snapshot().motion.gestures.length, null, { timeout: 6000 });

    const ids = await page.evaluate(() => [...document.querySelectorAll('[data-gesture]')].map(b => b.dataset.gesture));
    for (const id of ids) {
      const action = await page.evaluate(async id => {
        const l = window.performanceLab, frame = () => new Promise(requestAnimationFrame);
        const before = l.snapshot();
        if (!l.play(id)) throw new Error(`${id} rejected`);
        const start = performance.now(); let frames = 0, seen = false, finite = true, bound = true, maxBody = 0, maxHands = 0;
        const phases = new Set();
        while (performance.now() - start < 14000) {
          await frame(); const s = l.snapshot(), g = s.motion.gestures.find(g => g.gesture === id && !g.recovering); frames++;
          if (g) { seen = true; phases.add(g.phase); }
          finite &&= s.rendered.finite && s.rendered.weights.every(Number.isFinite);
          bound &&= s.rendered.missingBindings.length === 0;
          for (const key of ['head', 'chest']) maxBody = Math.max(maxBody, Math.hypot(...s.rendered.rotations[key].map((v,i) => v-before.rendered.rotations[key][i])));
          for (const key of ['leftWrist','rightWrist']) maxHands = Math.max(maxHands, Math.hypot(...s.rendered.bones[key].map((v,i) => v-before.rendered.bones[key][i])));
          if (seen && !s.motion.gestures.length) break;
        }
        return { id, frames, seen, finite, bound, maxBody, maxHands, phases: [...phases], remaining: l.snapshot().motion.gestures.length, elapsedMs: performance.now()-start };
      }, id);
      assert(action.seen && action.frames > 8 && action.finite && action.bound && action.maxBody > .002 && action.maxHands > .04 && action.phases.includes('stroke') && action.phases.includes('recover') && action.remaining === 0, `rendered_action_${id}`, action);
      progress(`${id} complete (${Math.round(action.elapsedMs)} ms, ${action.frames} frames)`);
    }
    assert(ids.length === 16, 'all_public_actions_exercised', ids);
    const final = await read(page);
    assert(report.errors.length === 0 && !final.error && final.rendered.finite, 'no_browser_or_render_errors', report.errors);
    report.final = { environment: final.environment, performance: final.performance, frame: final.rendered.frame };
    report.passed = true;
  } catch (error) {
    report.passed = false; report.failure = error.stack || String(error);
    if (page) { try { await page.screenshot({ path: path.join(out, 'performance-acceptance-failure.png') }); report.failureSnapshot = await read(page); } catch {} }
    process.exitCode = 1; console.error(report.failure);
  } finally {
    const after = hashes(); report.sourceChangedDuringRun = sourceFiles.filter(file => after[file] !== report.sourceHashes[file]);
    if (report.sourceChangedDuringRun.length) { report.passed = false; process.exitCode = 1; }
    fs.writeFileSync(path.join(out, 'browser-performance-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
    if (browser) await browser.close();
    progress(`finished: ${report.passed ? 'PASS' : 'FAIL'}; ${report.checks.filter(c => c.passed).length}/${report.checks.length} checks; own browser closed`);
  }
})();
