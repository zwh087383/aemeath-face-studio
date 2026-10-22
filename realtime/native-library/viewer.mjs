import * as THREE from 'three';
import {WebGPURenderer} from 'three/webgpu';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MMDLoader} from '@takahirox/three-mmd';
import {NativeClip, NativeRetarget} from '/preview/core/native-motion.js';

const $ = id => document.getElementById(id);
const status = $('status');
const started = performance.now();
const stages = [];
const cache = new Map();
let clips = [], filtered = [], category = '', query = '';
let source, mesh, sourceRest, targetRest, current = null;
let ready = false, modelsReady = false, loading = false, playing = true;
let pendingId = null, requestSequence = 0, controller, lastLoadError = null;
let time = 0, speed = 1, view = 'front', last = performance.now();
let frame = 0, lastStepMs = 0, environment = null;

function message(text, kind = '') {
  status.textContent = text;
  status.className = kind;
}

function capturePose(root) {
  const rows = [];
  root.traverse(node => {
    if (node.isBone) rows.push({node, p:node.position.clone(), q:node.quaternion.clone(), s:node.scale.clone()});
  });
  return rows;
}

function restorePose(rows, root) {
  for (const {node, p, q, s} of rows) {
    node.position.copy(p);node.quaternion.copy(q);node.scale.copy(s);
  }
  root.updateMatrixWorld(true);
  root.traverse(node => { if (node.isSkinnedMesh) node.skeleton.update(); });
}

async function stage(id) {
  const host = $(id), scene = new THREE.Scene();
  scene.background = new THREE.Color('#e6e8e0');
  const camera = new THREE.PerspectiveCamera(35, 1, .1, 150);
  const renderer = new WebGPURenderer({antialias:true, forceWebGL:true, preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.4));
  await renderer.init();
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  host.append(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff, 1.35));
  for (const [color, intensity, position] of [[0xfff5e5, 2, [-12,28,20]], [0xc7e0fa, 1, [15,15,-8]]]) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(...position);scene.add(light);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({color:'#d8dfd0', roughness:1}));
  floor.rotation.x = -Math.PI / 2;floor.position.y = -.05;scene.add(floor);
  const grid = new THREE.GridHelper(400, 200, '#a7b3a3', '#c5cebd');
  grid.position.y = -.02;scene.add(grid);
  const row = {id, scene, camera, renderer, focus:new THREE.Vector3(0, 9, 0)};
  stages.push(row);
  new ResizeObserver(() => {
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height);camera.aspect = width / height;camera.updateProjectionMatrix();
    cameraView();
    // A paused frame must survive a renderer resize, which clears its canvas.
    if (ready) render();
  }).observe(host);
  return row;
}

function cameraView() {
  const yaw = {front:0, angle:.65, side:Math.PI / 2, back:Math.PI}[view];
  for (const row of stages) {
    const {camera, focus} = row;
    focus.set(0, 9, 0);
    if (current && $('follow').checked) {
      const {clip, retarget} = current;
      const pelvis = clip.world[retarget.pelvis], restPelvis = clip.restWorld[retarget.pelvis];
      const headIndex = clip.indices.get('Bip001Head');
      let heightDelta;
      if (row.id === 'source-stage') {
        focus.x = (pelvis.p.x - restPelvis.p.x) * retarget.scale;
        focus.z = (pelvis.p.z - restPelvis.p.z) * retarget.scale;
        heightDelta = ((pelvis.p.y + clip.world[headIndex].p.y) -
          (restPelvis.p.y + clip.restWorld[headIndex].p.y)) * retarget.scale / 2;
      } else {
        const waist = retarget.bones.get('腰').getWorldPosition(new THREE.Vector3());
        const head = retarget.bones.get('頭').getWorldPosition(new THREE.Vector3());
        const restWaist = retarget.rest.get('腰').wp, restHead = retarget.rest.get('頭').wp;
        focus.x = waist.x - restWaist.x;focus.z = waist.z - restWaist.z;
        heightDelta = ((waist.y + head.y) - (restWaist.y + restHead.y)) / 2;
      }
      // Lower the full-body framing for sitting/crouching; upward gestures do
      // not pull the camera upward. No transform is written to either model.
      focus.y += Math.max(-7, Math.min(0, heightDelta * .55));
    }
    const distance = 36 * Math.max(1, .8 / camera.aspect);
    camera.position.set(focus.x + Math.sin(yaw) * distance, focus.y + 4.2, focus.z + Math.cos(yaw) * distance);
    camera.lookAt(focus);
  }
}

