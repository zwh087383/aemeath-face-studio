import { NATIVE_SOURCE_INVENTORY } from './native-inventory-data.mjs';
import { assertMotionAllowed } from '../../preview/core/character-motion-policy.js';
import { nativeMotionReviewFor } from '../../preview/core/native-motion-review.js';

const BODY='Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/';
const COMMON='Client/Content/Aki/Character/Role/FemaleM/Aimisi/CommonAnim/';
const DORM='Client/Content/Aki/Sequence/SequenceAnim/ShengtaiAnim/3_1/Sushe/RoleNPC/FemaleM/Aimisi/BaseAnim/';
const policies=new Map();
const add=(base,paths,policy)=>{for(const suffix of paths.split('|')){const path=base+suffix;if(policies.has(path))throw Error('Duplicate native source policy '+path);policies.set(path,policy);}};
const standing={scope:'single-character',entrySupport:'standing',exitSupport:'standing',contactMode:'standing',props:[]};
const seated={scope:'single-character',entrySupport:'seated',exitSupport:'seated',contactMode:'seated',props:['chair']};
const travel={...standing,contactMode:'root-motion'};
const external=(reason,objects)=>({scope:'external-scene',reason,objects});
const blocked=reason=>({scope:'prohibited',reason});

// Exact source paths, explicitly reviewed as a set. These are integration
// candidates, not a claim of human continuous-view or contact acceptance.
// Real source bytes/poses are in native-inventory-data; near-face poses keep
// their original hands and prohibit uncalibrated contact micro variations.
add(BODY,'Talk02|Talk01|Showhand01|Stand01|Thinking01|Dongbu/Hi01|Calm01|Calm03|Calm02|Thinking02|However01|Breath01',standing);
add(BODY,'Zhixiang01|Cheek01|Whisper01|Angry01|Finger_Snap|Liaofa|Dongbu/DZ_Liaotoufa01|Shy05|Shy01|Shy03|Promise01|Complain04|Complain01|Shy02|Embarrassment01|Relax01|Tsundere01|Tsundere02|Dongbu/DZ_Baobi_laugh01|Dongbu/Pleading01|Stand_DownHead01|Dongbu/Wuzui01|Dongbu/Wuzui02|Dongbu/Cazui01|Dongbu/DZ_Tanqi01',standing);
add(DORM,'Sushe_Hair',standing);
add(BODY,'Squat01|Squat02',{...standing,contactMode:'grounded-crouch'});
add(BODY,'Dongbu/Kao_Stand01',external('原姿态含倚靠；当前场景没有相应竖直承接面，不能用空气承担身体。',['wall']));
add(COMMON,'Stand2',blocked('用户禁止的精确 Stand2 来源，不用于待机、倾听、恢复、兜底或改名变体。'));
add(COMMON,'StandChange',blocked('此来源由已禁止的抬手 Stand2 起始姿态转换，保留索引，不作为绕过禁用的入口。'));

add(BODY,'SitTalk01|Sit04_Talk|Dongbu/DZ_Sit04_Hi|SitCalm01|SitThinking01|SitThinking02|Dongbu/Sit05|Dongbu/Sit04|Sit03|SitPromise01|Sit_LeanBack|Dongbu/Sit04_Head|Dongbu/Sit05_expect|Dongbu/Sit05_ShakeLegs|Dongbu/DZ_Sit04_Laugh|Dongbu/DZ_Sit_laugh01',seated);
add(BODY,'Sit_RestChin',{...seated,contactMode:'table-contact',props:['chair','table']});
add('Client/Content/Aki/Character/NPC/RoleNPC/FemaleM/Aimisi/BaseAnim/','sit_headmove_01',seated);
add(BODY,'Sit01',{...standing,contactMode:'sit-transfer',props:['chair'],middleSupport:'seated'});
add(BODY,'Dongbu/DZ_Sit_Baoyuan01',{...standing,exitSupport:'seated',middleSupport:'seated',contactMode:'sit-transfer',props:['chair']});
add(BODY,'Dongbu/Sit05_Land',{...seated,exitSupport:'standing',contactMode:'sit-transfer'});

add(BODY,'Turn_L90D|Turn_R90D|fuyong/Walk_F|Salut01|Walk_Talk01|Walk_Thinking01|Dongbu/Walk_Talk01|Walk_Hi|Shy_Walk_F|fuyong/Run_F|Run02|Weakness_walk',travel);
add('Client/Content/Aki/Character/Role/FemaleM/BaseAnim/','Walk_B|Walk_F',travel);
add(DORM,'Sushe_Farewell',travel);
add(BODY,'Dongbu/DZ_Beishouzhuanshen01',standing);
add(BODY,'Dongbu/Sit02',{...standing,sourceEntrySupport:'floor-seated',middleSupport:'floor-seated',contactMode:'floor-transfer',props:[],entrySeconds:2.4});

