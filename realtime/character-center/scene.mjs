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
import { pulledOutDeskEntryFixture } from '../../preview/core/activity-seat-access.js';
import { assertMotionAllowed } from '../../preview/core/character-motion-policy.js';
import { createActivityProps } from '../activities/props.mjs';
import { CharacterBodyDirector, withAuthoredSkeleton, syncIdleMotionClock } from './body-director.mjs';
import { NATIVE_GROUPS, resolveNativePerformance } from './catalog.mjs';
import { createNativeSceneDriver } from './native-scene-driver.mjs';
import { SupportedConversationOverlay, captureSupportedPoseFromMeasured } from '../../preview/core/supported-conversation.js';
import { solveFullBodyPose } from '../../preview/core/full-body-ik.js';
import { BehaviorResourceCache } from './resource-cache.mjs';
import { readVerifiedNativeJSON } from './native-source-verification.mjs';

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
  const skeleton = skeletonFromMesh(mesh), body = new FullBodyController({ skeleton });
  let motion = new MotionController({ skeleton });
  motion.setOptions({ natural: true, continuity: true, intensity: 1, speed: 1 });
  const actionController = new FaceController(); actionController.headSway = false; actionController.setPreset('neutral', 0);
  const rig = new MotionRig(mesh), helper = new MMDAnimationHelper();
  const avatarRoot = new THREE.Group(); avatarRoot.add(mesh); scene.add(avatarRoot); mesh.frustumCulled = false;
  const props = createActivityProps(scene), byName = new Map(mesh.skeleton.bones.map(bone => [bone.name, bone]));
  const names = { head: '頭', neck: '首', pelvis: '腰', chest: '上半身2', upperChest: '上半身1', lowerBody: '下半身', spine: '上半身',
    leftWrist: '左手首', rightWrist: '右手首', leftMiddle: '左中指１', rightMiddle: '右中指１',
    leftShoulder: '左腕', rightShoulder: '右腕', leftElbow: '左ひじ', rightElbow: '右ひじ', leftAnkle: '左足首', rightAnkle: '右足首' };
  let source = null, nativeAdapter = null, nativePlayer = null, nativeError = null, nativeManifest = null, nativeQueue = null;
  const plans = new Map();
  try {
    progress('准备原生骨架；动作按需加载…');
    const [manifest, queue, gltf] = await Promise.all([json('/native-resources-data/manifest.json'),
      json('/native-behavior-data/queue.json'), new GLTFLoader().loadAsync('/native-resources-data/source.glb')]);
    nativeManifest = manifest; nativeQueue = queue;
    source = gltf.scene; source.visible = false; scene.add(source);
    const cloth = new NativeClothBinding(source, mesh);
    nativeAdapter = new NativeBehaviorAdapter({ mesh, source, cloth, manifest });
    nativeAdapter.resetBind();
  } catch (error) { nativeError = error.message; progress('原生骨架暂不可用，生活与交流保留：' + nativeError); }
  const resources = new BehaviorResourceCache(async (id, { signal }) => {
    if (!nativeAdapter) throw Error(nativeError ?? 'native_base_unavailable');
    const definition = NATIVE_GROUPS[id]; if (!definition) throw Error('unknown_native_group');
    const group = nativeQueue.groups.find(group => group.id === definition.groupId);
    if (!group || group.sourceFamily !== definition.sourceFamily) throw Error('Native source mismatch: ' + id);
    const plan = buildNativeBehaviorPlan(assertMotionAllowed(group), nativeManifest);
    if (JSON.stringify(plan.map(row => row.id)) !== JSON.stringify(definition.phases)) throw Error('Unapproved native route: ' + id);
    plan.forEach(assertMotionAllowed);
    const verified = new Map(definition.phaseData.flatMap(row => [row, row.companion].filter(Boolean).map(source => [source.id, source.jsonSha256])));
    await nativeAdapter.load(plan.map(row => row.id), clip => readVerifiedNativeJSON('/native-resources-data/clips/' + encodeURIComponent(clip) + '.json', verified.get(clip), url => fetch(url, { signal })));
    signal.throwIfAborted();
    plans.set(id, plan); return plan;
  });

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
  let lastNativeAction = null, activeRow = null, actor = null, simInitialized = false, speaking = false, mathematicalState = null;
  const supportedOverlay = new SupportedConversationOverlay(), supportedLocals = new Map();
  let displayedActivityPose = null;
  const nativeScene = nativeAdapter ? createNativeSceneDriver({ mesh, source, nativeAdapter, body, byName, skeleton, avatarRoot, getProps: () => props }) : null;
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
    const data = boneData(), objects = sceneProps(), state = {support:body.pose.support,phase:body.pose.phase,
      contacts:Object.fromEntries(['L','R'].map(side=>[side,!!body.pose.feet[side].contact]))}, isActivity = ['activity','supported'].includes(currentExecutor);
    const nativeState = currentExecutor === 'native' ? nativeScene?.measureState() : null;
    const root = isActivity ? clone(body.root) : worldRoot();
    const contacts = isActivity ? clone(state.contacts) : Object.fromEntries(['L', 'R'].map(side => {
      const foot = data.bones[side === 'L' ? 'leftAnkle' : 'rightAnkle'];
      const restHeight = skeleton.get(side === 'L' ? '左足首' : '右足首')?.position[1];
      return [side, !!foot && Math.abs(foot[1] - (root.position[1] + restHeight)) < .7];
    }));
    const support = nativeState?.support ?? (isActivity ? state.support : contacts.L || contacts.R ? 'standing' : 'unknown');
    return { posture: support, support, contacts: nativeState?.contacts ?? contacts, hands: occupied(objects) ? 'occupied' : 'free', props: objects,
      root, seatSupported: nativeState?.seatSupported ?? (isActivity && support === 'seated' && objects.chair?.visible === true),
      activityToken: activityToken(), resumeToken: body.attention?.paused && body.attentionRate < .001 ? activityToken() : null,
      freeHands: ['L','R'].filter(hand => !Object.values(objects).some(p=>p.visible&& (p.attachment==='both'||p.attachment===(hand==='L'?'left':'right')))),
      nativeSupport: nativeState, capabilities: ['chin-surface-calibrated'],
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
  function activityToken() { return body.activeId && (!body.done || body.attention) ? `activity:${body.revision}:${body.activeId}` : null; }
  function adoptStandingIntoActivity(state) {
    if (['activity','supported'].includes(currentExecutor)) return true;
    const captured = captureSupportedPoseFromMeasured(body, state);
    if (!captured.accepted) return false;
    return body.adoptSupportedState({ pose: captured.pose, sceneProps: state.props });
  }
  function chinSurface() {
    const position = new THREE.Vector3(); mesh.getVertexPosition(65527, position); mesh.localToWorld(position);
    const normal = new THREE.Vector3(-.0145631,-.9765164,.2149505).applyQuaternion(byName.get('頭').getWorldQuaternion(new THREE.Quaternion())).normalize();
    return { position: position.toArray(), normal: normal.toArray() };
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
      prepare: def => resources.prepare(def.id),
      check(def,state,row) {
        if(!plans.has(def.id))return 'native_resources_unavailable';
        if(row.nativePreparationError)return row.nativePreparationError;
        if(row.preparedNative){
          const valid=nativeScene.validatePrepared(row.preparedNative,state);
          if(valid.accepted)return null;
          if(valid.reason!=='native_prepared_scene_changed')return valid.reason;
          row.preparedNative=null;row.nativePreparation=null;
        }
        if(!row.nativePreparation){
          try {
            const realized=resolveNativePerformance(def,row.performance??{},
              {durationChoice:Math.max(0,Math.min(1,mathematicalState?.effectiveEnergy??.5))});
            const plan=plans.get(def.id).filter(p=>realized.phaseData.some(r=>r.id===p.id));
            row.nativeRepeat=realized.repeat;row.realizedPerformance={...realized,bodySeconds:realized.actualSeconds};
            row.nativePreparation='loading';
            const epoch=row.nativePreparationEpoch=(row.nativePreparationEpoch??0)+1;
            const isCurrent=()=>row.nativePreparationEpoch===epoch&&row.status==='queued'&&bodyDirector.pending.includes(row)&&bodyDirector.current(row.owner)
              &&(row.checkWaitWallMs==null||bodyDirector.wallClock()-row.checkWaitWallMs<bodyDirector.preparationTimeoutMs);
            nativeScene.preparePlanAsync(def,plan,state,{repeat:row.nativeRepeat??1,isCurrent}).then(prepared=>{
              if(!isCurrent())return;
              row.nativePreparation='ready';if(prepared.accepted)row.preparedNative=prepared;else row.nativePreparationError=prepared.reason;
            },error=>{if(!isCurrent())return;row.nativePreparation='failed';row.nativePreparationError=String(error.message??error);});
          }catch(error){return String(error.message??error);}
        }
        return {wait:true,reason:'native_scene_preparation'};
      },
      start(def, row, state) {
        const prepared=row.preparedNative;if(!prepared||!nativeAdapter)return false;
        const activation=nativeScene.activatePrepared(prepared,state);
        if(!activation.accepted){row.reason=activation.reason;return false;}
        row.nativeEvidence = prepared.diagnostics;
        const initialPose = captureNativePose(nativeAdapter.nodes), initialVelocity = nativeAdapter.nodes.map(node => {
          const index = nodes.indexOf(node); return velocity[index] ?? zeroVelocity([{}])[0];
        });
        const player = new NativeBehaviorPlayer({ plan: prepared.plan, sample: (id, time) => nativeScene.sample(id, time),
          initialPose, initialVelocity, repeat: row.nativeRepeat ?? 1, align: (a, b) => nativeScene.align(a, b), lifecycle: def.lifecycle, resolveReturnPose: args => nativeScene.resolveReturnPose(args),
          stopOptions: nativeAdapter.stopOptions(), bridgeSeconds: .45 });
        // NativeBehaviorPlayer already inherits exact pose and velocity. Avoid a
        // second bridge on top of its own source/target transformation.
        beginHandoff('native', row); bridge = null; nativePlayer = player; lastNativeAction = def.id; return true;
      },
      status: row => {
        const done = !bridge && nativePlayer && ['complete-held', 'cancelled-held'].includes(nativePlayer.state);
        const validation = done ? nativeScene.validateTerminal(nativePlayer.snapshot()) : null;
        return { started: !!row.visibleStarted, done, failed: !!validation && !validation.ok, reason: validation?.reason, evidence: validation?.evidence };
      },
      cancel() { if (nativePlayer && !nativePlayer.cancelled) nativePlayer.cancel({ useEnd: !!plans.get(lastNativeAction)?.some(p => p.phase === 'end') }); },
    },
    activity: {
      canYield: () => !bridge && (body.done || body.attention?.paused && body.attentionRate < .001) && !body.bridge && !body.stopMode && !body.queued,
      start(def, row, state) {
        let adopt;
        if(!['activity','supported'].includes(currentExecutor)) {
          const captured=captureSupportedPoseFromMeasured(body,state);
          if(!captured.accepted){row.reason=captured.reason;return false;}
          adopt={pose:captured.pose,sceneProps:state.props};
        }
        const prepared=body.preparePlay(def.name,{speed:1,loop:false,totalSeconds:row.performance?.total_seconds,
          durationChoice:Math.max(0,Math.min(1,mathematicalState?.effectiveEnergy??.5)),microSet:row.performance?.micro_set??[],
          context:{deskLayout:'partitioned',...(def.name==='stand_up_from_desk'?{deskRetreat:5.5}:{})}},{adopt});
        if(!prepared.accepted){row.reason=prepared.reason;return false;}
        if(adopt&&!body.adoptSupportedState(adopt)){row.reason='supported_pose_capture_failed';return false;}
        const accepted = body.play(def.name, prepared.options);
        if (!accepted) return false;
        row.realizedPerformance = { requested: row.performance?.total_seconds ?? null, bodySeconds: body.duration,
          entrySeconds: prepared.entrySeconds,totalSeconds:prepared.totalSeconds,exact:prepared.exact, preservesSourceSpeed: true };
        beginHandoff('activity', row); return true;
      },
      status: row => {
        if (row.progressAt === undefined || row.lastProgress !== body.elapsed || body.attention?.paused) {
          row.progressAt = now; row.lastProgress = body.elapsed;
        }
        const failed = !body.done && !body.attention?.paused && now - row.progressAt > 20;
        if (failed && !row.timeoutStopped) { row.timeoutStopped = true; body.stop(); }
        return { started: !!row.visibleStarted, done: failed || (!bridge && body.done && !body.bridge),
          failed, reason: failed ? 'activity_execution_timeout' : null };
      },
      cancel() { body.stop(); },
    },
    supported: {
      canYield: () => !bridge && !supportedOverlay.active,
      start(def, row, state) {
        if (!adoptStandingIntoActivity(state)) { row.reason = 'supported_pose_capture_failed'; return false; }
        const kind = def.supportedKind ?? ({tilt:'tilt_left',glance:'glance_left'})[def.name] ?? def.name;
        if (!supportedOverlay.begin({id:row.id,kind,duration:def.duration??1.5,strength:.65})) return false;
        beginHandoff('supported', row); return true;
      },
      status: row => ({started:!!row.visibleStarted,done:!bridge&&!supportedOverlay.active,failed:!!row.supportedFailed,reason:row.reason}),
      cancel: row => supportedOverlay.cancel(row.id),
    },
    control: {
      check(def,state,row) {
        if(['resume_activity','finish_activity'].includes(def.name) && supportedOverlay.active)return 'busy';
        if(def.name==='pause_activity'&&row.owner?.sourceScope==='mechanical'&&!body.attention?.paused){
          const window=body.library[body.activeId]?.continuation;
          const tail=body.duration-(body.library[body.activeId]?.duration-(window?.end??0));
          if(body.bridge||!window||!['standing','seated'].includes(body.pose.support)||body.elapsed<window.start||body.elapsed+body.attentionRate*.11>=tail)
            return {wait:true,reason:'awaiting_actual_supported_middle'};
        }
        return null;
      },
      start(def,row,state) {
        if (!row.activity_token || row.activity_token !== activityToken()) {row.reason='stale_activity_token';return false;}
        row.sceneStart=now;
        if(def.name==='pause_activity') return body.pauseForAttention({id:row.activity_token,kind:'listen',strength:.55});
        if(def.name==='resume_activity') {
          if(!body.resumeFromAttention(row.activity_token))return false;
          currentExecutor='activity'; bridge=null;return true;
        }
        if(def.name==='finish_activity') {
          body.resumeFromAttention(row.activity_token);
          if(!body.continuation?.released&&!body.releaseHold())body.stop();currentExecutor='activity';bridge=null;return true;
        }
        return false;
      },
      status: row => ({started:now>row.sceneStart,done:row.action.endsWith('pause_activity') ? !!body.attention?.paused && body.attentionRate<.001 && ['standing','seated'].includes(body.pose.support) : now>row.sceneStart}),
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
  const defDuration = id => body.library[id?.replace('activity:', '')]?.duration;
  const makeDirector = () => new CharacterBodyDirector({ executors: adapters, getActorState: () => actor ?? physicalState(),
    isOwnerCurrent: options.isOwnerCurrent ?? (() => true), onEvent: options.onEvent ?? (() => {}) });
  let bodyDirector = makeDirector();
  let eventTail=null, eventSnapshot=[], rowSnapshot=[];
  function lightweightBodySnapshot(){
    if(eventTail!==bodyDirector.events.at(-1)){
      eventTail=bodyDirector.events.at(-1);eventSnapshot=clone(bodyDirector.events.slice(-100));rowSnapshot=clone(bodyDirector.rows.slice(-250));
    }
    return {...bodyDirector.snapshot({diagnostics:false}),events:eventSnapshot,rows:rowSnapshot};
  }
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
      if (['activity','supported'].includes(currentExecutor)) {
        body.update(now, dt); displayedActivityPose = body.displayPose ?? body.pose;
        rig.apply(body.locals); avatarRoot.position.set(...body.root.position); avatarRoot.rotation.y = body.root.yaw;
        avatarRoot.updateMatrixWorld(true); mesh.skeleton.update();
        if (currentExecutor === 'supported') {
          const result = supportedOverlay.update(dt, displayedActivityPose, {rig:body.rig,voicing:speaking,chinSurface:chinSurface()});
          if (!result.accepted) { if(activeRow){activeRow.reason=result.reason;activeRow.supportedFailed=true;} supportedOverlay.cancel(); }
          displayedActivityPose=result.pose;solveFullBodyPose(body.rig, result.pose, supportedLocals);rig.apply(supportedLocals);
        } else rig.apply(body.locals); avatarRoot.position.set(...body.root.position); avatarRoot.rotation.y = body.root.yaw;
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
    const yaw = view === 'front' || view === 'face' || view === 'body' ? 0 : view === 'side' ? Math.PI / 2 : view === 'other-side' ? -Math.PI / 2 : .55;
    const distance = (view === 'face' ? 9 : view === 'body' ? 25 : 37) * Math.max(1, .85 / camera.aspect);
    camera.position.set(focus.x + Math.sin(yaw) * distance, focus.y + (view === 'face' ? 0 : 2), focus.z + Math.cos(yaw) * distance); camera.lookAt(focus);
  };
  resize(); const observer = new ResizeObserver(resize); observer.observe(stage);
  function placeInitialActor(value={position:[0,0,0],yaw:0}) {
    if(!Array.isArray(value.position)||value.position.length!==3||!value.position.every(Number.isFinite)||!Number.isFinite(value.yaw))throw Error('invalid_initial_root');
    conversationFrame=clone(value);body.root=clone(value);body.anchor=clone(value);body.pose=body.standing(value);body.solve();
    avatarRoot.position.set(...value.position);avatarRoot.rotation.set(0,value.yaw,0);
  }
  const defaultEntry=pulledOutDeskEntryFixture(body.context);
  const initialRoot=options.initialRoot??(options.sceneProps?undefined:defaultEntry.initialRoot);
  placeInitialActor(initialRoot);
  restoreRest(); motion.update(0, 0, { face: ZERO_HEAD, actions: [] }); rig.apply(motion.locals); avatarRoot.updateMatrixWorld(true);
  const initialProps = options.sceneProps ?? { ...defaultEntry.sceneProps, mat: { visible: true, attachment:'floor',position:[15,0,0] }, box:{ visible:true,attachment:'floor',position:[-12,0,4.1] }, platform:{visible:true,attachment:'floor',position:[0,0,14]} };
  // Initial fixture coordinates belong to the scene, not the actor's starting
  // pose. Applying the actor offset here would move the chair a second time.
  const sceneOrigin = { position: [0, 0, 0], yaw: 0 };
  props.update(initialProps, { ...boneData(), root: body.root, anchor: sceneOrigin, pose: body.pose, time: 0 });
  body.setRenderedPropsSnapshot(props.snapshot()); actor = physicalState(); lastPose = captureNativePose(nodes);
  cameraView(); progress('编译统一人物场景…'); await renderer.compileAsync(scene, camera);
  const gl = renderer.backend.gl, debug = gl.getExtension('WEBGL_debug_renderer_info');
  const environment = { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown',
    userAgent: navigator.userAgent, physics: false, pmxLoads: 1, nativeReady: !!nativeAdapter, nativeError, nativeLoading: 'per-behavior' };
  const api = {
    get bodyDirector(){return bodyDirector;}, get motion(){return motion;}, actionController, body, mesh, props, environment,
    // Explicit component-inspection reset only. Runtime interruption never calls
    // this method: it must preserve the current support and object ownership.
    resetInspection(nextProps = initialProps, nextRoot=initialRoot) {
      if(options.allowInspectionReset!==true)throw Error('inspection_reset_not_enabled');
      bodyDirector.cancel(null,'explicit_inspection_reset');body.reset();supportedOverlay.clear();props.reset();
      motion=new MotionController({skeleton});motion.setOptions({natural:true,continuity:true,intensity:1,speed:1});
      // This explicit fixture reset also resets the private wall clock and cue
      // dedupe set. Clearing only cues leaves the previous inspection's time,
      // so a new head action at t=0 is incorrectly rejected as late.
      Object.assign(actionController,new FaceController());actionController.headSway=false;actionController.setPreset('neutral',0);
      nativePlayer=null;activeRow=null;lastNativeAction=null;currentExecutor='conversation';bridge=null;displayedActivityPose=null;
      now=0;frames=0;simInitialized=false;placeInitialActor(nextRoot);
      nativeAdapter?.cloth?.setEnabled(false);restoreRest();
      motion.update(0,0,{face:ZERO_HEAD,actions:[]});rig.apply(motion.locals);avatarRoot.updateMatrixWorld(true);mesh.skeleton.update();
      props.update(nextProps,{...boneData(),root:body.root,anchor:sceneOrigin,pose:body.pose,time:0});body.setRenderedPropsSnapshot(props.snapshot());
      bodyDirector=makeDirector();actor=physicalState();lastPose=captureNativePose(nodes);velocity=zeroVelocity(lastPose);rendered=null;return api.snapshot();
    },
    prepare(id) { return resources.prepare(id); },
    resourceStatus() { return resources.snapshot(); },
    setView(next) { if (['front', 'angle', 'side', 'other-side', 'face', 'body', 'full'].includes(next)) { view = next; cameraView(); } },
    setExpressionEnabled() {},
    actionLayer() { return { blink: actionWeights[C.blink] ?? 0, head: clone(actionController.head),
      activeActions: [...actionController.activeActions], executedCues: clone(actionController.executedCues) }; },
    step(time, dt, { faceWeights = null, paused = false, audioTime = null, audioStatus = 'idle', mediaOwner = null,
      segmentEnded = false, render = true, mathematicalState: mathState = null } = {}) {
      if (disposed) throw Error('scene_disposed');
      if (!Number.isFinite(time) || !Number.isFinite(dt) || dt < 0) throw Error('invalid_scene_clock');
      if (!simInitialized) { now = time; simInitialized = true; }
      const delta = paused ? 0 : Math.min(.1, dt); now += delta; speaking=audioStatus==='playing'; mathematicalState=mathState??mathematicalState;
      const start = performance.now();
      bodyDirector.update(now, delta, { paused, audioTime, audioStatus, mediaOwner, segmentEnded });
      mesh.morphTargetInfluences.fill(0);
      if (faceWeights) for (let i = 0; i < mesh.morphTargetInfluences.length; i++) {
        const value = faceWeights[i] ?? 0; if (!Number.isFinite(value)) throw Error('nonfinite_face_weight'); mesh.morphTargetInfluences[i] = value;
      }
      if (!paused) applyExecutor(delta);
      const data = boneData(), state = body.snapshot(), visibleProps = ['activity','supported'].includes(currentExecutor) ? { ...body.sceneProps, ...(displayedActivityPose??body.pose).props } : body.sceneProps;
      props.update(visibleProps, { ...data, root: ['activity','supported'].includes(currentExecutor) ? body.root : actor.root,
        anchor: body.pose?.anchor ?? body.anchor, pose: ['activity','supported'].includes(currentExecutor) ? (displayedActivityPose??body.pose) : {}, snapshot: state, time: now });
      body.setRenderedPropsSnapshot(props.snapshot()); if (['activity','supported'].includes(currentExecutor)) body.setPropTransferReceipts(props.snapshot());
      actor = physicalState(); cameraView(); mesh.skeleton.update(); const driven = performance.now();
      if (render) renderer.render(scene, camera);
      const finite = [...Object.values(data.bones).flat(), ...Object.values(data.rotations).flat(), ...mesh.morphTargetInfluences].every(Number.isFinite);
      if (!finite || rig.missing.size) throw Error('Invalid unified character pose: ' + [...rig.missing].join(','));
      rendered = { frame: ++frames, now, finite, renderSubmitted: render, executor: currentExecutor, actorState: clone(actor),
        body: lightweightBodySnapshot(), resources: resources.snapshot(), native: nativePlayer?.snapshot() ?? null, activity: ['activity','supported'].includes(currentExecutor) ? state : null, supported: supportedOverlay.snapshot(),
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