function setFollow(value) {
  $('follow').checked = Boolean(value);
  cameraView();if (ready) render();
  return snapshot();
}

function setView(value) {
  if (!['front', 'angle', 'side', 'back'].includes(value)) throw Error('Unknown view');
  view = value;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === value));
  cameraView();if (ready) render();
  return snapshot();
}

function render() {
  if (!current) return;
  const start = performance.now();
  current.clip.sample(time);current.clip.applyToGLTF(source);current.retarget.apply();
  cameraView();
  for (const row of stages) row.renderer.render(row.scene, row.camera);
  lastStepMs = performance.now() - start;frame++;
  $('timeline').value = String(time);
  $('time').textContent = `${time.toFixed(2)} / ${current.clip.data.duration.toFixed(2)} s`;
}

function snapshot() {
  return {
    ready, loading, playing, time, duration:current?.clip.data.duration ?? 0,
    frame, lastStepMs, view, speed, environment, pendingId, lastLoadError,
    error:lastLoadError, selectedId:current?.descriptor.id ?? null,
    currentId:current?.descriptor.id ?? null,
    sourceName:current?.clip.data.name ?? null,
    sourceFrames:current?.clip.data.frameCount ?? null,
    sourceBones:current?.clip.data.bones.length ?? null,
    loop:Boolean(current?.descriptor.loop), sequence:$('sequence').checked, follow:$('follow').checked,
    cameras:stages.map(({id, camera, focus}) => ({id, position:camera.position.toArray(), focus:focus.toArray(), quaternion:camera.quaternion.toArray()})),
    clips:clips.map(({id, name, category:clipCategory, duration, frameCount, loop}) => ({id, name, category:clipCategory, duration, frameCount, loop})),
    filteredIds:filtered.map(clip => clip.id), cacheIds:[...cache.keys()], loadedClipIds:[...cache.keys()],
    target:current?.retarget.snapshot() ?? null,
  };
}

function pause(value = true) {
  playing = !value;
  $('play').textContent = playing ? '暂停' : '播放';
  last = performance.now();
  return snapshot();
}

function seek(value) {
  if (!current) return snapshot();
  const number = Number(value);
  if (!Number.isFinite(number)) throw Error('Invalid playback time');
  time = Math.max(0, Math.min(current.clip.data.duration, number));
  render();last = performance.now();
  return snapshot();
}

function updateControls() {
  for (const id of ['play', 'restart', 'timeline']) $(id).disabled = !ready || loading;
  $('next').disabled = !modelsReady || filtered.length < 2 || loading;
}

function renderList() {
  const normalized = query.trim().toLocaleLowerCase();
  filtered = clips.filter(clip => (!category || clip.category === category) &&
    (!normalized || [clip.name, clip.id, clip.category, clip.sourceAsset].some(value => String(value ?? '').toLocaleLowerCase().includes(normalized))));
  $('list-summary').textContent = `${filtered.length} / ${clips.length} 段 · 点击载入一段`;
  const list = $('clip-list');list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('span');empty.className = 'empty';empty.textContent = '没有匹配的动作。';list.append(empty);
  }
  for (const clip of filtered) {
    const button = document.createElement('button');button.className = 'clip-entry';button.dataset.clipId = clip.id;
    button.setAttribute('aria-pressed', String(current?.descriptor.id === clip.id));
    if (pendingId === clip.id) button.classList.add('pending');
    const title = document.createElement('span');title.className = 'clip-title';title.textContent = clip.name || clip.id;
    const meta = document.createElement('span');meta.className = 'clip-meta';
    meta.textContent = `${clip.category || '未分类'} · ${Number(clip.duration).toFixed(2)} s · ${clip.loop ? '循环' : '单次'}`;
    button.append(title, meta);button.onclick = () => void select(clip.id);list.append(button);
  }
  updateControls();
}