add(BODY,'keboard01',{...standing,contactMode:'table-contact',props:['table','laptop']});
add(DORM,'Sushe_Scripting',external('真实源骨架是俯卧并屈腿的书写现场，不是当前桌椅坐姿写字；缺匹配躯干承接面及纸笔握点。',['prone-support','paper','pencil']));
add(DORM,'Sushe_Paperplane',external('需要可持握、可释放并有飞行结果的纸飞机；普通纸张不是该物件。',['paperplane']));
add(BODY,'Stand_Cidai01|Dongbu/Run_cidai',external('需要与源手位一致的磁带及握持回执。',['cassette']));
add(BODY,'Dongbu/Take_Mai01',external('需要真实话筒及交接对象。',['microphone']));
add(DORM,'Sushe_Texting',external('需要真实手机与手机握点。',['phone']));
add(DORM,'Sushe_Guitar',external('需要吉他、承重位置及双手弦面接触。',['guitar']));
add('Client/Content/Aki/Sequence/SequenceAnim/ShengtaiAnim/3_1/Aimisi_Fanclub/RoleNPC/FemaleM/Aimisi/BaseAnim/','Aimisi_Fanclub',external('原剧情应援路线与对象不在当前单角色桌椅场景。',['fanclub-scene']));
add(BODY,'fuyong/MotorPassenger_Stand|Mortor_Zhixiang01|Dongbu/DZ_Motor_shouji01|Motor_Dajian01',external('源姿态以载具及其接触点为前提；当前没有载具。',['vehicle']));
add(BODY,'Touch01|Dongbu/DZ_Sit_Guabi02|Dongbu/Fu01|Dongbu/Guabizi01|Dongbu/DZ_Bao01|Stand_Qianshou01|DZ_GuabiziEND|Dongbu/DZ_Baoku01|Hold_hands|Dongbu/DZ_Woshou01|DZ_Woshou_01|Dongbu/Beizhuashou01|Dongbu/DZ_Beila01',external('需要第二人物或被接触对象的真实锚点、让位和交接。',['partner']));
// Actual source samples put both hands at the actor's own face/chest; this is
// not opened as a partner pat merely because the filename says Pat.
add(BODY,'Pat',{...standing,meaning:'双手靠近自身脸部与胸前后放下；不宣称触碰另一人物。'});

add(BODY,'Dongbu/Readiness04|Readiness02|Dongbu/Readiness03',blocked('战斗准备上下文及伸拳姿态尚未被证明为独立非战斗生活表达；禁止在交流目录试猜。'));
add(COMMON,'Stand1_Action01|Stand1_Action02|Stand1_Action03',standing);
add(COMMON,'XA_Loop_Stand',external('实测身体不是地面直立支撑；需要原特殊悬空/承接现场。',['special-support']));
add(BODY,'Raise01|Awareness01|Dongbu/DZ_Taishou02|Dongbu/DZ_Taishou01|Dongbu/DZ_Shenshou01|Dongbu/Fool02|Fool01|Dongbu/Kanziji01|Qujing01|Dongbu/DZ_Chiru01|Dongbu/DZ_SaveMoning|Dongbu/Bi01|Dongbu/DZ_ShaqingXingfen|Dongbu/DZ_Mofang02|Dongbu/DZ_Mofang01',standing);
add(BODY,'SitFool01|Dongbu/DZ_SitUP|Dongbu/DZ_Tanzuo02|Dongbu/DZ_Tanzuo04|Dongbu/DZ_Tanzuo01|Dongbu/DZ_Tanzuo03',seated);
add(BODY,'Dongbu/DZ_Pa01|fuyong/DZ_Pa01',{...seated,contactMode:'table-contact',props:['chair','table']});
add(BODY,'Weak_Sit',{...travel,middleSupport:'seated',props:['chair']});
add(COMMON,'UiAnim/Ui_Resonant|UiAnim/Ui_Nature|UiAnim/Ui_Chip',external('原游戏装备展示关联对象与表现层未在当前场景提供；保留来源，不改名成为日常手势。',['game-display-context']));
add(COMMON,'UiAnim/Team_Stand1|UiAnim/Team_Stand3',{...standing,meaning:'原生展示站姿；只用于明确展示，不作为默认待机或自动兜底。'});
add(COMMON,'UiAnim/Team_Stand2',external('此来源不是被禁 Stand2，但实际单腿高抬姿态缺匹配承接条件；暂不作为普通站姿。',['raised-foot-support']));
add(BODY,'Dongbu/DZ_Rushui01|Dongbu/DZ_Rushui02',external('入水与游动的支撑关系不能在平地冒充。',['water']));
add(BODY,'DZ_Fly01',external('飞行姿态没有地面支撑，当前场景没有飞行能力。',['flight']));
add(BODY,'DZ_Hunmi',external('原生后仰悬托姿态需要躯干承接面或另一承接者；当前椅子不是该承接关系。',['reclining-support']));

