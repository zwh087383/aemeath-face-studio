# 实时调度独立接口

本目录由 Codex 实现，与 Claude 的 `preview/core`、`preview/studio`、现有 tests/scripts/package/README 分开。所有时间为秒。浏览器和 Node 共用原生 ESM，无额外运行依赖。此契约以随后的代码和测试共同校验，当前不改工作室接线。

## 调度器

`RealtimeScheduler` 从 `scheduler.mjs` 导出。构造参数 `{ clock, emit, catalog, maxQueue }`：clock 返回单调本地秒，emit 同步接收命令并返回 true（已接收）或 false（执行失败）；抛异常等同失败。默认仅记录命令不执行外部动作。

- `begin({connectionId,responseId,epoch,offset=0})`：绑定经上游确认的回复，epoch 正整数且严格递增。替换旧回复先打断旧代次。不会自动从任意 provider 事件绑定回复。
- `playback({connectionId,responseId,epoch,status,time})`：实际播放器快照，status 为 buffering/playing/paused/ended。时间不能回退；跳转通过新 epoch begin。返回 boolean。
- `enqueue({connectionId,responseId,epoch,id,kind='gesture',gesture?,action?,preset?,at?,apexAt?,strength=1})`：完整、已解析的语义提示，返回 `{accepted,reason,...}`。at 为准备开始，apexAt 为动作重点时刻，两者不可同时提供；省略表示在当前播放位置后一个短准备窗口执行。默认 gesture 为 wave/explain/shrug/chest；action 为 nod/shake/tilt/glance/blink；preset 为已有八表情。catalog 可注入角色真实 duration/apex/slot/cooldown。过期/重复/旧代次/未知动作拒绝。
- `interrupt({connectionId,responseId,epoch,reason='barge_in'})`：立即作废旧队列，发出 stop_audio、retract、listening 命令；不等服务器取消确认。清理失败保留 fault，禁止新回复直到显式确认恢复。旧事件不能启动已取消代次。
- `providerDone(identity)`：只记录生成结束，不能当作播放完成。
- `tick()`：检查播放器快照超时，处理可执行队列。播放时钟由 playback 推进，绝不根据收包或墙钟猜测。
- `recover()`：仅用于宿主已完成清理后显式解除 fault；必须重新 begin 新 epoch，不能复活旧代次。
- `snapshot()`：状态、当前身份、时间、队列数、fault、计数及有界事件记录。

命令结构 `{type, identity:{connectionId,responseId,epoch}, atWall, ...}`。type 为 begin、playback（status,time）、cue（cue）、stop_audio、retract、posture（posture）、provider_done。cue 适配为已有控制器格式（id,epoch,clock:'audio',kind,at,duration,strength,gesture/action/preset），调度器在触发点才交付，不预先让执行器持有未来队列。retract 使用墙钟继续收势；pause/buffering 冻结语义进度。

默认 leadSeconds=.06、lateTolerance=.2、watchdogSeconds=.5；播放中超过看门狗时间未提供新播放快照，会终止当前代次并同步发出清理请求。暂停不因墙钟经过而自动恢复。`catalog` 为以 `gesture:wave` 等为键的对象，值为 `{duration,apex,slot,cooldown}`；同槽仍忙或动作处于冷却时，已到期的新提示丢弃，避免积累过时手势。历史事件最多128条，排队默认64条，单代次去重默认4096个ID，去重满后拒绝新增而不遗忘旧ID。

显式暂停与缓冲之间转换也不能增加媒体时间；恢复时先报告同位置的缓冲/播放状态。连续两次buffering快照允许实际播放器报告单调增加的媒体位置，因为20ms分块可能在两次RAF之间完整播放并再次耗尽；此时仍不派发动作，恢复playing后按过期规则处理，不能用墙钟伪造播放进度。默认动作时长仅是本地样例元数据，Claude动作层会根据起始姿态拉长准备/收回；最终接入需传入校准数据或增加动作忙闲反馈，本版本不能保证精确重点对齐或完整覆盖姿态相关时长。

## 独立流式音频播放器

`StreamingAudioTransport` 从 `stream-audio.mjs` 导出，构造 `(AudioContext, {leadSeconds=0.04,maxBufferedSeconds=20,maxRetainedSeconds=120}={})`。

- `begin(epoch,{sampleRate=24000}={})`：递增 epoch，清旧源，建立空 PCM 流，初始 buffering。返回 boolean。
- `append({epoch,sequence,samples})`：samples 为 mono Float32Array，sequence 从0严格连续；拒绝旧代次/重复/缺包/NaN/超限，返回 boolean。网络层先解码，播放器不解释供应商消息。
- `play()`/`resume()`：异步恢复 AudioContext，带操作代次防迟到恢复；返回 boolean。只有显式调用才开始出声。
- `pause()`：切断正在播放及已排程节点，冻结媒体位置，保留剩余PCM供同代次恢复。
- `cancel()`：同步切断并清空旧PCM，不能同代次恢复。抛出/返回失败不得伪装成功。
- `finish(epoch)`：输入已结束；只在所有已接受PCM实际走完AudioContext时间后 ended，缺流状态为 buffering。返回 boolean。
- `snapshot()`：`{epoch,status,time,receivedDuration,queuedSeconds,sourceActive,sourceCount,context,finished,...}`。time 是媒体内容时间，饥饿时冻结，不把无声等待算进语音。status buffering/playing/paused/cancelled/ended/idle/fault。

PCM边界排程连续，pause/cancel要处理未来已排程源及异步resume/onended回调。统计是Web Audio提交和上下文时钟证据，不是扬声器物理声学测量。

## 验收边界

先用本地PCM分块和模拟语义事件验证独立链路；不调用收费模型，不访问麦克风，不修改Claude文件。角色适配和最终画面收势由双方交付后联合验证。独立页面只能展示事件和播放，不把示意条动画当作角色动作验收。