function renderCategories() {
  const host = $('categories');host.replaceChildren();
  for (const value of ['', ...new Set(clips.map(clip => clip.category || '未分类'))]) {
    const button = document.createElement('button');button.textContent = value || '全部';
    button.dataset.category = value || 'all';
    button.setAttribute('aria-pressed', String(value === category));
    button.onclick = () => {category = value;renderCategories();renderList();};host.append(button);
  }
}

async function loadData(id, signal) {
  if (cache.has(id)) {
    const value = cache.get(id);cache.delete(id);cache.set(id, value);return value;
  }
  const response = await fetch(`/native-library-data/clips/${encodeURIComponent(id)}.json`, {signal});
  if (!response.ok) throw Error(`片段数据读取失败（HTTP ${response.status}）`);
  const value = await response.json();
  if (signal.aborted) throw new DOMException('Superseded clip', 'AbortError');
  cache.set(id, value);
  while (cache.size > 3) cache.delete(cache.keys().next().value);
  return value;
}

async function select(id) {
  if (!modelsReady) throw Error('两套模型尚未准备好');
  const descriptor = clips.find(clip => clip.id === id);
  if (!descriptor) throw Error('Unknown clip ' + id);
  if (!loading && current?.descriptor.id === id) {
    time = 0;pause(false);render();return snapshot();
  }
  const sequence = ++requestSequence;
  controller?.abort();controller = new AbortController();
  const previousPlaying = playing;
  loading = true;pendingId = id;lastLoadError = null;renderList();
  message(`正在按需载入 ${descriptor.name || id}…`, 'loading');
  try {
    const data = await loadData(id, controller.signal);
    if (sequence !== requestSequence) return snapshot();
    const clip = new NativeClip(data);
    // NativeRetarget captures the target bind pose in its constructor. Never
    // construct it from the previously playing animation's current pose.
    restorePose(targetRest, mesh);restorePose(sourceRest, source);
    const retarget = new NativeRetarget(clip, mesh);
    if (sequence !== requestSequence) return snapshot();
    source.scale.setScalar(retarget.scale * 100);
    current = {descriptor, clip, retarget};time = 0;ready = true;
    $('timeline').max = String(data.duration);
    $('current-name').textContent = descriptor.name || data.name;
    $('current-category').textContent = descriptor.category || '未分类';
    $('clip-kind').textContent = descriptor.loop ? '循环片段' : '单次片段';
    $('clip-notes').textContent = descriptor.notes || '';
    $('diagnostics').textContent = JSON.stringify({
      id, name:descriptor.name, sourceAsset:data.sourceAsset, sourceArchive:data.sourceArchive,
      sourceSkeleton:data.sourceSkeleton, duration:data.duration, frames:data.frameCount,
      sourceBoneCount:data.bones.length, mappedBoneCount:retarget.mapping.length,
      scale:retarget.scale, loop:Boolean(descriptor.loop), ik:false, physics:false,
      comparison:'Native skeletal replay; not an in-game recording',
      loading:'One clip on demand; at most three raw JSON clips cached',
    }, null, 2);
    loading = false;pendingId = null;pause(false);renderList();render();
    message(`已加载 ${descriptor.name || data.name} · ${data.frameCount} 帧 · ${data.bones.length} 原骨骼 → ${retarget.mapping.length} 映射骨骼。两侧共用时间轴。`);
    environment.loadMs ??= performance.now() - started;
    return snapshot();
  } catch (error) {
    if (sequence !== requestSequence) return snapshot();
    loading = false;pendingId = null;lastLoadError = error.message;
    // A constructor failure can occur after restoring bind poses. Reapply the
    // retained clip so a failed selection never leaves either model frozen in T.
    if (current) {source.scale.setScalar(current.retarget.scale * 100);render();}
    pause(!previousPlaying);renderList();
    message(`载入失败：${error.message}${current ? '。保留上一段，可继续播放或选择其它动作。' : '。请选择其它片段重试。'}`, 'error');
    console.error(error);
    return snapshot();
  }
}