const supportAt=geometry=>geometry.start.pelvisHeight>.8?'standing-candidate':geometry.start.pelvisHeight>.35?'seated-candidate':'low-or-reclining';
export const NATIVE_INVENTORY=NATIVE_SOURCE_INVENTORY.groups.map(group=>{
  const sourcePolicy=policies.get(group.sourceFamily);if(!sourcePolicy)throw Error('Unreviewed exact native source '+group.sourceFamily);
  const userReview=nativeMotionReviewFor(group);
  const policy=userReview?.status==='excluded'?blocked(userReview.reason)
    :userReview?.status==='pending'?{scope:'semantic-review',reason:userReview.reason}
    :userReview?.status==='confirmed'?{...sourcePolicy,meaning:userReview.meaning+'（原生）'}:sourcePolicy;
  return {...group,policy:{...policy},status:policy.scope==='single-character'?'candidate':policy.scope,
    ...(userReview?{userReview}:{}),
    review:{stage:'source-and-kinematic-inspection',visualAccepted:false,contactAccepted:false,
      evidence:'Fingerprint-matched source samples; exact source contract. Runtime target/scene validation is mandatory.',
      entryPoseClass:supportAt(group.phases[0].geometry)}};
});
if(policies.size!==NATIVE_INVENTORY.length)throw Error('Native policy/inventory coverage mismatch');

export function compileNativeGroups(inventory=NATIVE_INVENTORY) {
  const result={};
  for(const group of inventory) {
    if(['excluded','pending'].includes(nativeMotionReviewFor(group)?.status))continue;
    if(group.policy.scope!=='single-character')continue;
    assertMotionAllowed(group);
    const policy=group.policy,phaseData=group.phases,hasEnd=phaseData.some(p=>p.phase==='end'),loops=phaseData.filter(p=>p.phase==='loop');
    // A looping walk/run clip often ends in swing or flight. Finishing its
    // source samples is not yet a supported stop; reserve a real landing route.
    const needsReturn=!hasEnd&&(phaseData.some(p=>p.phase!=='single')||policy.contactMode==='root-motion'||group.sourceFamily===COMMON+'Stand1_Action03');
    const sourceSeconds=phaseData.reduce((n,p)=>n+p.duration,0),returnSeconds=needsReturn?.65:0,settleSeconds=needsReturn?0:.4;
    const entrySeconds=policy.entrySeconds??(group.missingStart||policy.contactMode==='table-contact'?.8:0);
    const variants={exact:{meaning:'同源完整阶段顺序，保持原幅度与源速度。'}};
    for(const loop of loops)variants['phase:'+loop.id]={meaning:'同一来源的循环阶段',phaseIds:[loop.id]};
    const id=group.groupId==='native:c38c5010f63da5b2'?'native:stand01':group.groupId==='native:ac884e85b5aef5d1'?'native:thinking01':group.groupId;
    const nearFace=phaseData.some(p=>p.geometry.minimumHandHeadDistance<.3);
    result[id]={id,groupId:group.groupId,label:policy.meaning??((phaseData.find(p=>p.phase==='loop')??phaseData[0]).name.replace(/·.*$/,'')+'（原生）'),sourceFamily:group.sourceFamily,
      source:{kind:'native',groupId:group.groupId,family:group.sourceFamily,clipSha256:Object.fromEntries(phaseData.map(p=>[p.id,p.sha256]))},
      phases:phaseData.map(p=>p.id),phaseData,sourceRootMovement:group.sourceRootMovement,repeat:1,duration:sourceSeconds+returnSeconds+entrySeconds+settleSeconds,
      requires:{support:policy.entrySupport,hands:'free',freeHands:['L','R'],props:policy.props,
        ...(policy.entrySupport==='seated'?{seatSupported:true}:{}),
        nativeSceneContract:policy.contactMode,capabilities:policy.capabilities??[],nearFaceOwnership:nearFace?'source-exclusive':'none'},
      effects:{support:policy.exitSupport,held:'preserve',root:policy.contactMode==='root-motion'?'measured':'preserve'},
      lifecycle:{entry:'supported-bridge',exit:hasEnd?'source-end':needsReturn?'return-entry':'source-complete',
        cancel:hasEnd?'phase-boundary-end':['root-motion','sit-transfer'].includes(policy.contactMode)?'finish-source':'return-entry',
        returnSeconds:.65,entrySeconds,settleSeconds,sourceEntrySupport:policy.sourceEntrySupport??policy.entrySupport,entrySupport:policy.entrySupport,exitSupport:policy.exitSupport,contactMode:policy.contactMode,
        middleSupport:policy.middleSupport??policy.entrySupport},
      durationContract:{mode:loops.length?'whole-source-cycles':'fixed',sourceSeconds,minimumSeconds:sourceSeconds+returnSeconds+entrySeconds+settleSeconds,entrySeconds,settleSeconds,
        startSeconds:phaseData.filter(p=>p.phase==='start').reduce((n,p)=>n+p.duration,0),endSeconds:phaseData.filter(p=>p.phase==='end').reduce((n,p)=>n+p.duration,0),
        loopSeconds:loops.reduce((n,p)=>n+p.duration,0),returnSeconds,preserveSourceSpeed:true,includesHandoff:true},
      variants,performanceContract:{total_seconds:!!loops.length,variant_set:Object.keys(variants),micro_set:[]},
      faceAssociation:{kind:'attention',strength:.15},admission:{status:'candidate',requiresTargetValidation:true,sourceMatched:true,visualAccepted:false,contactAccepted:false},
      note:'保留原生身体与配套衣发的同一采样钟。准入依据实际支撑/路径/接触回执；近脸手不授权额外接触微动作。'};
  }
  return result;
}
export const NATIVE_GROUPS=compileNativeGroups();

