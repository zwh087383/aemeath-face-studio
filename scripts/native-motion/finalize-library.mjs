import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.join(root,'outputs/native-common-motions-20261022');
const manifest=JSON.parse(fs.readFileSync(path.join(out,'validated-manifest.json')));
const audit=JSON.parse(fs.readFileSync(path.join(out,'offline-audit.json')));
const browserFile=path.join(out,'browser-acceptance.json');
const browser=fs.existsSync(browserFile)?JSON.parse(fs.readFileSync(browserFile)):null;
const groups=new Map();
for(const row of manifest.clips){
  if(/attack|skill|burst|execute|dodge|death|weapon|fight|rogue|(?:^|[/_])hit(?:[_0-9.]|$)/i.test(row.sourceAsset))throw Error('Combat clip in release manifest');
  const suffix=/-(start|end|loop[0-9]*)$/.exec(row.id),result=audit.clips.find(c=>c.id===row.id);
  if(!result?.finite||result.maxLengthError>1e-9)throw Error('Clip has no passing offline audit');
  row.groupId=suffix?row.id.slice(0,-suffix[0].length):row.id;
  row.phase=suffix?(suffix[1].startsWith('loop')?'loop':suffix[1]):'single';
  row.sourceKind=row.sourceAsset.includes('/FemaleM/BaseAnim/')?'shared':'character';
  row.notes='原生身体动作；中文用途按资源名标注。';
  if(suffix)row.notes+=' 起势、循环与收势保留为独立片段。';
  if(row.category==='坐姿')row.notes+=' 需要匹配座椅和场景锚点；当前为空场动作预览。';
  if(row.category==='行走')row.notes+=' 原地步行曲线，角色在场景中的移动需要另外驱动。';
  if(row.sourceKind==='shared')row.notes+=' 此为女性中体型共用动作，已通过当前模型适配检查。';
  if(Math.max(...result.pelvisRangeCm)>100)row.notes+=' 含明显原生位置变化，建议开启跟随人物。';
  const rendered=browser?.clips?.find(c=>c.id===row.id);
  if(rendered)row.browserAudit={samples:rendered.samples.length,finite:rendered.finite,loopDelta:rendered.loopDelta,strictLoopClosed:rendered.loopClosed};
  if(row.loop&&rendered&&!rendered.loopClosed)row.notes+=' 原始循环首尾存在小量差异，当前保留原曲线。';
  const group=groups.get(row.groupId)??{id:row.groupId,name:row.name.split('·')[0],category:row.category,clipIds:[],loopIds:[]};
  group.clipIds.push(row.id);
  if(row.phase==='start')group.startId=row.id;else if(row.phase==='end')group.endId=row.id;else if(row.phase==='loop')group.loopIds.push(row.id);
  groups.set(row.groupId,group);
}
const released={...manifest,groups:[...groups.values()],summary:{clips:manifest.clips.length,groups:groups.size,frames:audit.clips.reduce((n,c)=>n+c.frameCount,0),
  characterClips:manifest.clips.filter(c=>c.sourceKind==='character').length,sharedClips:manifest.clips.filter(c=>c.sourceKind==='shared').length}};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(released,null,2));
console.log(JSON.stringify(released.summary));
