import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MMDLoader } from '@takahirox/three-mmd';
import { NativeClip, NativeRetarget } from '/preview/core/native-motion.js';
import { NativeResourceLayer } from '/preview/core/native-resource-layer.js';
import { NativeClothBinding } from '/preview/core/native-cloth-binding.js';
import { findNativeRibbonCompanion } from '/preview/core/native-companion.js';
import { PreparedFaceController } from '/preview/core/prepared-face-controller.js';

const $ = id => document.getElementById(id), apiRoot = '/native-resources-data';
let ready = false, error = null, data, mesh, source, clip, retarget, ribbon, cloth, controller;
let selected, view = 'face', paused = false, manual = false, wall = 0, lastWall = null, serial = 0, revision = 0, lastReport = 0;
const scene = new THREE.Scene(); scene.background = new THREE.Color('#e6e8e0');
const camera = new THREE.PerspectiveCamera(34, 1, .1, 200);
const renderer = new WebGPURenderer({ antialias: true, forceWebGL: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); await renderer.init();
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NeutralToneMapping;
$('stage').append(renderer.domElement); scene.add(new THREE.AmbientLight(0xffffff, 1.4));
for (const [color, intensity, p] of [[0xfff5e5, 2, [-12, 28, 20]], [0xc7e0fa, .8, [15, 15, -8]]]) {
  const light = new THREE.DirectionalLight(color, intensity); light.position.set(...p); scene.add(light);
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: '#d8dfd0', roughness: 1 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -.05; scene.add(floor);
function positionCamera() {
  const face = view === 'face', focus = face && mesh ? mesh.skeleton.bones.find(b => b.name === '頭').getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, .3, 0)) : new THREE.Vector3(0, 10, 0);
  const yaw = view === 'side' ? Math.PI / 2 : 0, distance = (face ? 8 : 36) * Math.max(1, .8 / camera.aspect);
  camera.position.set(focus.x + Math.sin(yaw) * distance, focus.y + (face ? .15 : 2.6), focus.z + Math.cos(yaw) * distance); camera.lookAt(focus);
}
new ResizeObserver(() => { const stage = $('stage'); renderer.setSize(stage.clientWidth, stage.clientHeight); camera.aspect = stage.clientWidth / stage.clientHeight; camera.updateProjectionMatrix(); positionCamera(); }).observe($('stage'));
const json = async url => { const response = await fetch(url); if (!response.ok) throw Error(`${url}: ${await response.text()}`); return response.json(); };
const capture = root => { const rows = []; root.updateMatrixWorld(true); root.traverse(node => { if (node.isBone) rows.push({ node, p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone(), wq: node.getWorldQuaternion(new THREE.Quaternion()) }); }); return rows; };
function baseWeights(id) {
  const recipe = data.recipes.find(r => r.id === `authored-expression:${id}`), weights = {};
  if (!recipe) throw Error('Unknown base expression: ' + id);
  for (const channel of recipe.mapping) for (const leaf of channel.leaves) weights[leaf.index] = (weights[leaf.index] ?? 0) + (recipe.values[channel.source] ?? 0) * leaf.ratio;
  return weights;
}
function setBase(id) { const accepted = controller.setBase(baseWeights(id), ++revision); if (accepted) $('base').value = id; return accepted; }
function choose(id) {
  const recipe = data.recipes.find(r => r.id === id); if (!recipe) return false;
  const owner = { source: 'manual-face-preview', generation: ++serial };
  if (!controller.start(id, owner)) { $('status').textContent = '这项没有可播放的顶点映射，不能把前一个表情当作它的效果。'; return false; }
  selected = { id, owner }; $('status').textContent = `${recipe.name}：出现、保持，然后退回当前底色。中途也可打断。`;
  $('note').textContent = `${recipe.sourceScope === 'other-character-abu' ? '其它角色资料，仅人工预览。' : ''}${recipe.nativeData ? '复用原生曲线；新补动态出现和退出过程。' : recipe.note}`;
  list(); return true;
}
function list() {
  const query = $('search').value.toLowerCase();
  $('recipes').replaceChildren(...data.recipes.filter(recipe => `${recipe.name} ${recipe.id}`.toLowerCase().includes(query)).map(recipe => {
    const button = document.createElement('button'); button.type = 'button'; button.disabled = !ready || !recipe.previewAvailable;
    button.setAttribute('aria-pressed', String(selected?.id === recipe.id)); const title = document.createElement('span'); title.textContent = recipe.name;
    const note = document.createElement('small'); note.textContent = `${recipe.kind === 'expression' ? '角色原生' : recipe.kind === 'authored-expression' ? '已有原创' : '默认脸资料'} · ${recipe.previewAvailable ? '可人工预览' : '缺映射，仅保留资料'}`;
    button.append(title, note); button.onclick = () => choose(recipe.id); return button;
  }));
}
function draw(at, { bodyTime = at, speaking = $('speech').checked } = {}) {
  const weights = controller.update(at, { paused, speaking, lipWeights: speaking ? { 52: .26, 53: .12 } : {} });
  wall = at;
  clip.sample(bodyTime % clip.data.duration); clip.applyToGLTF(source); retarget.apply();
  if (ribbon) { const t = bodyTime % ribbon.clip.data.duration; ribbon.native.apply(t); ribbon.target.apply(t); }
  cloth.apply({ availableSourceNames: new Set([...clip.indices.keys(), ...(ribbon?.clip.indices.keys() ?? [])]) });
  for (let i = 0; i < mesh.morphTargetInfluences.length; i++) mesh.morphTargetInfluences[i] = weights[i] ?? 0;
  mesh.updateMatrixWorld(true); mesh.skeleton.update(); positionCamera(); renderer.render(scene, camera);
  return controller.snapshot();
}
function snapshot() { return { ready, error, selected, view, paused, manual, face: controller?.snapshot(), cloth: cloth?.snapshot(), recipes: data?.summary, boundary: data?.boundary }; }
function resetForReview() {
  controller = new PreparedFaceController({ recipes: data.recipes, morphCount: data.model.morphCount, mouthIndices: data.mouthIndices });
  wall = 0; lastWall = null; revision = 0; selected = null; paused = false; setBase($('base').value); draw(0, { bodyTime: 0 });
}
function surface(id) {
  const recipe = data.recipes.find(r => r.id === id); const v = new THREE.Vector3();
  return (recipe?.probeVertices ?? []).map(index => { mesh.getVertexPosition(index, v); return [index, ...v.toArray()]; });
}
function loop(now) {
  requestAnimationFrame(loop); if (!ready || error || manual) return;
  const elapsed = lastWall === null ? 0 : Math.max(0, (now - lastWall) / 1000); lastWall = now;
  // Backgrounded review tabs pause their own laboratory clock. They never advance
  // a speech clock or claim delivery while the browser is suspended.
  if (!document.hidden && !paused) wall += Math.min(elapsed, .1);
  try { draw(wall); if (now - lastReport > 250) { $('report').textContent = JSON.stringify(snapshot(), null, 2); lastReport = now; } }
  catch (problem) { error = problem.message; $('status').textContent = `预览中止：${error}`; }
}
$('search').oninput = list;
$('base').onchange = () => setBase($('base').value);
$('replay').onclick = () => selected && choose(selected.id);
$('cancel').onclick = () => { if (selected && controller.cancel(selected.owner)) $('status').textContent = '旧表情已撤销，保留当前变化速度，逐步退回最新底色。'; };
$('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? '继续' : '暂停'; };
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => { view = button.dataset.view; positionCamera(); };
window.facePreparation = { snapshot, choose, setBase, surface, get mesh() { return mesh; }, get data() { return data; },
  cancel: () => selected ? controller.cancel(selected.owner) : false,
  setView(id) { if (['face', 'front', 'side'].includes(id)) view = id; },
  setManualClock(value) { manual = Boolean(value); lastWall = null; }, drawAt: draw, resetForReview };
try {
  [data] = await Promise.all([json('/face-preparation-data/playback.json')]);
  const manifest = await json(apiRoot + '/manifest.json'), descriptor = manifest.clips.find(c => c.resourceKind === 'body' && /\/Stand2\.uasset$/.test(c.sourceAsset));
  const companion = findNativeRibbonCompanion(descriptor, manifest.clips);
  const manager = new THREE.LoadingManager(); manager.onProgress = (_, loaded, total) => $('status').textContent = `人物与贴图 ${loaded}/${total}`;
  const [gltf, target, bodyData, ribbonData] = await Promise.all([new GLTFLoader(manager).loadAsync(apiRoot + '/source.glb'),
    new MMDLoader(manager).loadAsync('/model/' + encodeURIComponent('鸣潮_爱弥斯1.05.pmx')), json(`${apiRoot}/clips/${descriptor.id}.json`), companion ? json(`${apiRoot}/clips/${companion.id}.json`) : null]);
  source = gltf.scene; mesh = target; mesh.frustumCulled = false; scene.add(mesh);
  if (mesh.morphTargetInfluences.length !== data.model.morphCount) throw Error('Actual PMX morph count changed');
  const sourceRest = capture(source), targetRest = capture(mesh); cloth = new NativeClothBinding(source, mesh);
  clip = new NativeClip(bodyData); retarget = new NativeRetarget(clip, mesh); source.scale.setScalar(retarget.scale * 100);
  if (ribbonData) { const rc = new NativeClip(ribbonData); ribbon = { clip: rc, native: new NativeResourceLayer(rc, source, { kind: 'ribbon', native: true, bindPose: sourceRest, composition: 'replace' }), target: new NativeResourceLayer(rc, mesh, { kind: 'ribbon', bindPose: targetRest, composition: 'replace' }) }; }
  resetForReview(); await renderer.compileAsync(scene, camera); ready = true;
  for (const id of ['replay', 'cancel', 'pause']) $(id).disabled = false;
  list(); choose(data.recipes.find(recipe => /expression-aimisi-smile-/.test(recipe.id))?.id ?? 'authored-expression:smile'); requestAnimationFrame(loop);
} catch (problem) { error = problem.message; $('status').textContent = `加载失败：${error}`; console.error(problem); }