/** Find reachable whole-cycle duration without changing source speed. A number
 * is a target, never an unconditional guarantee. A range must contain a route. */
export function resolveNativePerformance(definition,performance={}, {durationChoice=.5}={}) {
  if(typeof durationChoice!=='number'||!Number.isFinite(durationChoice)||durationChoice<0||durationChoice>1)throw Error('invalid_native_duration_choice');
  const selected=performance.variant_set?.filter(id=>id!=='exact').flatMap(id=>definition.variants[id]?.phaseIds??[]);
  const phases=selected?.length?definition.phaseData.filter(p=>p.phase!=='loop'||selected.includes(p.id)):definition.phaseData;
  const loopSeconds=phases.filter(p=>p.phase==='loop').reduce((n,p)=>n+p.duration,0),fixed=phases.filter(p=>p.phase!=='loop').reduce((n,p)=>n+p.duration,0)+(definition.durationContract.returnSeconds??0)+(definition.durationContract.entrySeconds??0)+(definition.durationContract.settleSeconds??0);
  const requested=performance.total_seconds;let repeat=1;
  if(requested!==undefined&&loopSeconds){
    if(Array.isArray(requested)){
      const minimum=Math.max(1,Math.ceil((requested[0]-fixed-1e-7)/loopSeconds)),maximum=Math.floor((requested[1]-fixed+1e-7)/loopSeconds);
      if(maximum<minimum)throw Error('native_duration_unreachable');
      // Only the explicitly permitted total range may be modulated. Pick a
      // reachable whole-source-cycle count near the mathematical target;
      // entry, exit, and every source sample retain their original clocks.
      const target=requested[0]+(requested[1]-requested[0])*durationChoice;
      repeat=Math.max(minimum,Math.min(maximum,Math.round((target-fixed)/loopSeconds)));
    }
    else repeat=Math.max(1,Math.round((requested-fixed)/loopSeconds));
  }
  if(!Number.isSafeInteger(repeat))throw Error('native_duration_unreachable');
  const actualSeconds=fixed+loopSeconds*repeat;
  return {phaseData:phases,repeat,actualSeconds,requested:requested??null,exact:requested===undefined||typeof requested==='number'&&Math.abs(requested-actualSeconds)<1e-6,
    preservesSourceSpeed:true,returnReservedSeconds:definition.durationContract.returnSeconds??0,
    durationChoice:Array.isArray(requested)?durationChoice:null};
}
