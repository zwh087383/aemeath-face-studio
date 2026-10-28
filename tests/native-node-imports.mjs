// The browser resolves this package through the preview import map. Offline
// target tests use the very same dependency without installing a second copy.
export function resolve(specifier,context,nextResolve) {
  if(specifier==='three')return nextResolve(new URL('../preview/node_modules/three/build/three.module.js',import.meta.url).href,context);
  return nextResolve(specifier,context);
}
