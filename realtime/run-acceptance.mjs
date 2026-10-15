import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { RealtimeScheduler } from './scheduler.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const face = dirname(root);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(face, 'outputs/realtime-scheduler-20261014', runId);
mkdirSync(out, { recursive: true });
function manifest(dir = root) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...manifest(join(dir, entry.name)));
    else if (/\.(mjs|cjs|html|css|md)$/.test(entry.name)) {
      const path = join(dir, entry.name);
      files.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
const before = manifest();
const tests = readdirSync(join(root, 'tests')).filter(n => n.endsWith('.test.mjs')).map(n => join(root, 'tests', n));
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { encoding: 'utf8', cwd: root, timeout: 120000 });
writeFileSync(join(out, 'tests.tap'), run.stdout ?? '');
writeFileSync(join(out, 'tests.stderr.txt'), run.stderr ?? '');
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? null;
const frameMs = [], interruptMs = [];
let commands = 0;
for (let trial = 0; trial < 120; trial++) {
  let now = 0;
  const scheduler = new RealtimeScheduler({ clock: () => now, emit: () => { commands++; return true; } });
  const identity = { connectionId: 'local-replay', responseId: `trial-${trial}`, epoch: trial + 1 };
  scheduler.begin(identity);
  for (let i = 0; i < 3; i++) scheduler.enqueue({ ...identity, id: `gesture-${i}`, gesture: ['wave', 'explain', 'chest'][i], at: i * 3 });
  for (let i = 0; i < 8; i++) scheduler.enqueue({ ...identity, id: `face-${i}`, kind: 'expression', preset: 'smile', at: i });
  for (let frame = 0; frame < 420; frame++) {
    now = frame / 60;
    const start = performance.now();
    scheduler.playback({ ...identity, status: 'playing', time: now });
    const elapsed = performance.now() - start;
    if (trial >= 10) frameMs.push(elapsed);
  }
  const start = performance.now();
  scheduler.interrupt(identity);
  const elapsed = performance.now() - start;
  if (trial >= 10) interruptMs.push(elapsed);
  if (scheduler.snapshot().queued !== 0 || scheduler.enqueue({ ...identity, id: 'stale', gesture: 'wave' }).accepted) throw new Error('Benchmark interruption invariant failed');
}
const after = manifest();
const changed = [...new Set([...before.map(f => f.path), ...after.map(f => f.path)])]
  .filter(path => before.find(f => f.path === path)?.sha256 !== after.find(f => f.path === path)?.sha256);
const passed = Number(/^# pass (\d+)$/m.exec(run.stdout ?? '')?.[1] ?? 0);
const failed = Number(/^# fail (\d+)$/m.exec(run.stdout ?? '')?.[1] ?? -1);
const result = {
  version: 1, measuredAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`,
  tests: { exitCode: run.status, passed, failed, signal: run.signal, error: run.error?.message ?? null, files: tests.map(p => relative(root, p)) },
  performance: { scope: 'scheduler only; synchronous accepting sink; fake playback clock; no audio/renderer/cloud',
    samples: frameMs.length, commands, frameMeanMs: frameMs.reduce((a, b) => a + b, 0) / frameMs.length,
    frameP95Ms: percentile(frameMs, .95), frameMaxMs: Math.max(...frameMs), interruptSamples: interruptMs.length,
    interruptP95Ms: percentile(interruptMs, .95), interruptMaxMs: Math.max(...interruptMs) },
  sourceChangedDuringTest: changed, sourceManifest: before,
  evidence: { liveProviderCalled: false, realCredentialsLoaded: false, browserPlaybackVerified: false,
    physicalPlaybackVerified: false, avatarRenderingVerified: false, jointIntegrationVerified: false },
  passed: run.status === 0 && failed === 0 && passed > 0 && changed.length === 0,
};
writeFileSync(join(out, 'verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ out, ...result, sourceManifest: `${before.length} files` }, null, 2));
if (!result.passed) process.exitCode = 1;
