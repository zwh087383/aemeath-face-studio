import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { MMDLoader, MMDAnimationHelper } from '@takahirox/three-mmd';
import { FaceController } from '/preview/core/controller.js';
import { MotionController } from '/preview/core/motion-controller.js';
import { AEMEATH_BINDINGS, VOWELS } from '/preview/core/profile.js';
import { MotionRig, skeletonFromMesh } from '/preview/studio/motion-rig.js';

/** One composition point for the already delivered character controllers. */
export async function createScene(stage, progress = () => {}) {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-5, 5, 5, -5, .1, 150);
  const renderer = new WebGPURenderer({ antialias: true, alpha: true, forceWebGL: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  await renderer.init(); renderer.toneMapping = THREE.NeutralToneMapping; renderer.setClearColor(0, 0); stage.prepend(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff, 1.15));
  for (const [color, intensity, position] of [[0xfff2ed, 1.4, [-3, 8, 10]], [0xd3d9ff, .25, [7, 4, 5]]]) {
    const light = new THREE.DirectionalLight(color, intensity); light.position.set(...position); scene.add(light);
  }
  const manager = new THREE.LoadingManager(); manager.onProgress = (_, n, total) => progress(`人物贴图 ${n}/${total}`);
  const mesh = await new MMDLoader(manager).loadAsync('/model/' + encodeURIComponent('鸣潮_爱弥斯1.05.pmx'));
  for (const [i, name] of AEMEATH_BINDINGS) if (mesh.geometry.morphTargets[i]?.name !== name) throw new Error(`Morph binding: ${name}`);
  const face = new FaceController(); face.headSway = false;
  const motion = new MotionController({ skeleton: skeletonFromMesh(mesh) }); motion.setOptions({ natural: true, intensity: 1, speed: 1 });
  const rig = new MotionRig(mesh), helper = new MMDAnimationHelper(); helper.add(mesh, { physics: false }); helper.enable('ik', false);
  const rest = mesh.skeleton.bones.map(b => [b, b.quaternion.clone()]); mesh.frustumCulled = false; scene.add(mesh);
  let view = 'body', frameCount = 0, rendered = null;
  const resize = () => {
    const w = stage.clientWidth, h = stage.clientHeight, span = view === 'face' ? 5.1 : 12.4, y = view === 'face' ? 18.15 : 14.7, yaw = view === 'angle' ? .62 : 0;
    renderer.setSize(w, h); camera.left = -span * w / h / 2; camera.right = -camera.left; camera.top = span / 2; camera.bottom = -span / 2;
    camera.position.set(30 * Math.sin(yaw), y, 30 * Math.cos(yaw)); camera.lookAt(0, y, 0); camera.updateProjectionMatrix();
  };
  resize(); const observer = new ResizeObserver(resize); observer.observe(stage);
  progress('编译人物材质…'); await renderer.compileAsync(scene, camera);
  const gl = renderer.backend.gl, debug = gl.getExtension('WEBGL_debug_renderer_info');
  const environment = { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown', userAgent: navigator.userAgent, physics: false };
  return {
    face, motion, environment,
    setView(next) { if (['face', 'body', 'angle'].includes(next)) { view = next; resize(); } },
    step(now, dt, lip) {
      const start = performance.now(), weights = face.update(now / 1000, dt, lip, true);
      motion.update(now / 1000, dt, { face: face.head, actions: face.activeActions, speech: 0 });
      mesh.morphTargetInfluences.fill(0);
      for (let i = 0; i < AEMEATH_BINDINGS.length; i++) mesh.morphTargetInfluences[AEMEATH_BINDINGS[i][0]] = weights[i];
      for (const [b, q] of rest) b.quaternion.copy(q);
      rig.apply(motion.locals); const assigned = performance.now();
      helper.update(dt); mesh.updateMatrixWorld(true); renderer.render(scene, camera); const submitted = performance.now();
      const bones = {};
      for (const [key, name] of [['head', '頭'], ['leftWrist', '左手首'], ['rightWrist', '右手首']]) {
        const bone = mesh.skeleton.bones.find(b => b.name === name); bones[key] = bone.getWorldPosition(new THREE.Vector3()).toArray();
      }
      rendered = { frame: ++frameCount, mouthOpen: VOWELS.reduce((n, i) => n + weights[i], 0), weights: Array.from(weights), bones,
        missingBindings: [...rig.missing], finite: [...weights, ...Object.values(bones).flat()].every(Number.isFinite),
        driverMs: assigned - start, renderMs: submitted - assigned, view };
      if (!rendered.finite || rendered.missingBindings.length) throw new Error('Invalid avatar pose');
      return rendered;
    },
    snapshot() { return rendered; },
    dispose() { observer.disconnect(); renderer.dispose(); },
  };
}
