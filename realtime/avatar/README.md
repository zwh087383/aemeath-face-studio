# 实验性人物联调：Claude 自然动作 + 字幕旁路

分支：`codex/experimental-avatar-integration-20261015`。

**这是实验性本地接线。** 本轮把 Claude 已完成的自然动作控制器、人物骨骼绑定、八种表情，与流式字幕 Worker 旁路和 PCM 调度器接入同一个真实 PMX 画面。它不连接 Qwen、不打开麦克风；音频来自仓库样例，口型沿用这段音频对应的离线 Audio2Face 曲线。输入框中的测试字幕是独立输入，不是该 WAV 的转写。

## 运行

从 face 仓库根目录运行（Node.js 20+）：

```powershell
# 首次使用且 preview/node_modules 不存在时安装仓库锁定依赖
npm ci --prefix preview
node realtime/avatar-server.mjs --port 18768
```

打开 [人物联调页面](http://127.0.0.1:18768/avatar/)。服务仅监听本机回环地址，旧工作室和 `/lab/` 代码保持原样。

1. 点击“开始字幕联动”，她会播放样例语音；测试字幕每次两字输入旁路，规则选择表情与动作。
2. 点击“打断 · 倾听”，立即撤销本轮音源与未来提示，收口、收势，转向倾听姿态。
3. “暂停 / 恢复”保留本轮播放进度；“换一轮回复”建立新身份，旧轮字幕与动作失效。
4. “四种手势巡览”依次显示挥手、解释、耸肩、抚胸。手工表情与短动作按钮也经过统一调度器。
5. 可切换脸部、上身、侧前视角。打开“模拟短暂断流”后重新开始，检查缓冲时嘴型和语义动作冻结、续包恢复。

大动作有占槽与冷却，正在忙碌时新动作可能跳过。不要期待快速连点能够排成一串表演。自然呼吸与微动可关闭；衣发物理始终关闭。

## 本分支特点

- **一个音频播放器、一条播放时钟、一个渲染循环。** `AvatarSession.sync()` 获取真实 Web Audio 媒体时间，调度表情/动作，外层用同一时间采样嘴型。
- **字幕分析不在音频等待链上。** 模块 Worker 异步选预设。Worker 慢、坏或超时只停用旁路；音频不等待分析。表现仍有本机 CPU/渲染成本，不能称为零开销。
- **沿用 Claude 的动作实现。** 通过新桥接模块调用原控制器和 `MotionRig`，没有改写动作曲线、骨骼算法或旧工作室。取消后自然收势按本地时钟继续，不受已停止的音频时钟卡住。
- **修正调度占用范围。** 手臂行程会延长动作准备/收回段，身体槽按最慢伸缩和速率留足上界，避免旧名义时长导致动作重叠。此入口锁定速度为 1。
- **处理自然播完后的尾巴。** 音频结束只通知控制器一次；未完成动作可以自然收尾，主动取消或下一轮开始时仍能收回。
- **完整回复归属。** 字幕、音源、表情和手势共用 `(connectionId, responseId, epoch)`。取消后旧异步恢复结果、旧字幕、旧动作不得影响新轮。
- **一处骨骼写入。** 面部的头部短动作传入身体控制器统一合成，关闭另一套头部摇摆；保留自然呼吸，关闭独立音量触发的自动大手势，避免字幕规则与自动节拍同时抢动作。

```text
本地样例 PCM ──→ StreamingAudioTransport ──→ Web Audio
                           │ 实际媒体时间
                           ├──→ LipTrack → FaceController → morph
测试字幕增量 → Worker → RealtimeScheduler → Face / MotionController
                                              │
                                              └──→ MotionRig → PMX 骨骼 → 渲染
打断 → 停音源 / 撤销字幕与队列 / 本地时钟收势 / 倾听
```

八种表情：自然、浅笑、开心、好奇、认真、惊讶、害羞、俏皮。
五种短动作：点头、摇头、歪头、侧看、眨眼。
四种身体手势：挥手、解释、耸肩、抚胸。

## 文件与接线接口

| 文件 | 职责 |
| --- | --- |
| `controller-bridge.mjs` | 原控制器适配、自然结束尾巴清理、身体槽时长上界 |
| `session.mjs` | 单播放器、字幕 Worker、统一归属、PCM 模拟投递与生命周期 |
| `viewer.mjs` | 加载 PMX/曲线、单 RAF、真实 morph/骨骼写入与测量 |
| `index.html` / `style.css` | 人物演示与诊断界面 |
| `../avatar-server.mjs` | 只读本地服务，按需挂载模型、曲线、Three 依赖与原控制器 |
| `../tests/avatar-*.test.mjs` | 桥接、会话和服务回归 |
| `../browser-avatar-*.cjs` | 真实浏览器控制链、字幕链、断供、画面与性能验收 |

`window.avatarLab` 只用于本地验收/演示：`start(options)`、`pause()`、`resume()`、`cancel(reason)`、`enqueue(cue, owner)`、`pushSubtitle(delta, options)`、`finishSubtitles(owner)`、`snapshot()`、`measure(seconds)`。字幕是增量；默认由会话按 item 维护连续序号。默认 `start()` 使用界面选项；脚本传入显式选项时，需设置 `autoSubtitles: true` 才会自动喂测试字幕。

本轮发布必要的现有控制器依赖和其测试，不把共享目录中其他未交接的工作室页面改动混入提交。原 PMX、音频与离线曲线未修改；没有 WAI 业务接线或运行数据迁移。

## 验证与边界

本轮实测与证据见 [VALIDATION.md](VALIDATION.md)。复跑 Node：

```powershell
node --test realtime/tests/*.test.mjs tests/controller.test.mjs tests/motion.test.mjs
```

浏览器脚本使用 Playwright CLI，各 part 独立运行，结果写入页面的 `__avatarAcceptance`、`__avatarSidecar`、`__avatarVisual`。实际命令和本机证据位置见验证记录。

后续接真实双工服务时，必须把允许播放的助手输出 PCM 与其输出字幕绑定到同一个回复身份，沿用当前音频通道的真实播放时间。不能直接让此演示继续喂本地 WAV，同时声称它在播放模型音频。新语音还需要在线口型分析或视位映射；当前预计算嘴型只适配仓库样例。字幕时间锚点是句段近似，尚无词级动作峰值保证。

动作自然度与衣发接触仍需美术调参。自动验收的骨骼有限值、真实权重变化与状态收口时间不能证明所有视角无穿模，也不能替代扬声器物理停声测量。
