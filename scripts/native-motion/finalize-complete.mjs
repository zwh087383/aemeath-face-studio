import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.join(root,'outputs/native-complete-20261022');
const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
const reviewed=JSON.parse(fs.readFileSync(path.join(root,'scripts/native-motion/complete-candidates.json'),'utf8'));
const rows=[...manifest.clips,...manifest.resources],expected=[...reviewed.clips,...reviewed.objects];
if(rows.length!==expected.length||new Set(rows.map(r=>r.id)).size!==expected.length)throw Error('Incomplete or duplicate export manifest');
const allowed=new Map(expected.map(r=>[r.id,r]));
for(const row of rows){
  if(allowed.get(row.id)?.sourceAsset!==row.sourceAsset||!row.rawArchived)throw Error(`Missing original package: ${row.id}`);
  if(!row.rawFiles?.length)throw Error(`Empty original package: ${row.id}`);
  for(const file of row.rawFiles)if(fs.statSync(path.join(out,'raw',row.id,file.name)).size!==file.bytes)throw Error(`Incomplete raw package: ${row.id}`);
}
const models=manifest.resources.filter(r=>r.kind==='prop-model'&&r.modelFile);
const auditFile=path.join(out,'complete-offline-audit.json');
const audits=fs.existsSync(auditFile)?new Map(JSON.parse(fs.readFileSync(auditFile)).clips.map(r=>[r.id,r])):new Map();
for(const row of manifest.clips){
  if(row.resourceKind==='prop-animation'){
    const match=models.find(model=>row.sourceAsset.startsWith(model.sourceAsset.slice(0,model.sourceAsset.lastIndexOf('/Model/')+1)));
    if(!match)throw Error(`Prop clip has no companion model: ${row.id}`);
    row.propModelId=match.id;row.modelUrl=match.modelUrl;
  }
  if(audits.size){
    const audit=audits.get(row.id);
    if(audit)row.audit={finite:audit.finite,mapped:audit.mapped,singlePose:audit.singlePose,maxLengthError:audit.maxLengthError};
  }
}
const countBy=(list,key)=>Object.fromEntries([...new Set(list.map(r=>r[key]))].map(value=>[value,list.filter(r=>r[key]===value).length]));
manifest.summary={reviewed:rows.length,rawArchived:rows.filter(r=>r.rawArchived).length,readyClips:manifest.clips.filter(r=>r.status==='ready').length,archivedClips:manifest.clips.filter(r=>r.status!=='ready').length,clipKinds:countBy(manifest.clips,'resourceKind'),objectKinds:countBy(manifest.resources,'kind'),rawBytes:rows.reduce((n,r)=>n+r.rawFiles.reduce((s,f)=>s+f.bytes,0),0)};
manifest.experimental=true;manifest.incomplete=false;
manifest.notes=[
  '所有数据来自本机精确路径白名单；攻击、技能和战斗武器演出继续排除。',
  '原生资源重放并非游戏录屏；衣发是骨骼动画叠加，没有恢复游戏布料碰撞。',
  '独立道具灰模及配套动画已连接；人物挂接、家具锚点和完整游戏材质仍需场景适配。',
  'VoiceMouth为全游戏预制台词口型，未确认角色归属，不是任意实时音频转口型模型。',
  '默认面部中缺少当前PMX对应的Special控制保留原值，不猜测映射。',
];
const finalFile=path.join(out,'manifest.json');fs.writeFileSync(finalFile+'.tmp',JSON.stringify(manifest,null,2));fs.renameSync(finalFile+'.tmp',finalFile);console.log(JSON.stringify(manifest.summary));
