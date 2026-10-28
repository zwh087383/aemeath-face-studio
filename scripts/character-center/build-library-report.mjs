import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CHARACTER_CATALOG as catalog } from '../../realtime/character-center/catalog.mjs';

// Source metadata only. The report never embeds motion curves, user transcripts,
// credentials, model prompts, screenshots, or private asset bytes.
const out = 'outputs/library-expansion-20261027';
const read = async name => { try { return JSON.parse(await fs.readFile(name, 'utf8')); } catch (e) { if(e.code==='ENOENT')return null; throw e; } };
const input = {
  activity: `${out}/activity-final-76-v2.json`,
  held: `${out}/activity-held-variants-v3.json`, micro: `${out}/activity-micro-permissions.json`,
  native: 'outputs/library-expansion/native-target-final.json',
  nativeWeak: 'outputs/library-expansion/native-weak-seat-fixture.json',
  nativeSit: 'outputs/library-expansion/native-sit01-seat-fixture.json',
  nativeCalibration: 'outputs/library-expansion/native-load-calibration-invariance.json',
  controls: `${out}/browser-controls.json`, performance: `${out}/performance-comparison-final.json`,
  movementPerformance: `${out}/performance-movement-final.json`,
  nativePreparationPerformance: `${out}/performance-native-complete.json`,
  historicalPerformance: `${out}/performance-comparison.json`, resourceFollowup: `${out}/performance-resource-followup.json`,
  furniture: `${out}/activity-furniture-entry.json`,
  conversation: `${out}/browser-conversation.json`, supported: `${out}/browser-supported-variants.json`,
};
const data=Object.fromEntries(await Promise.all(Object.entries(input).map(async([key,file])=>[key,await read(file)])));
const browserFiles=(await fs.readdir(out)).filter(n=>/^browser-.*\.json$/.test(n));
const browserCases=[];
for(const name of browserFiles){const d=await read(`${out}/${name}`);for(const row of d?.cases??[])browserCases.push({...row,evidence:name,at:d.at});}
browserCases.sort((a,b)=>String(a.at).localeCompare(String(b.at)));
// Deliberate cancellation is a different successful test, not a failed attempt
// to complete the behavior. Preserve both evidence kinds independently.
const browserById=new Map(browserCases.filter(r=>!r.scenario?.startsWith('cancel-')).map(r=>[r.id,r]));
const cancelledCases=browserCases.filter(r=>r.scenario?.startsWith('cancel-'));
const nativeById=new Map((data.native?.groups??[]).map(r=>[r.id,r]));
const activities=new Map((data.activity?.rows??[]).map(r=>['activity:'+r.id,r]));
const safe=x=>String(x??'').replaceAll('|','／').replaceAll('\n',' ');
const rows=catalog.actions.map(action=>{
  const browser=browserById.get(action.id),native=nativeById.get(action.id),activity=activities.get(action.id);
  let verification='待补本轮验收';
  if(native?.passed)verification='真实来源＋PMX 骨骼、阶段/打断通过';
  if(activity?.execution?.accepted&&activity.execution.done&&!activity.execution.reason)verification='实际控制器＋PMX FK＋道具回执通过';
  if(browser?.terminal?.type==='action_completed')verification=verification==='待补本轮验收'?'浏览器实际模型完整执行通过':verification+'；浏览器完整执行通过';
  if(browser&&browser.terminal?.type!=='action_completed')verification+='；最近浏览器未通过：'+(browser.terminal?.reason??browser.error??'没有完成回执');
  if(action.executor==='control'&&data.controls?.pass)verification='真实浏览器活动开始/暂停/恢复/完成/撤销通过';
  const variants=Object.keys(action.variants??{});
  return {id:action.id,label:action.label??action.name,executor:action.executor,requires:action.requires,effects:action.effects,
    source:action.source??{kind:'native',family:action.sourceFamily},duration:action.durationContract,variants,
    verification,browser:browser?{evidence:browser.evidence,at:browser.at,terminal:browser.terminal}:null,
    browserCancellations:cancelledCases.filter(r=>r.id===action.id).map(r=>({scenario:r.scenario,passed:r.passed,evidence:r.evidence,at:r.at})),
    native: native?{passed:native.passed,sourceMatched:native.sourceMatched}:null,
    activity:activity?{done:activity.execution?.done,status:activity.execution?.status}:null,
    continuousHumanReview:'待人工连续审阅；自动验收不替代观感'};
});
const excluded=catalog.nativeInventory.filter(r=>r.policy.scope!=='single-character').map(r=>({id:r.groupId,name:r.name,source:r.sourceFamily,policy:r.policy,clips:r.phases.length}));
const report={generatedAt:new Date().toISOString(),catalogHash:catalog.hash,cloudCalls:0,coverage:catalog.coverage,
  motionClips:catalog.nativeInventory.reduce((sum,r)=>sum+r.phases.length,0),actions:rows,excluded,
  evidence:Object.fromEntries(await Promise.all(Object.entries(input).map(async([key,file])=>[key,{file,available:!!data[key],
    sha256:data[key]?createHash('sha256').update(await fs.readFile(file)).digest('hex'):null}]))),
  limits:['组件指令由测试脚本明确输入，不是云端模型自主选择。','自动数值与浏览器完成回执不能证明每一个视角的衣发都没有穿插。','音频测试使用本地预缓冲音频，不代表真实云端流式网络或扬声器听感。','取消旧命令不等于身体立即停住：坐姿等原生行为会完成必要源阶段，具体剩余秒数见性能和原生验收报告。']};
