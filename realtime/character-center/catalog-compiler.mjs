/** Browser/Node identical canonical serialization and SHA-256. No filesystem,
 * clock, private resource path or mutable runtime state enters the catalogue. */
export const deepFreeze = value => {
  if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;
};
export function canonicalJSON(value) {
  if(Array.isArray(value))return '['+value.map(canonicalJSON).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonicalJSON(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
export function sha256(text) {
  const input=new TextEncoder().encode(text),length=input.length,bytes=new Uint8Array(((length+9+63)>>6)<<6);bytes.set(input);bytes[length]=128;
  const view=new DataView(bytes.buffer);view.setUint32(bytes.length-4,(length*8)>>>0);view.setUint32(bytes.length-8,Math.floor(length/0x20000000));
  const initial=[],constants=[];for(let n=2;constants.length<64;n++){let prime=true;for(let j=2;j*j<=n;j++)if(n%j===0){prime=false;break;}if(prime){if(initial.length<8)initial.push((Math.sqrt(n)%1*0x100000000)>>>0);constants.push((Math.cbrt(n)%1*0x100000000)>>>0);}}
  const rotate=(value,n)=>(value>>>n)|(value<<(32-n)),h=initial.slice(),w=new Uint32Array(64);
  for(let offset=0;offset<bytes.length;offset+=64){for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4);for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+w[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,k]=h;for(let i=0;i<64;i++){const t1=(k+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]+w[i])>>>0,t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;k=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}[a,b,c,d,e,f,g,k].forEach((value,i)=>{h[i]=(h[i]+value)>>>0;});
  }return h.map(value=>value.toString(16).padStart(8,'0')).join('');
}

export function activityContract(name,row) {
  const held=row.requiresHeld??(row.reading?'book':({drink:'mug',write:'pencil',carry:'box'})[row.kind]);
  const take=row.kind==='take_prop',put=row.kind==='put_prop';
  const requires={support:row.initialSupport??'standing',props:[...row.requires],freeHands:[...(row.freeHands??[])],
    ...(held?{held}:{}),...(take?{hands:'free',existingSource:row.propId}:{}),
    ...(row.requiresExistingSurface?{existingSurface:row.requiresExistingSurface}:{}),
    ...(row.category==='reading'&&row.kind==='study'?{surface:'table'}:{})};
  if(requires.surface&&!requires.props.includes(requires.surface))requires.props.push(requires.surface);
  if(row.kind==='approach_desk_seated'){
    requires.seatSupported=true;
    requires.chairTableAlignment={maximumYawRadians:.04,maximumLateralDistance:.08,maximumVerticalDistance:.04,
      advanceRange:[.15,7.05],units:'target-model',basis:'actual chair and table world transforms; executor rechecks route'};
  }
  if(row.kind==='sit_down')requires.seatAccess='实际椅前站位或可用的正前接近走廊；桌面与地面障碍不得占用落座空间。侧后方不能直接插值入座。';
  if(row.kind==='stand_up')requires.seatAccess='实际座位成立且椅前起身空间可用；若桌面挡住椅前，应由模型选择 stand_up_from_desk 的真实退椅起身过程。';
  if(row.kind==='stand_up_from_desk')requires.seatAccess='真实座位和桌前现场；退椅及落脚路线不得被地面箱子或平台占用。';
  if(row.kind==='approach_desk_seated')requires.seatAccess='实际座面接触成立；椅子与人物同步前移，脚部落点和地面路线无障碍。';
  if(['gait','jump','carry'].includes(row.kind))requires.routeClearance='按当前真实位置检查桌、椅、箱、平台的实体构件与腿/躯干路线；阻挡时拒绝并报告原因，不自动绕路。重复下一圈仍须重新检查。';
  const variants={exact:{meaning:'原动作、原幅度和原速起收；不授权其它动作替代。'}};
  if(row.heldVariant)variants[row.heldVariant]={meaning:row.heldVariantDescription,heldPreserved:true,freeHands:requires.freeHands};
  const continuation=row.continuation??null;
  return {id:`activity:${name}`,executor:'activity',channel:'body',kind:'activity',name,label:row.name,
    category:row.category,duration:row.duration,requires,
    source:{kind:'authored',module:'preview/core/activity-library.js',id:name},
    effects:{support:row.endSupport??row.initialSupport??'standing',held:take?row.propId:put?null:'preserve',
      root:['gait','jump','carry','stand_up','stand_up_from_desk','approach_desk_seated'].includes(row.kind)?'measured':'preserve',
      ...(row.kind==='approach_desk_seated'?{chair:'measured',table:'preserve'}:{}),
      ...(take?{attachment:{prop:row.propId,to:'hand',onlyAfter:'measured-grip'}}:{}),
      ...(put?{attachment:{prop:row.propId,to:row.requiresExistingSurface??'table',onlyAfter:'measured-surface-contact'}}:{})},
    durationContract:{mode:continuation?'extend-middle':'fixed',sourceSeconds:row.duration,minimumSeconds:row.duration,
      ...(put&&row.propId==='book'?{conditionalPreparation:{phase:'close-held-book',seconds:1.4,
        when:{deskLayout:'partitioned',bookOpennessGreaterThan:.05,bookClosedForPlacement:false},
        meaning:'分区桌闭书存放位：展开的书先在实际握点中连续合拢，再按原速放回。闭书不增加此阶段。额外1.4秒及真实进入均计入总时长，数学情绪不压缩这段准备。'}}:{}),
      continuation,includesHandoff:false,preserveSourceSpeed:true},variants,
    performanceContract:{total_seconds:!!continuation,variant_set:Object.keys(variants),micro_set:continuation?['gaze_shift','finger_release']:[]},
    faceAssociation:{kind:'attention',strength:.15},
    note:row.kind==='approach_desk_seated'?'先在拉出的椅子上坐稳；脚部轮换支撑，让座椅与身体同步移至桌前。桌和桌面物不移动，已有握物保持；实际位置以回执为准。'
      :'单项生活动作。前置支撑、每手占用、真实物件和路线均需执行器核验；实际结果以回执为准。'};
}