async function next() {
  if (!filtered.length || loading) return snapshot();
  const index = filtered.findIndex(clip => clip.id === current?.descriptor.id);
  return select(filtered[(index + 1) % filtered.length].id);
}

window.nativeLibrary = {
  snapshot, pause, seek, select, setView, setFollow, next,
  get mesh() {return mesh;}, get source() {return source;},
  get clip() {return current?.clip;}, get retarget() {return current?.retarget;},
};

$('search').oninput = () => {query = $('search').value;renderList();};
$('play').onclick = () => {
  if (!current) return;
  if (!playing && time >= current.clip.data.duration) time = 0;
  pause(playing);render();
};
$('restart').onclick = () => {time = 0;pause(false);render();};
$('timeline').oninput = () => {pause(true);seek($('timeline').value);};
$('speed').onchange = () => {speed = Number($('speed').value);last = performance.now();};
$('next').onclick = () => void next();
$('follow').onchange = () => setFollow($('follow').checked);
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => setView(button.dataset.view);

function loop(now) {
  const dt = Math.max(0, Math.min(.1, (now - last) / 1000));last = now;
  if (ready && playing && !loading) {
    const duration = current.clip.data.duration, advanced = time + dt * speed;
    if (advanced >= duration) {
      if ($('sequence').checked && filtered.length > 1) {
        time = duration;render();void next();
      } else if (current.descriptor.loop) {
        time = advanced % duration;render();
      } else {
        time = duration;pause(true);render();
      }
    } else {time = advanced;render();}
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

try {
  const response = await fetch('/native-library-data/manifest.json');
  if (!response.ok) throw Error(`动作目录未准备好（HTTP ${response.status}）`);
  const manifest = await response.json();
  if (manifest.schema !== 1 || !Array.isArray(manifest.clips)) throw Error('不支持的动作目录格式');
  clips = manifest.clips.filter(clip => clip.status === 'ready');
  if (!clips.length) throw Error('目录中还没有通过提取检查的片段');
  if (new Set(clips.map(clip => clip.id)).size !== clips.length) throw Error('动作目录存在重复 ID');
  $('library-summary').textContent = `${clips.length} 段常用动作 · 不含攻击片段 · 按需载入 · 同步比较`;
  renderCategories();renderList();
  message('动作目录已读取，正在准备两侧渲染器…', 'loading');
  const [left, right] = await Promise.all([stage('source-stage'), stage('target-stage')]);
  cameraView();message('正在读取原生网格、现有 PMX 与贴图…', 'loading');
  const [gltf, target] = await Promise.all([
    new GLTFLoader().loadAsync('/native-library-data/source.glb'),
    new MMDLoader().loadAsync('/model/' + encodeURIComponent('鸣潮_爱弥斯1.05.pmx')),
  ]);
  source = gltf.scene;mesh = target;mesh.frustumCulled = false;
  sourceRest = capturePose(source);targetRest = capturePose(mesh);
  left.scene.add(source);right.scene.add(mesh);
  source.traverse(node => {
    if (!node.isMesh) return;
    node.frustumCulled = false;
    node.material = new THREE.MeshStandardMaterial({color:'#889c8e', roughness:.72, metalness:0, side:THREE.DoubleSide});
  });
  message('模型已载入，正在准备材质与着色器…', 'loading');
  await Promise.all(stages.map(row => row.renderer.compileAsync(row.scene, row.camera)));
  const gl = right.renderer.backend.gl, debug = gl.getExtension('WEBGL_debug_renderer_info');
  environment = {renderer:debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown'};
  modelsReady = true;updateControls();
  await select(clips[0].id);
} catch (error) {
  message('页面准备失败：' + error.message, 'error');
  window.nativeLibraryError = error.message;console.error(error);
}
