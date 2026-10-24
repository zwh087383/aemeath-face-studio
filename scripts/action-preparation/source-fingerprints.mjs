import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Follow the actual local module imports used by a measurement. Third-party
// packages are represented by their installed package descriptor and imported
// entry bytes; not by copying their contents into the public catalog.
export function fingerprintDependencies(seedPaths, root) {
  root = path.resolve(root);
  const pending = seedPaths.map(file => path.resolve(root, file)), visited = new Map();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Fingerprint dependency leaves repository');
    const bytes = readFileSync(file);
    visited.set(file, { path: relative.replaceAll('\\', '/'), sha256: sha(bytes) });
    if (!/\.[mc]?js$/i.test(file)) continue;
    const text = bytes.toString('utf8');
    const patterns = [
      /\b(?:import|export)\s+(?:[^'";]*?\bfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/g,
      /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) pending.push(path.resolve(path.dirname(file), match[1]));
  }
  return [...visited.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function verifyFingerprints(entries, root) {
  for (const source of entries) {
    const file = path.resolve(root, source.path), relative = path.relative(path.resolve(root), file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Fingerprint source leaves repository');
    if (sha(readFileSync(file)) !== source.sha256) throw Error(`Measurement dependency changed: ${source.path}`);
  }
  return true;
}
