# 实验性分支：流式字幕表情与动作旁路

分支：`codex/experimental-subtitle-sidecar-20261015`。

**这是实验性实现，不是已完成的 Qwen 实时角色集成。** 它验证“语音独立播放，字幕异步选择表情和动作”的本地路径。当前已连接本目录的 `RealtimeScheduler`；浏览器验收端记录动作命令，未修改 Claude 的人物渲染或动作文件。此批同时发布此前尚未提交的独立调度器、PCM 播放器和验收台，作为旁路的必要依赖。

## 此分支的特点

- 参考 N.E.K.O. 的语义过滤、动作白名单、强度和冷却思路，独立编写中文规则；没有复制其完整动作资源或引入模型请求。
- 完整短句在浏览器模块 Worker 中分析。主线程只校验有界输入并投递消息，PCM 接收与播放不等待分析结果。
- 只输出现有八种表情、五种面部短动作和四种身体手势。每个句段最多一个表情加一个动作；低置信表达可不动作。
- 否定、条件假设、过去叙述、第三方、引文和指令讨论尽量过滤。保留未闭合句段，避免将“我不”与“会挥手”分成两个可执行单元。
- 使用可信宿主绑定的 `(connectionId, responseId, epoch)`，以字幕闭合输入时的播放进度作为动作锚点；迟到结果丢弃，不挪到现在补演。
- 分析超时、异常、序号缺失、输入溢出只停用当前旁路；不暂停语音、不调用音频取消。打断仍由统一调度器负责停音频、清队列、收势和恢复倾听。

## 默认规则与限制

| 项目 | 当前约定 |
| --- | --- |
| 表情 | neutral / smile / happy / curious / focus / surprise / shy / playful |
| 面部短动作 | nod / shake / tilt / glance / blink |
| 身体手势 | wave / explain / shrug / chest |
| 强度档 | gentle / balanced / lively，规则输出限制在 0.2–0.8 |
| 动作最小间隔 | 3 秒；同动作 8 秒；同表情 6 秒 |
| 普通谈话手势 | 仅满足规则的句段可尝试 explain，冷却 12 秒 |
| Worker 超时 | 1.2 秒，当前回复旁路停用，下一回复可重建 |
| 单次字幕增量 | 最多 1024 个 UTF-16 码元 |
| 单回复 | 最多 16384 码元、256 个增量、8 个字幕 item、64 个句段、24 个已入队提示 |
| 未闭合句段 | 最多 512 码元；超过上限停用，不截断后猜测语义 |
| 等待队列 | 最多 32 个输入增量，单 Worker job 在途 |

这里的“冷却”是本地墙钟节流，最终是否派发仍取决于调度器的播放状态、媒体时间、槽位和过期检查。暂停或断流不派发动作。`providerDone` 不等于播放器已经播完。

旁路实例应在会话内复用，保持跨回复冷却；实验台也是如此。中文句号、问叹号、分号和换行可闭合句段，逗号不拆段。英文句点 `.` 为保护小数和缩写，保留到强标点或 `finish()` 再判断。

示例：“我轻轻点头。”选择 nod；“我不会挥手。”不挥手；“如果成功，我就挥手。”不立即执行；“他刚才摇头了。”不让角色模仿第三方。用户说“请挥手”，角色只回答“好的”，也可从同轮可信 `userText` 补充动作。**规则并非通用中文理解器**：省略、反讽、多重否定、复杂转述和陌生表达仍可能漏选或误选；这里只允许小幅、有限的角色表现。

## 接入方式

音频和字幕使用两条独立消费路径。宿主必须先确定允许播放的回答身份，再绑定旁路；不能把监听会话草稿或旧回调重新标为当前回复。

```js
import { SubtitleSidecar } from './subtitle-sidecar.mjs';

const sidecar = new SubtitleSidecar({ scheduler });

function beginReply(owner, userText) {
  // 替换旧回复的停音频/收势由 scheduler 的同步 sink 执行。
  if (!scheduler.begin(owner)) return false;
  if (!audio.begin(owner.epoch, { sampleRate: 24000 })) {
    scheduler.interrupt({ ...owner, reason: 'audio_begin_failed' });
    return false;
  }
  sidecar.begin(owner, { userText, profile: 'balanced' });
  return true; // 不等待 Worker；其失败不阻止音频开始。
}

function onAudioDelta(owner, sequence, pcm) {
  // 使用既有音频路径；append 拒绝时保留原有回压/错误处理。
  return audio.append({ epoch: owner.epoch, sequence, samples: pcm });
}

function onAssistantTranscriptDelta(owner, itemId, sequence, text) {
  // sequence 是该 item 从 0 开始的连续增量序号，text 是增量而非累计全文。
  return sidecar.push({ ...owner, itemId, sequence, text });
}

function onAssistantTranscriptDone(owner) { sidecar.finish(owner); }

function onBargeIn(owner) {
  sidecar.cancel(owner); // 丢弃尚未返回的分析。
  scheduler.interrupt({ ...owner, reason: 'barge_in' }); // 清除已经入队的动作并停音频。
}
```

宿主继续按已有约定将真实 `audio.snapshot()` 送入 `scheduler.playback()` 并持续 `tick()`。`sidecar.cancel()` 本身不拥有音频，也不撤回已交给调度器的提示，不能替代统一 `interrupt()`。

Qwen 接线时应消费**助手输出音频对应的流式转写**。本次没有接入任何具体服务事件、API 参数或收费模型；以上方法是提供方无关的接口，不是未经验证的 Qwen SDK 示例。若服务只在整句末尾给文本，或生成端字幕明显领先/落后实际播放，这个接入点需要额外的对应关系；当前只能做句段近似时机，不能保证词级对齐。

## 运行和验收

```powershell
node realtime/serve.mjs --port 18767
node realtime/subtitle-acceptance.mjs
playwright-cli -s=face-subtitle open http://127.0.0.1:18767/lab/ --browser=chrome
playwright-cli -s=face-subtitle run-code --filename=realtime/browser-subtitle-acceptance.cjs
```

页面的测试字幕与 WAV 是两个独立输入，不把任意测试台词当作音频转写。验收包含旁路关闭/开启对照、Worker 回包延迟 800 ms、丢弃 Worker 回包、分片否定、回复替换和打断。

Node 验收结果写到 `outputs/subtitle-sidecar-20261015/<UTC时间>/`，浏览器脚本的结果对象由脚本末尾注明。测量范围与本次结果见 `VALIDATION.md`。

## 尚未覆盖

- 真实 Qwen 连接、麦克风、网络波动和服务端字幕/音频对应关系。
- Claude 角色执行端实际接线、PMX 渲染帧率、自然收势、穿模和口型与真实新语音匹配。
- 扬声器物理出声延迟；Web Audio 时钟和源节点停止只证明本地 API 行为。
- 多语言语义理解、音素/词级动作对齐与大规模真实对话质量。

因此“语音不等待旁路”是实现的依赖关系与本地验证结论，不能表述为所有设备上“零开销”或生产可用。
