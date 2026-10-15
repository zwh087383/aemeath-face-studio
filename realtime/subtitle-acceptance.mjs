import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = dirname(fileURLToPath(import.meta.url));
const face = dirname(root);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDirectory = resolve(face, 'outputs/subtitle-sidecar-20261015', runId);
mkdirSync(outputDirectory, { recursive: true });

function manifest(directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...manifest(join(directory, entry.name)));
    } else if (/\.(mjs|cjs|html|css|md)$/.test(entry.name)) {
      const path = join(directory, entry.name);
      files.push({
        path: relative(root, path).replaceAll('\\', '/'),
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const before = manifest();
const testFiles = readdirSync(join(root, 'tests'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join(root, 'tests', name));
const requiredExistingTests = ['controller-sink.test.mjs', 'scheduler.test.mjs', 'stream-audio.test.mjs'];
const missingExistingTests = requiredExistingTests.filter(name => !testFiles.includes(join(root, 'tests', name)));
const requiredSubtitleTests = ['subtitle-rules.test.mjs', 'subtitle-sidecar.test.mjs'];
const missingSubtitleTests = requiredSubtitleTests.filter(name => !testFiles.includes(join(root, 'tests', name)));
const testRun = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], {
  cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
});
writeFileSync(join(outputDirectory, 'tests.tap'), testRun.stdout ?? '');
writeFileSync(join(outputDirectory, 'tests.stderr.txt'), testRun.stderr ?? '');

function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1),
    p95: sorted[Math.floor((sorted.length - 1) * .95)] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

async function benchmarkRules() {
  const { selectSubtitleCues } = await import('./subtitle-rules.mjs');
  const corpus = [
    '你好，很高兴见到你。', '谢谢你陪着我。', '我有一点难过。',
    '我没有难过，只是想休息一下。', '不要摇头，先听我说完。',
    '不是不高兴，但我现在说不清楚。', '我很好奇，你刚才想到了什么？',
    '真的吗？这太让人惊讶了。', '嗯，我明白了。', '我们可以先试试看。',
    '她刚才说“我很开心”。', '这个方法需要三个步骤，先打开设置。',
    'I am not happy about that.', 'Thank you, that is helpful.',
    'a'.repeat(512), 'a'.repeat(513),
  ];
  const profile = { profile: 'balanced', userText: '我们聊一下今天的事情。' };
  const off = [], on = [], pairedDelta = [];
  const repetitions = 20;
  const callsPerBatch = corpus.length * repetitions;
  let sink = 0, maxCues = 0;
  const runBatch = enabled => {
    const start = performance.now();
    for (let repeat = 0; repeat < repetitions; repeat++) {
      for (const text of corpus) {
        // Both branches visit identical strings and consume a result. The off
        // branch measures the loop floor; it is not an audio playback benchmark.
        if (enabled) {
          const result = selectSubtitleCues(text, profile);
          if (!Array.isArray(result.cues)) throw new Error('Rule result has no cues array');
          maxCues = Math.max(maxCues, result.cues.length);
          sink += result.cues.length;
        } else {
          sink += text.length ? 0 : 1;
        }
      }
    }
    return (performance.now() - start) / callsPerBatch;
  };
  for (let pair = 0; pair < 90; pair++) {
    let offCost, onCost;
    if (pair % 2 === 0) { offCost = runBatch(false); onCost = runBatch(true); }
    else { onCost = runBatch(true); offCost = runBatch(false); }
    if (pair >= 10) { off.push(offCost); on.push(onCost); pairedDelta.push(onCost - offCost); }
  }
  if (maxCues > 2) throw new Error(`Rules returned more than two cues: ${maxCues}`);
  return {
    scope: 'Node synchronous pure rules; alternating paired off/on loop; batch-average milliseconds per sentence. Excludes Worker, PCM, AudioContext, rendering and cloud. Does not prove zero overhead.',
    corpusSentences: corpus.length, maxInputChars: Math.max(...corpus.map(text => text.length)),
    warmupPairs: 10, measuredPairs: on.length, callsPerBatch,
    measuredRuleCalls: on.length * callsPerBatch,
    offMsPerCall: statistics(off), onMsPerCall: statistics(on), pairedDeltaMsPerCall: statistics(pairedDelta),
    maxCuesObserved: maxCues, sink,
  };
}

let rulesPerformance = null, performanceError = null;
try { rulesPerformance = await benchmarkRules(); }
catch (error) { performanceError = error.stack || String(error); }

const after = manifest();
const beforeByPath = new Map(before.map(file => [file.path, file.sha256]));
const afterByPath = new Map(after.map(file => [file.path, file.sha256]));
const sourceChangedDuringTest = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
  .filter(path => beforeByPath.get(path) !== afterByPath.get(path));
const passedTests = Number(/^# pass (\d+)$/m.exec(testRun.stdout ?? '')?.[1] ?? 0);
const failedTests = Number(/^# fail (\d+)$/m.exec(testRun.stdout ?? '')?.[1] ?? -1);
const skippedTests = Number(/^# skipped (\d+)$/m.exec(testRun.stdout ?? '')?.[1] ?? 0);
const result = {
  version: 1,
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, architecture: process.arch },
  tests: {
    exitCode: testRun.status, signal: testRun.signal, error: testRun.error?.message ?? null,
    passed: passedTests, failed: failedTests, skipped: skippedTests,
    files: testFiles.map(path => relative(root, path).replaceAll('\\', '/')),
    missingExistingTests, missingSubtitleTests,
  },
  rulesPerformance,
  performanceError,
  sourceChangedDuringTest,
  sourceManifest: before,
  sourceManifestAfter: after,
  evidence: {
    liveProviderCalled: false, realCredentialsLoaded: false, browserWorkerVerified: false,
    browserPlaybackVerified: false, physicalPlaybackVerified: false,
    avatarRenderingVerified: false, jointIntegrationVerified: false,
  },
  passed: testRun.status === 0 && failedTests === 0 && passedTests >= 56
    && missingExistingTests.length === 0 && missingSubtitleTests.length === 0
    && performanceError === null && sourceChangedDuringTest.length === 0,
};
writeFileSync(join(outputDirectory, 'verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ outputDirectory, ...result,
  sourceManifest: `${before.length} files`, sourceManifestAfter: `${after.length} files`,
}, null, 2));
if (!result.passed) process.exitCode = 1;
