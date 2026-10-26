import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MMDLoader, MMDAnimationHelper } from '@takahirox/three-mmd';
import { MotionController } from '../../preview/core/motion-controller.js';
import { FullBodyController } from '../../preview/core/full-body-controller.js';
import { FaceController } from '../../preview/core/controller.js';
import { C, AEMEATH_BINDINGS } from '../../preview/core/profile.js';
import { MotionRig, skeletonFromMesh } from '../../preview/studio/motion-rig.js';
import { NativeClothBinding } from '../../preview/core/native-cloth-binding.js';
import { NativeBehaviorAdapter, buildNativeBehaviorPlan } from '../../preview/core/native-behavior-adapter.js';
import { NativeBehaviorPlayer, NativePoseBridge, captureNativePose, applyNativePose,
  cloneNativePose, nativePoseVelocity } from '../../preview/core/native-behavior.js';
import { PARTITIONED_DESK } from '../../preview/core/activity-desk-layout.js';
import { assertMotionAllowed } from '../../preview/core/character-motion-policy.js';
import { createActivityProps } from '../activities/props.mjs';
import { CharacterBodyDirector, withAuthoredSkeleton, syncIdleMotionClock } from './body-director.mjs';
import { NATIVE_GROUPS } from './catalog.mjs';

const clone = value => structuredClone(value);
const json = async url => { const response = await fetch(url); if (!response.ok) throw Error(`${response.status} ${url}`); return response.json(); };
const occupied = props => Object.values(props).some(value => value?.visible && ['left', 'right', 'both'].includes(value.attachment));
const ZERO_HEAD = Object.freeze({ pitch: 0, yaw: 0, roll: 0 });

/** One PMX, one body owner and one final morph writer. Existing trajectories are
 * reused. Native/activity/gesture clocks and source identities remain separate
 * from voice: activity-owned actions never fabricate a response id. */