export function compileCharacterCatalog({conversation,nativeGroups,activities,nativeInventory}) {
  const rows=[...Object.entries(conversation).map(([id,row])=>({...row,id,executor:'conversation',
    channel:id==='action:blink'?'face':row.kind==='action'?'head':'body',requires:id==='action:blink'?{}:{support:'standing',hands:'free',freeHands:['L','R']},
    source:{kind:'authored',module:'realtime/model-director/catalog.mjs',id},effects:{support:'preserve',held:'preserve',root:'preserve'},
    durationContract:{mode:'fixed',sourceSeconds:row.duration,minimumSeconds:row.duration,preserveSourceSpeed:true,includesHandoff:false},
    variants:{exact:{meaning:'保持原身体幅度、近身肘部与挥手速度。'}},performanceContract:{total_seconds:false,variant_set:['exact'],micro_set:[]},
    note:'既有轨迹、身体幅度、近身肘部与挥手速度保持；没有每轮次数或冷却限制。'})),
    ...Object.entries(nativeGroups).map(([id,row])=>({...row,id,executor:'native',channel:'body',kind:'native',name:id.slice(7)})),
    ...Object.entries(activities).map(([name,row])=>activityContract(name,row))];
  const supported={'action:nod':'nod','action:shake':'shake','action:tilt':'tilt_left','action:glance':'glance_left',
    'action:glance_left':'glance_left','action:glance_right':'glance_right','gesture:listen':'listen'};
  for(const row of rows)if(supported[row.id]){
    row.variants['support-preserving']={meaning:'保持实际站/坐支撑和已有握持，仅执行获准的交流部位。',
      executor:'activity-overlay',kind:supported[row.id],requires:{support:['standing','seated'],freeHands:[]},
      effects:{support:'preserve',held:'preserve',root:'preserve'}};
    row.performanceContract.variant_set.push('support-preserving');
  }
  rows.push({id:'action:chin_tap',name:'chin_tap',label:'轻点下巴后收回',kind:'supported',executor:'supported',channel:'body',duration:2.4,
    requires:{support:['standing','seated'],freeHands:['R'],surfaceFreeHands:['R'],capabilities:['chin-surface-calibrated']},
    source:{kind:'authored',module:'preview/core/supported-conversation.js',id:'chin_tap'},
    effects:{support:'preserve',held:'preserve',root:'preserve'},faceAssociation:{kind:'curious',strength:.2},
    variants:{exact:{meaning:'明确选择右手轻点下巴；说话时撤离接触，不自动从思考触发。'}},
    durationContract:{mode:'fixed',sourceSeconds:2.4,minimumSeconds:2.4,preserveSourceSpeed:true,includesHandoff:false},
    performanceContract:{total_seconds:false,variant_set:['exact'],micro_set:[]}});
  for(const [name,meaning,effect] of [['pause_activity','暂停当前生活活动并保留实际支撑与握持','paused'],
    ['resume_activity','继续同一未撤销的生活活动','running'],['finish_activity','结束中段保持并沿原收势完成当前生活活动','finishing']])rows.push({
      id:'control:'+name,name,label:meaning,kind:'control',executor:'control',channel:'control',duration:0,
      requires:{activityToken:true},effects:{activity:effect,support:'preserve',held:'preserve',root:'preserve'},
      source:{kind:'control',module:'preview/core/full-body-controller.js',id:name},
      variants:{exact:{}},performanceContract:{total_seconds:false,variant_set:[],micro_set:[]},
      note:'必须指定当前实际活动的 activity_token；过期、已取消或其它任务令牌不能控制身体。'});
  if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('Duplicate character action');
  const body={version:2,experimental:true,actions:rows,nativeInventory,coverage:{conversation:Object.keys(conversation).length,
    activities:Object.keys(activities).length,nativeRegistered:Object.keys(nativeGroups).length,nativeSources:nativeInventory.length,supported:1,controls:3}};
  return {...body,hash:'sha256:'+sha256(canonicalJSON(body))};
}

export function validatePerformance(value,definition) {
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['total_seconds','variant_set','micro_set'].includes(key)))throw Error('invalid_performance');
  const contract=definition.performanceContract??{};
  const out={};
  if(value.total_seconds!==undefined){
    const range=Array.isArray(value.total_seconds)?value.total_seconds:[value.total_seconds,value.total_seconds];
    if(!contract.total_seconds||range.length!==2||range.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<=0)||range[0]>range[1]
      ||definition.durationContract?.mode!=='whole-source-cycles'&&range[1]<(definition.durationContract?.minimumSeconds??definition.duration??0))throw Error('invalid_total_seconds');
    out.total_seconds=Array.isArray(value.total_seconds)?[...range]:range[0];
  }
  for(const key of ['variant_set','micro_set'])if(value[key]!==undefined){
    if(!Array.isArray(value[key])||new Set(value[key]).size!==value[key].length||value[key].some(id=>typeof id!=='string'||!contract[key]?.includes(id)))throw Error('invalid_'+key);
    if(key==='variant_set'&&!value[key].length)throw Error('invalid_variant_set');out[key]=[...value[key]];
  }
  return out;
}
