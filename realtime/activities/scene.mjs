import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { MMDLoader, MMDAnimationHelper } from '@takahirox/three-mmd';
import { FaceController } from '/preview/core/controller.js';
import { FullBodyController } from '/preview/core/full-body-controller.js';
import { AEMEATH_BINDINGS, VOWELS } from '/preview/core/profile.js';
import { MotionRig, skeletonFromMesh } from '/preview/studio/motion-rig.js';
import { createActivityProps } from './props.mjs';

/** Full-body stage. The legacy conversation scene remains an independent host. */
export async function createActivityScene(stage, progress=()=>{}) {
  const scene=new THREE.Scene();scene.background=new THREE.Color('#e5e1dc');scene.fog=new THREE.Fog('#e5e1dc',85,160);
  const camera=new THREE.PerspectiveCamera(38,1,.1,220);
  const renderer=new WebGPURenderer({antialias:true,forceWebGL:true,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;
  await renderer.init();renderer.toneMapping=THREE.NeutralToneMapping;stage.prepend(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff,1.35));
  for(const [color,intensity,p] of [[0xfff3df,1.8,[-12,30,20]],[0xd5e8ff,.7,[20,20,-10]]]){const l=new THREE.DirectionalLight(color,intensity);l.position.set(...p);scene.add(l);}
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(120,120),new THREE.MeshStandardMaterial({color:'#dad5cd',roughness:.95}));floor.rotation.x=-Math.PI/2;floor.position.y=.01;scene.add(floor);
  const grid=new THREE.GridHelper(100,50,'#b6b0a9','#ccc6bd');grid.position.y=.025;grid.material.transparent=true;grid.material.opacity=.45;scene.add(grid);
  const origin=new THREE.Mesh(new THREE.RingGeometry(.8,.85,40),new THREE.MeshBasicMaterial({color:'#b69778',transparent:true,opacity:.7,side:THREE.DoubleSide}));origin.rotation.x=-Math.PI/2;origin.position.y=.03;scene.add(origin);
  const manager=new THREE.LoadingManager();manager.onProgress=(_,n,total)=>progress(`人物与贴图 ${n}/${total}`);
  const mesh=await new MMDLoader(manager).loadAsync('/model/'+encodeURIComponent('鸣潮_爱弥斯1.05.pmx'));
  for(const [i,name] of AEMEATH_BINDINGS)if(mesh.geometry.morphTargets[i]?.name!==name)throw Error(`Morph binding: ${name}`);
  const skeleton=skeletonFromMesh(mesh),body=new FullBodyController({skeleton}),face=new FaceController();face.headSway=false;
  const rig=new MotionRig(mesh),helper=new MMDAnimationHelper();helper.add(mesh,{physics:false});helper.enable('ik',false);
  const rest=mesh.skeleton.bones.map(b=>[b,b.quaternion.clone(),b.position.clone()]);
  const avatarRoot=new THREE.Group();avatarRoot.add(mesh);scene.add(avatarRoot);mesh.frustumCulled=false;
  const props=createActivityProps(scene);
  const contactShadows=['L','R'].map(()=>{const shadow=new THREE.Mesh(new THREE.CircleGeometry(.9,32),new THREE.MeshBasicMaterial({color:'#6b6663',transparent:true,opacity:.16,depthWrite:false}));shadow.rotation.x=-Math.PI/2;shadow.position.y=.04;scene.add(shadow);return shadow;});
  const names={head:'頭',neck:'首',chest:'上半身2',spine:'上半身',pelvis:'腰',hip:'下半身',leftHip:'左足',rightHip:'右足',leftKnee:'左ひざ',rightKnee:'右ひざ',leftAnkle:'左足首',rightAnkle:'右足首',leftToe:'左つま先',rightToe:'右つま先',leftShoulder:'左腕',rightShoulder:'右腕',leftElbow:'左ひじ',rightElbow:'右ひじ',leftWrist:'左手首',rightWrist:'右手首'};
  names.leftMiddle='左中指１';names.rightMiddle='右中指１';
  const observed=Object.entries(names).map(([k,n])=>[k,mesh.skeleton.bones.find(b=>b.name===n)]);
  let view='angle',follow=true,frames=0,rendered=null,lastFace=null,propOverride=null;
  const focus=new THREE.Vector3(0,9.5,0),v=new THREE.Vector3(),q=new THREE.Quaternion();
  const resize=()=>{renderer.setSize(stage.clientWidth,stage.clientHeight);camera.aspect=stage.clientWidth/stage.clientHeight;camera.updateProjectionMatrix();};
  const positionCamera=()=>{
    const wide=Math.max(1,1.08/camera.aspect),z=(view==='wide'?54:43)*wide;
    const target=follow?body.root?.position??[0,0,0]:[0,0,0];focus.set(target[0],9.5,target[2]);
    const yaw=view==='front'?0:view==='side'?Math.PI/2:view==='back'?Math.PI:.55;
    camera.position.set(focus.x+z*Math.sin(yaw),view==='top'?50:22,focus.z+z*Math.cos(yaw));camera.lookAt(focus);
  };
  resize();positionCamera();const observer=new ResizeObserver(resize);observer.observe(stage);
  progress('准备全身材质与场景…');await renderer.compileAsync(scene,camera);
  const gl=renderer.backend.gl,debug=gl.getExtension('WEBGL_debug_renderer_info');
  const environment={renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):'unknown',userAgent:navigator.userAgent,physics:false};
  return {body,face,environment,props,
    get mesh(){return mesh;},
    setView(next){if(['angle','front','side','back','wide','top'].includes(next)){view=next;positionCamera();}},
    setFollow(value){follow=!!value;},setPropOverride(value){propOverride=value;},
    step(now,dt,{paused=false,lip=null,render=true}={}){
      const start=performance.now();body.update(now,dt,{paused});const snapshot=body.snapshot(),pose=body.pose;
      const requested=pose?.face??{preset:'neutral',intensity:.7},key=JSON.stringify(requested);
      if(key!==lastFace){face.setPreset(requested.preset,requested.intensity??.7);lastFace=key;}
      const weights=face.update(now,paused?0:dt,lip,!paused,{paused,mouthMode:lip?'speech':'expression'});
      mesh.morphTargetInfluences.fill(0);for(let i=0;i<AEMEATH_BINDINGS.length;i++)mesh.morphTargetInfluences[AEMEATH_BINDINGS[i][0]]=weights[i];
      for(const [bone,rotation,position] of rest){bone.quaternion.copy(rotation);bone.position.copy(position);}
      rig.apply(body.locals);avatarRoot.position.set(...body.root.position);avatarRoot.rotation.y=body.root.yaw;
      helper.update(paused?0:dt);avatarRoot.updateMatrixWorld(true);
      // Also refresh skinning for deterministic captures between renderer frames.
      // Bone positions alone are not evidence that the visible skin has updated.
      mesh.skeleton.update();
      const bones={},rotations={};for(const [key,bone] of observed){if(!bone)continue;bones[key]=bone.getWorldPosition(v).toArray();rotations[key]=bone.getWorldQuaternion(q).toArray();}
      props.update({...pose?.props,...propOverride},{bones,rotations,root:body.root,anchor:pose?.anchor??snapshot.anchor,pose,snapshot,time:body.now});
      body.setRenderedPropsSnapshot(props.snapshot());
      body.setPropTransferReceipts(props.snapshot());
      for(let i=0;i<2;i++){const foot=bones[i?'rightAnkle':'leftAnkle'];if(foot){contactShadows[i].position.set(foot[0],.04,foot[2]+.3);contactShadows[i].material.opacity=Math.max(.015,.16-(foot[1]-1.411)*.05);}}
      positionCamera();const driven=performance.now();if(render)renderer.render(scene,camera);const submitted=performance.now();
      const finite=[...weights,...Object.values(bones).flat(),...Object.values(rotations).flat(),...body.root.position,body.root.yaw].every(Number.isFinite);
      if(!finite||rig.missing.size)throw Error(`Invalid full-body pose: ${[...rig.missing].join(',')}`);
      rendered={frame:++frames,renderSubmitted:!!render,finite,bones,rotations,weights:Array.from(weights),mouthOpen:VOWELS.reduce((n,i)=>n+weights[i],0),body:snapshot,props:props.snapshot(),driverMs:driven-start,renderMs:render?submitted-driven:0,view};return rendered;
    },snapshot(){return rendered;},dispose(){observer.disconnect();props.dispose();renderer.dispose();}
  };
}