export async function createScene(stage, progress = () => {}, options = {}) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#e4e9df');
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 220);
  const renderer = new WebGPURenderer({ antialias: true, forceWebGL: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 1.5)); await renderer.init();
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NeutralToneMapping;
  stage.prepend(renderer.domElement); scene.add(new THREE.AmbientLight(0xffffff, 1.35));
  for (const [position, intensity] of [[[12, 25, 22], 1.8], [[-15, 18, -8], .7]]) {
    const light = new THREE.DirectionalLight(0xfff5e6, intensity); light.position.set(...position); scene.add(light);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), new THREE.MeshStandardMaterial({ color: '#d5ddce', roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -.05; scene.add(floor);
  const manager = new THREE.LoadingManager(); manager.onProgress = (_, n, total) => progress(`角色与贴图 ${n}/${total}`);
  const mesh = await new MMDLoader(manager).loadAsync('/model/' + encodeURIComponent('鸣潮_爱弥斯1.05.pmx'));
  for (const [index, name] of AEMEATH_BINDINGS) if (mesh.geometry.morphTargets[index]?.name !== name) throw Error(`Morph binding: ${name}`);
  const skeleton = skeletonFromMesh(mesh), motion = new MotionController({ skeleton }), body = new FullBodyController({ skeleton });
  motion.setOptions({ natural: true, continuity: true, intensity: 1, speed: 1 });
  const actionController = new FaceController(); actionController.headSway = false; actionController.setPreset('neutral', 0);
  const rig = new MotionRig(mesh), helper = new MMDAnimationHelper();
  const avatarRoot = new THREE.Group(); avatarRoot.add(mesh); scene.add(avatarRoot); mesh.frustumCulled = false;
  const props = createActivityProps(scene), byName = new Map(mesh.skeleton.bones.map(bone => [bone.name, bone]));
  const names = { head: '頭', neck: '首', pelvis: '腰', chest: '上半身2', spine: '上半身',
    leftWrist: '左手首', rightWrist: '右手首', leftMiddle: '左中指１', rightMiddle: '右中指１',
    leftElbow: '左ひじ', rightElbow: '右ひじ', leftAnkle: '左足首', rightAnkle: '右足首' };
  let source = null, nativeAdapter = null, nativePlayer = null, nativeError = null;
  const plans = new Map();
  try {
    progress('预载两组原生动作与配套衣发…');
    const [manifest, queue, gltf] = await Promise.all([json('/native-resources-data/manifest.json'),
      json('/native-behavior-data/queue.json'), new GLTFLoader().loadAsync('/native-resources-data/source.glb')]);
    source = gltf.scene; source.visible = false; scene.add(source);
    const cloth = new NativeClothBinding(source, mesh);
    nativeAdapter = new NativeBehaviorAdapter({ mesh, source, cloth, manifest });
    for (const [id, definition] of Object.entries(NATIVE_GROUPS)) {
      const group = queue.groups.find(group => group.id === definition.groupId);
      if (!group || group.sourceFamily !== definition.sourceFamily) throw Error('Native source mismatch: ' + id);
      const plan = buildNativeBehaviorPlan(assertMotionAllowed(group), manifest);
      if (JSON.stringify(plan.map(row => row.id)) !== JSON.stringify(definition.phases)) throw Error('Unapproved native route: ' + id);
      plan.forEach(assertMotionAllowed); plans.set(id, plan);
    }
    await nativeAdapter.load([...plans.values()].flat().map(row => row.id),
      id => json('/native-resources-data/clips/' + encodeURIComponent(id) + '.json'));
    nativeAdapter.resetBind();
  } catch (error) { nativeError = error.message; plans.clear(); progress('原生资源暂不可用，其他表现保留：' + nativeError); }

  // NativeClothBinding adds skinning-only palette entries. The MMD grant and
  // bone-morph solver must see exactly its original PMX metadata-sized bones.
  withAuthoredSkeleton(mesh, () => helper.add(mesh, { physics: false })); helper.enable('ik', false);
  const rest = mesh.skeleton.bones.map(bone => ({ bone, p: bone.position.clone(), q: bone.quaternion.clone(), s: bone.scale.clone() }));
  const nodes = [avatarRoot, ...(nativeAdapter?.nodes ?? [mesh, ...mesh.skeleton.bones])];
  const restoreRest = () => {
    mesh.position.set(0, 0, 0); mesh.quaternion.identity(); mesh.scale.set(1, 1, 1);
    for (const row of rest) { row.bone.position.copy(row.p); row.bone.quaternion.copy(row.q); row.bone.scale.copy(row.s); }
  };
  const zeroVelocity = pose => pose.map(() => ({ p: new THREE.Vector3(), q: new THREE.Vector3(), s: new THREE.Vector3() }));
  let now = 0, frames = 0, disposed = false, view = 'angle', rendered = null, bridge = null;
  let lastPose = captureNativePose(nodes), velocity = zeroVelocity(lastPose), lastDt = 0;
  let lastNativeAction = null, activeRow = null, actor = null, simInitialized = false;
  let actionWeights = actionController.weights, conversationFrame = { position: [0, 0, 0], yaw: 0 };
  let currentExecutor = 'conversation';

  const boneData = () => {
    mesh.updateMatrixWorld(true); const bones = {}, rotations = {};
    for (const [key, name] of Object.entries(names)) {
      const bone = byName.get(name); if (!bone) continue;
      bones[key] = bone.getWorldPosition(new THREE.Vector3()).toArray();
      rotations[key] = bone.getWorldQuaternion(new THREE.Quaternion()).toArray();
    }
    return { bones, rotations };
  };
  const sceneProps = () => Object.fromEntries(Object.entries(props.snapshot().props ?? {}).map(([id, row]) => [id, {
    ...row, worldTransform: { position: row.position, quaternion: row.quaternion } }]));
  const worldRoot = () => {
    const position = mesh.getWorldPosition(new THREE.Vector3()), q = mesh.getWorldQuaternion(new THREE.Quaternion());
    const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    return { position: position.toArray(), yaw: Math.atan2(direction.x, direction.z) };
  };
  function physicalState() {
    const data = boneData(), objects = sceneProps(), state = body.snapshot(), isActivity = currentExecutor === 'activity';
    const root = isActivity ? clone(body.root) : worldRoot();
    const contacts = isActivity ? clone(state.contacts) : Object.fromEntries(['L', 'R'].map(side => {
      const foot = data.bones[side === 'L' ? 'leftAnkle' : 'rightAnkle'];
      const restHeight = skeleton.get(side === 'L' ? '左足首' : '右足首')?.position[1];
      return [side, !!foot && Math.abs(foot[1] - (root.position[1] + restHeight)) < .7];
    }));
    const support = isActivity ? state.support : contacts.L || contacts.R ? 'standing' : 'unknown';
    return { posture: support, support, contacts, hands: occupied(objects) ? 'occupied' : 'free', props: objects,
      root, seatSupported: isActivity && support === 'seated' && objects.chair?.visible === true,
      phase: isActivity ? state.phase : currentExecutor === 'native' ? nativePlayer?.snapshot().phase : 'conversation',
      executor: currentExecutor, canYield: !bridge && adapters[currentExecutor].canYield(),
      supportEvidence: isActivity ? 'activity-contact-and-rendered-props' : 'standing-only-source-and-measured-ankle-envelope',
      bones: data.bones, rotations: data.rotations };
  }
  function beginHandoff(executor, row) {
    const current = captureNativePose(nodes);
    bridge = currentExecutor === executor ? null : { current, velocity: velocity.map(v => ({ p: v.p.clone(), q: v.q.clone(), s: v.s.clone() })),
      incoming: null, start: now, duration: .45, controller: null };
    currentExecutor = executor; activeRow = row; row.sceneStart = now; row.visibleStarted = false;
  }
  function adoptStandingIntoActivity(state) {
    if (currentExecutor === 'activity') return;
    const feet = Object.fromEntries(['L', 'R'].map(side => {
      const key = side === 'L' ? 'leftAnkle' : 'rightAnkle';
      return [side, { position: clone(state.bones[key]), rotation: clone(state.rotations[key]), contact: state.contacts[side] === true }];
    }));
    body.root = clone(state.root); body.anchor = clone(state.root); body.pose = body.standing(body.root, feet);
    // The incoming activity's foot constraints start from measured world contacts.
    // A rendered inertial bridge carries the exact outgoing upper-body pose.
    body.pose.props = clone(body.sceneProps); body.status = 'idle'; body.activeId = null; body.done = true;
    body.bridge = null; body.stopMode = null; body.queued = null; body.afterPrerequisite = null;
    body.solve();
  }
  const noMotion = () => !motion.pending.length && !motion.gestures.length && !motion.continuity.handoff
    && !motion.continuity.queuedHandoff && !motion.continuity.primitive;
  const headPending = () => actionController.cues.some(cue => cue.action !== 'blink');
  const adapters = {
    conversation: {
      canYield: () => !bridge && noMotion() && !headPending(),
      start(def, row, state) {
        if (def.kind === 'gesture' ? !motion.profile.gestures[def.name] : def.kind !== 'action') return false;
        if (currentExecutor !== 'conversation') syncIdleMotionClock(motion, now,
          { face: actionController.head ?? ZERO_HEAD, actions: [], speech: 0, paused: false });
        const cue = { id: row.id, kind: def.kind, clock: 'wall', at: now, duration: def.duration,
          [def.kind]: def.name, strength: .65 };
        if (!(def.kind === 'gesture' ? motion.enqueue(cue) : actionController.enqueue(cue))) return false;
        conversationFrame = clone(state.root); beginHandoff('conversation', row); return true;
      },
      status: row => ({ started: !!row.visibleStarted, done: now > row.sceneStart &&
        !motion.pending.some(cue => cue.id === row.id) && !motion.gestures.some(cue => cue.id === row.id)
        && !actionController.cues.some(cue => cue.id === row.id) && !bridge && noMotion() }),
      cancel(row) { motion.retract(now); actionController.cues = actionController.cues.filter(cue => cue.id !== row.id); },
    },
    native: {
      canYield: () => !bridge && (!nativePlayer || ['complete-held', 'cancelled-held'].includes(nativePlayer.state)),
      check: def => plans.has(def.id) ? null : 'native_resources_unavailable',
      start(def, row) {
        const plan = plans.get(def.id); if (!plan || !nativeAdapter) return false;
        plan.forEach(assertMotionAllowed);
        const initialPose = captureNativePose(nativeAdapter.nodes), initialVelocity = nativeAdapter.nodes.map(node => {
          const index = nodes.indexOf(node); return velocity[index] ?? zeroVelocity([{}])[0];
        });
        const player = new NativeBehaviorPlayer({ plan, sample: (id, time) => nativeAdapter.sample(id, time),
          initialPose, initialVelocity, repeat: 1, align: (a, b) => nativeAdapter.alignment(a, b),
          stopOptions: nativeAdapter.stopOptions(), bridgeSeconds: .45 });
        // NativeBehaviorPlayer already inherits exact pose and velocity. Avoid a
        // second bridge on top of its own source/target transformation.
        beginHandoff('native', row); bridge = null; nativePlayer = player; lastNativeAction = def.id; return true;
      },
      status: row => ({ started: !!row.visibleStarted, done: !bridge && nativePlayer
        && ['complete-held', 'cancelled-held'].includes(nativePlayer.state) }),
      cancel() { if (nativePlayer && !nativePlayer.cancelled) nativePlayer.cancel({ useEnd: lastNativeAction === 'native:thinking01' }); },
    },
    activity: {
      canYield: () => !bridge && body.done && !body.bridge && !body.stopMode && !body.queued,
      start(def, row, state) {
        if (state.hands !== 'free' && currentExecutor !== 'activity') return false;
        adoptStandingIntoActivity(state);
        const accepted = body.play(def.name, { speed: 1, loop: false,
          context: { deskLayout: 'partitioned', ...(def.name === 'stand_up_from_desk' ? { deskRetreat: 5.5 } : {}) } });
        if (!accepted) return false;
        beginHandoff('activity', row); return true;
      },
      status: row => {
        const failed = now - row.sceneStart > 60;
        if (failed && !row.timeoutStopped) { row.timeoutStopped = true; body.stop(); }
        return { started: !!row.visibleStarted, done: failed || (!bridge && body.done && !body.bridge),
          failed, reason: failed ? 'activity_execution_timeout' : null };
      },
      cancel() { body.stop(); },
    },
    face: {
      start(def, row) { row.sceneStart = now; return actionController.enqueue({ id: row.id, kind: 'action',
        action: def.name, clock: 'wall', at: now, duration: def.duration, strength: 1 }); },
      status: row => ({ started: actionController.executedCues.some(cue => cue.id === row.id),
        done: now > row.sceneStart && !actionController.cues.some(cue => cue.id === row.id) }),
      cancel(row) { actionController.cues = actionController.cues.filter(cue => cue.id !== row.id); },
    },
  };
  const bodyDirector = new CharacterBodyDirector({ executors: adapters, getActorState: () => actor ?? physicalState(),
    isOwnerCurrent: options.isOwnerCurrent ?? (() => true), onEvent: options.onEvent ?? (() => {}) });
  function applyExecutor(dt) {
    actionWeights = actionController.update(now, dt, null, false, { mouthMode: 'expression' });
    if (currentExecutor === 'native' && nativePlayer) {
      nativeAdapter.cloth?.setEnabled(true); nativePlayer.advance(dt); nativeAdapter.apply(nativePlayer.pose());
    }
    else {
      // Native palette matrices are driven by a different skeleton. Outside a
      // native clip restore the original PMX skinning, rather than leaving an
      // old native skirt fixed in space during sitting or gesturing.
      nativeAdapter?.cloth?.setEnabled(false);
      restoreRest();
      if (currentExecutor === 'activity') {
        body.update(now, dt); rig.apply(body.locals); avatarRoot.position.set(...body.root.position); avatarRoot.rotation.y = body.root.yaw;
      } else {
        motion.update(now, dt, { face: actionController.head ?? ZERO_HEAD, actions: actionController.activeActions, speech: 0, paused: false });
        rig.apply(motion.locals); avatarRoot.position.set(...conversationFrame.position); avatarRoot.rotation.y = conversationFrame.yaw;
      }
      withAuthoredSkeleton(mesh, () => helper.update(dt)); avatarRoot.updateMatrixWorld(true);
    }
    const incoming = captureNativePose(nodes);
    if (bridge) {
      if (!bridge.incoming) { bridge.incoming = cloneNativePose(incoming); bridge.start = now; applyNativePose(nodes, bridge.current); }
      else {
        const elapsed = Math.max(0, now - bridge.start);
        if (!bridge.controller && elapsed > 0) bridge.controller = new NativePoseBridge({ current: bridge.current,
          velocity: bridge.velocity, incoming: bridge.incoming, incomingFuture: incoming,
          derivativeStep: elapsed, duration: bridge.duration });
        if (bridge.controller) applyNativePose(nodes, bridge.controller.apply(incoming, elapsed));
        if (elapsed >= bridge.duration) bridge = null;
      }
    }
    avatarRoot.updateMatrixWorld(true); mesh.skeleton.update();
    const actual = captureNativePose(nodes);
    if (dt > 0) velocity = nativePoseVelocity(lastPose, actual, dt);
    if (activeRow && now > activeRow.sceneStart && actual.some((pose, index) =>
      pose.p.distanceTo(lastPose[index].p) > 1e-6 || pose.q.angleTo(lastPose[index].q) > 1e-6)) activeRow.visibleStarted = true;
    lastPose = actual; lastDt = dt;
  }
  const resize = () => { renderer.setSize(Math.max(1, stage.clientWidth), Math.max(1, stage.clientHeight));
    camera.aspect = Math.max(1, stage.clientWidth) / Math.max(1, stage.clientHeight); camera.updateProjectionMatrix(); };
  const cameraView = () => {
    const head = byName.get('頭').getWorldPosition(new THREE.Vector3()), hip = byName.get('腰').getWorldPosition(new THREE.Vector3());
    const focus = view === 'face' ? head : hip.clone().lerp(head, .4); if (view !== 'face') focus.y -= 3.2;
    const yaw = view === 'front' || view === 'face' || view === 'body' ? 0 : view === 'side' ? Math.PI / 2 : .55;
    const distance = (view === 'face' ? 9 : view === 'body' ? 25 : 37) * Math.max(1, .85 / camera.aspect);
    camera.position.set(focus.x + Math.sin(yaw) * distance, focus.y + (view === 'face' ? 0 : 2), focus.z + Math.cos(yaw) * distance); camera.lookAt(focus);
  };
  resize(); const observer = new ResizeObserver(resize); observer.observe(stage);
  restoreRest(); motion.update(0, 0, { face: ZERO_HEAD, actions: [] }); rig.apply(motion.locals); avatarRoot.updateMatrixWorld(true);
  const initialProps = options.sceneProps ?? { chair: true, table: true, book: clone(PARTITIONED_DESK.setupProps.book) };
  props.update(initialProps, { ...boneData(), root: body.root, anchor: body.anchor, pose: body.pose, time: 0 });
  body.setRenderedPropsSnapshot(props.snapshot()); actor = physicalState(); lastPose = captureNativePose(nodes);
  cameraView(); progress('编译统一人物场景…'); await renderer.compileAsync(scene, camera);
  const gl = renderer.backend.gl, debug = gl.getExtension('WEBGL_debug_renderer_info');
  const environment = { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown',
    userAgent: navigator.userAgent, physics: false, pmxLoads: 1, nativeReady: plans.size === 2, nativeError };
  const api = {
    bodyDirector, motion, actionController, body, mesh, props, environment,
    setView(next) { if (['front', 'angle', 'side', 'face', 'body', 'full'].includes(next)) { view = next; cameraView(); } },
    setExpressionEnabled() {},
    actionLayer() { return { blink: actionWeights[C.blink] ?? 0, head: clone(actionController.head),
      activeActions: [...actionController.activeActions], executedCues: clone(actionController.executedCues) }; },
    step(time, dt, { faceWeights = null, paused = false, audioTime = null, audioStatus = 'idle', mediaOwner = null,
      segmentEnded = false, render = true } = {}) {
      if (disposed) throw Error('scene_disposed');
      if (!Number.isFinite(time) || !Number.isFinite(dt) || dt < 0) throw Error('invalid_scene_clock');
      if (!simInitialized) { now = time; simInitialized = true; }
      const delta = paused ? 0 : Math.min(.1, dt); now += delta;
      const start = performance.now();
      bodyDirector.update(now, delta, { paused, audioTime, audioStatus, mediaOwner, segmentEnded });
      mesh.morphTargetInfluences.fill(0);
      if (faceWeights) for (let i = 0; i < mesh.morphTargetInfluences.length; i++) {
        const value = faceWeights[i] ?? 0; if (!Number.isFinite(value)) throw Error('nonfinite_face_weight'); mesh.morphTargetInfluences[i] = value;
      }
      if (!paused) applyExecutor(delta);
      const data = boneData(), state = body.snapshot(), visibleProps = currentExecutor === 'activity' ? { ...body.sceneProps, ...body.pose.props } : body.sceneProps;
      props.update(visibleProps, { ...data, root: currentExecutor === 'activity' ? body.root : actor.root,
        anchor: body.pose?.anchor ?? body.anchor, pose: currentExecutor === 'activity' ? body.pose : {}, snapshot: state, time: now });
      body.setRenderedPropsSnapshot(props.snapshot()); if (currentExecutor === 'activity') body.setPropTransferReceipts(props.snapshot());
      actor = physicalState(); cameraView(); mesh.skeleton.update(); const driven = performance.now();
      if (render) renderer.render(scene, camera);
      const finite = [...Object.values(data.bones).flat(), ...Object.values(data.rotations).flat(), ...mesh.morphTargetInfluences].every(Number.isFinite);
      if (!finite || rig.missing.size) throw Error('Invalid unified character pose: ' + [...rig.missing].join(','));
      rendered = { frame: ++frames, now, finite, renderSubmitted: render, executor: currentExecutor, actorState: clone(actor),
        body: bodyDirector.snapshot(), native: nativePlayer?.snapshot() ?? null, activity: currentExecutor === 'activity' ? state : null,
        bones: data.bones, rotations: data.rotations, weights: Array.from(mesh.morphTargetInfluences), props: props.snapshot(),
        actionLayer: api.actionLayer(), handoff: bridge ? { elapsed: now - bridge.start, duration: bridge.duration } : null,
        driverMs: driven - start, renderMs: render ? performance.now() - driven : 0, sourceSpeed: 1, bodyAmplitude: 1, view };
      return rendered;
    },
    snapshot() { return rendered ?? { ready: true, environment, actorState: clone(actor), body: bodyDirector.snapshot() }; },
    dispose() { if (disposed) return; disposed = true; observer.disconnect(); props.dispose(); renderer.dispose(); renderer.domElement.remove(); },
  };
  return api;
}

export { createScene as createCharacterScene };
