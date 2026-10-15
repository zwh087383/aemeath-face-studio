# 实时动作调度与打断验收

> **实验性分支** `codex/experimental-subtitle-sidecar-20261015`：现已增加流式字幕 Worker 旁路，依据本地中文规则选择表情和动作，直接接入本目录调度器，语音路径不等待分析结果。分支特点、接口与已知限制见 [EXPERIMENTAL.md](EXPERIMENTAL.md)，验证证据见 [VALIDATION.md](VALIDATION.md)。尚未接入真实 Qwen 服务或人物执行画面。

这是一套独立的本地调度器、PCM 流式播放器和验收台。它负责把完整动作提示对齐到实际播放时间，并在插话、回复替换或执行失败时撤销旧动作和音频。所有新增代码位于 `face/realtime/`，没有接管 Claude 正在修改的角色工作室。

当前页面用现有中文 WAV 模拟分块网络输入，真实使用浏览器 Web Audio 播放；身体动作执行端暂时记录命令。它能验证播放、时间线和打断控制，人物手臂的实际收势效果留给双方完成后的联合测试。

## 启动与检查

在 face 根目录执行，要求已有 Node.js 20+，无需新增依赖：

```powershell
node realtime/serve.mjs --port 18767
```

打开 [独立验收台](http://127.0.0.1:18767/lab/)。点击开始后才播放，默认音量12%。可选择20/40ms音频块、快速投递、模拟断流，操作暂停、恢复、打断和新回复替换。服务仅绑定宿主机回环地址，与工作室的18765端口分开。VM 内回环地址指向VM自身。

```powershell
node realtime/run-acceptance.mjs
```

此命令运行独立 Node 测试、调度计算微基准并记录测试前后源码哈希，结果存到 `outputs/realtime-scheduler-20261014/<运行时间>/`，不覆盖旧结果。纯计算测试使用模拟时钟与执行端，不包含音频设备或人物渲染。

浏览器脚本 `browser-acceptance.cjs`、`browser-benchmark.cjs` 是 Playwright CLI 的 `async page => { ... }` 表达式。启动服务后，从证据目录使用已安装的 playwright-cli 运行：

```powershell
playwright-cli -s=face-realtime open http://127.0.0.1:18767/lab/ --browser=chrome
playwright-cli -s=face-realtime run-code --filename=../../../realtime/browser-acceptance.cjs
playwright-cli -s=face-realtime run-code --filename=../../../realtime/browser-benchmark.cjs
```

上述相对路径以 `outputs/realtime-scheduler-20261014/browser/` 为当前目录。验收结果分别保存在浏览器 `window.__realtimeAcceptance`、`window.__realtimeBenchmark`；通过CLI `--raw eval`读取对象即可保存JSON。验收脚本覆盖完整输入提前结束、暂停恢复、未来音源清理、旧事件拒绝、断流恢复和错误收集；基准脚本覆盖三个模拟动作阶段的打断，并持续采样30秒，期间替换回复保持播放负载。

## 模块职责

| 文件 | 作用 |
| --- | --- |
| `scheduler.mjs` | 回复身份、播放时钟、动作时间线、槽位冲突、过期、取消与故障状态 |
| `stream-audio.mjs` | 连续PCM排程、实际媒体时间、暂停偏移、缓冲回压、取消与迟到回调隔离 |
| `controller-sink.mjs` | 与既有 FaceController / MotionController 方法对接的可选适配器，以及完整工具JSON入口 |
| `subtitle-rules.mjs` | 中文语义过滤、八种表情与受限动作选择、强度档 |
| `subtitle-worker.mjs` | 流式字幕句段缓冲与独立线程规则分析 |
| `subtitle-sidecar.mjs` | 身份与序号校验、有界队列、原始播放锚点、节流、过期和 Worker 故障隔离 |
| `CONTRACT.md` | 输入、输出、时间单位和接入约定 |
| `lab/`、`serve.mjs` | 独立浏览器页面和仅提供本目录/样例音频的本地服务 |
| `tests/` | 身份、时序、故障、流式音频与适配器的确定性回归 |

## 回复和动作的身份

一条播放实例由 `{connectionId,responseId,epoch}` 完整标识。上游确认这是允许播放的回答之后，显式调用 `begin()`。不要看到任意 `response.created` 就自动绑定，更不要把监听会话的草稿当成回答。跨连接可以出现相同 responseId，因此三项都要核对。

`epoch` 是本地单调增加的播放代次。新回复或重新定位创建新代次；网络回调必须携带最初绑定的完整身份，不能在旧事件到达时附上“当前epoch”。旧回复、重复ID、未知动作、非法强度和迟到事件会被拒绝。单代次去重表达到上限后拒绝新事件，不通过遗忘旧ID让旧动作重新执行。

```js
const owner = { connectionId: 'reply-connection-1', responseId: 'response-1', epoch: 1 };
const scheduler = new RealtimeScheduler({ clock: () => performance.now() / 1000, emit: sink });
if (!scheduler.begin(owner)) throw new Error('Reply could not begin');
// 必须在scheduler清理完旧回复之后再建立新音源。
if (!audio.begin(owner.epoch, { sampleRate: 24000 })) scheduler.interrupt(owner);

scheduler.enqueue({ ...owner, id: 'cue-1', kind: 'gesture', gesture: 'explain', at: 1.5, strength: .6 });
// 播放器每次报告真实位置后，调度器才决定是否派发。
const p = audio.snapshot();
scheduler.playback({ ...owner, status: p.status, time: p.time });
```

默认动作是 `wave/explain/shrug/chest`，兼容现有 `nod/shake/tilt/glance/blink` 和八种表情名。默认动作元数据来自交接时的动作配置，属于可替换的样例目录。动作运行速度、准备距离和收势时间依赖角色当前姿态；最终接线应通过 `catalog` 传入校准后的时长/重点时刻/占用槽位，或扩展执行端忙闲反馈。不能凭固定元数据承诺词级精确同步。

`enqueueToolCue(scheduler, owner, tool)` 只接受完整的 `avatar_cue` JSON，工具输出里的连接ID、epoch和未知字段会被拒绝。工具callId用于去重，身份由可信接收上下文提供。它是本地约定的工具负载入口，不包含Qwen WebSocket、模型参数设置或自动工具续推；实际服务事件要在上游确认完成后转换。

## 播放和打断语义

- `providerDone()` 只记录服务端生成完成。音频缓冲未消耗完时，语音和动作仍可继续；只有实际播放器报告 ended 才结束本地时间线。
- 音频输入饥饿时媒体时间停止；连续 buffering 快照偶尔会记录增加的真实媒体位置，因为一小块音频可能在两次RAF之间播放完。调度器接受这种播放证据，但在buffering状态不启动动作，之后恢复播放仍检查过期。
- 暂停先切断当前和未来音源，保存PCM消费位置，并暂停语义进度；恢复同一代次继续剩余PCM。最终取消则清空队列与旧PCM，同代次不可恢复。
- `interrupt()` 同步发出 stop_audio、retract、listening。身体收势使用本地墙钟继续运行，不能依赖已停止的音频时间。是否真的自然收回，由动作执行端的后续画面验收确定。
- 音频节点或执行端清理失败进入 fault；仍尝试其余清理动作，停止接受新回复。宿主完成真实清理后才可显式恢复调度器，并开始更高epoch。不能收到云端取消确认就假定本地音频已经停止。
- 播放中超过0.5秒没有新播放快照，`tick()`会触发看门狗取消。宿主应持续调用tick，并在页面隐藏、连接关闭和播放器fault等事件中主动打断；此库不能在JavaScript主线程完全阻塞时替宿主执行取消。

流式播放器要求从0开始连续的PCM sequence。超出缓冲/保留内存上限时append返回false，不消耗序号；生产接收端应暂停喂入并在空间释放后重试同一包。其他无效数据不能静默跳过。样例页输入短于缓冲容量，任何append拒绝都会终止演示并报错。

## 与 Claude 动作侧的接入交接

本阶段不改 `preview/core`、`preview/studio`、package、既有tests/scripts/README，也不占用Claude的证据目录。`createControllerSink({audio,face,motion})` 可在动作侧交付后使用，它会将buffering映射为现有控制器的paused，按kind把动作分别交给面部或身体控制器，并用墙钟执行cancel。

双方联合测试前，需要完成以下接线并确认所有权：

1. 保留原始样例演示，新增实时输入模式；只让一种音频transport驱动当前角色，不能两个播放器同时写epoch或骨骼。
2. 先让scheduler撤销旧回复，再建立新PCM流；保留最新owner，按实际播放快照同步两个控制器。stop/retract/posture均核对代次，避免旧清理触碰新回复。
3. 身体控制器持续update以完成墙钟收势；面部口型按实际播放位置采样。实时新语音的口型需要对应曲线或在线分析，不能把现有样例口型曲线套给不同音频。
4. 导入校准后的动作目录，检查伸长准备/收势、手势互斥、动作选项速度与自动语气动作的占用冲突。当前调度器的body槽位只管理由它派发的动作，并不知道角色里其他来源的手动/自动手势。
5. 同一段语音测试实时20/40ms输入、短断流、暂停恢复、新回复替换；在准备/重点/收回阶段分别打断，从正面和侧面录像检查穿模、跳姿与旧动作复活。

当前Qwen服务和麦克风未连接。现有真实模型实验可作为之后的接线参考，但本目录的自动验收不调用收费模型或加载凭据。

## 如何解释证据

Node结果是纯逻辑与模拟AudioContext回归；浏览器结果是真实Web Audio API与媒体时钟行为；阶段标签代表模拟动作时间，页面里的retract是命令记录。停止处理耗时不等于扬声器声学延迟，独立页面帧间隔不代表加载PMX后的渲染帧率。联合人物画面与实时云端验收需要各自单独通过。