await fs.writeFile(`${out}/library-acceptance.json`,JSON.stringify(report,null,2)+'\n');
const lines=['# 完整动作库逐项目录与验收','',`目录版本：\`${catalog.hash}\`。生成时间：${report.generatedAt}。本轮云端调用：0。`,
  '',`共 ${rows.length} 项可调用能力：${catalog.coverage.conversation} 项原交流、${catalog.coverage.activities} 项生活活动、${catalog.coverage.nativeRegistered} 组原生行为、${catalog.coverage.supported} 项新接触动作与 ${catalog.coverage.controls} 项活动控制。原生来源 ${catalog.coverage.nativeSources} 组、${report.motionClips} 段。控制指令、原生阶段、同源 Loop 别名不重复算作新动作。`,
  '', '本表的“通过”必须按其证据范围理解。PMX 骨骼/握点检查、浏览器完整执行、最终连续观感是三件事；最后一项保留人工审阅。普通当前现场执行不会自动布置道具，单项预览才会明示并执行前置布景。',
  '', '| 行为 | 执行方式 | 开始条件 | 可选变体 | 本轮证据 |', '| --- | --- | --- | --- | --- |',
  ...rows.map(r=>`| ${safe(r.label)} · \`${r.id}\` | ${r.executor} | ${safe(JSON.stringify(r.requires))} | ${r.variants.map(safe).join('、')} | ${safe(r.verification)} |`),
  '', '## 保留索引、没有开放的来源', '', '这些项目不进入模型可调用目录。禁止项仍受策略校验；缺少其它角色、载具或特殊环境的来源没有伪装成单角色动作。',
  '', '| 来源 | 片段数 | 范围及原因 |', '| --- | --- | --- |',
  ...excluded.map(r=>`| ${safe(r.name)} · \`${r.id}\` | ${r.clips} | ${safe(JSON.stringify(r.policy))} |`),
  '', '## 完整记录', '', '本机完整记录保存在 `outputs/library-expansion-20261027/library-acceptance.json`；逐次原始失败结果仍保留。源代码仓库只包含本表和测试工具，不包含游戏私有资源、音频、模型记录或运行数据。',
  '', ...report.limits.map(x=>'- '+x), ''];
await fs.writeFile('docs/full-motion-library-catalog-and-acceptance-20261027.md',lines.join('\n'));
console.log(JSON.stringify({catalog:catalog.hash,actions:rows.length,excluded:excluded.length,pending:rows.filter(r=>r.verification.startsWith('待补')).map(r=>r.id),browserUnresolved:rows.filter(r=>r.browser&&r.browser.terminal?.type!=='action_completed').map(r=>r.id)}));
