# 记忆优先快答与连接预热：D 双工实验

**实验性，当前没有证实快答能降低语音端到端延迟。** 配套 WAI 分支：`codex/experimental-voice-memory-fast-20261017`。本分支同名。当前结果见 [MEMORY-FAST-VALIDATION.md](MEMORY-FAST-VALIDATION.md)；原 D 实验记录 `VALIDATION.md` 保留为历史证据。

本次增加三个可选通道：完整前置+原连接、完整前置+连接预热、记忆快答+连接预热。快答复用 WAI 现有 `DONE/HANDOFF` 文本协议：本地记忆、最近对话和人设先交 `deepseek-flash`，`DONE` 经程序校验后让 Qwen 口播并输出原生动作；`HANDOFF` 或校验未通过时复用后台解析进入完整路径。后台解析仍在运行，快答模型与 Qwen 是两次串行调用，延迟和用量均不能省略。

连接预热只提前创建空白回复会话，不填用户资料、不提前生成。最终上下文到达后更新配置、批量发送历史，并等待每个准确的历史确认，再发起一次生成。同一回复连接只消费一次。

## 特点

- 持续 Qwen `smart_turn` 监听与带 WAI 上下文的回复分为两个会话；回复时输入继续。
- 最终语音转写进入真实 WAI 预处理、EmbeddingGemma 2 / Qdrant 记忆检索、人设和已送达上下文。
- 同一回复响应尝试同时输出语音与原生 `perform_avatar`。模型只选八种表情之一及现有动作；强度固定 0.65，关节和速度由原动作库控制。
- 本地声音检测先暂停，云端有效轮次确认后撤销；迟到音频和动作不能复活旧回复。
- 完整 WebAudio 播放帧数确认后才结算 WAI 助手历史；输入历史独立保留。
- 可以离线回放本批真实 PCM 和工具指令，并再次测试本地打断，不新增模型调用。

## 启动

WAI 使用其现有 `scripts/Workspace.ps1 -Side host -Action Setup -Extras` 环境和机器私有配置。face 的渲染依赖按 `preview/package.json` 安装，PMX 和贴图按原项目说明在本地放置。

```powershell
# 从 face 仓库运行。参数必须是本机明确选定的目录。
.\realtime\duplex\Start-Duplex.ps1 -WaiRoot <WAI-checkout> -DataDirectory <empty-machine-local-dir> -OutputDirectory <approved-output-batch-dir>
```

默认端口仍为 18772，可通过 `-Port` 指定。当前本地报告为 `http://127.0.0.1:18776/duplex/fast-results.html`，人物页为 `/duplex/`。启动辅助脚本先检查本地 embedding，再生成本地用户问题素材并启动服务。打开页面不会发起云端生成；点击“连接语音”才开始监听。

启动参数 `-MaxTurns`、`-MaxResponses`、`-BatchId` 必须对应明确批准的批次；默认上限仍是 8 次 WAI 回复、16 个 Qwen 实时响应。失败计入，取消用量缺失即停，旧 ledger 不清空。`DataDirectory` 必须在共享源码之外；不要通过换目录或提高限额绕过未知用量暂停。本轮预声明三组合计上限为 12/26，实际在 10/21、未知 1 时停止全部后续云端调用。

自动化：设置 `window.__duplexCase={name,input,variant,mode,directory}`，再用 `playwright-cli -s=duplex run-code --filename=realtime/browser-duplex.cjs`。`variant` 为 `full-cold`、`full-warm` 或 `memory-warm`；`normal` 等到真实播放送达；`barge` 在生成完成、仍在播放时送入另一段问题；`cancel` 在生成中取消。脚本没有自动重试。

离线回放验收先断开实时连接，再设置 `window.__duplexReplayConfig={index,directory}`，运行 `realtime/browser-duplex-replay.cjs`；`browser-duplex-interrupt-record.cjs` 保存真实事件回放中途打断的录像。`fast-audit.py` 只读取本地证据，不请求模型。

## 特殊性

这次是“真实 WAI 和云端回复＋隔离合成记忆＋本地合成用户语音”的受控实验。快答采用文本模型现场生成短答，再由 Qwen 严格口播；完整路径由 Qwen 自由回复。持续麦克风入口存在，但自动测量不等于真实扬声器回声、真实人声远场或网络波动验收。

监听会话会产生一个被隔离的简短文本响应，其用量也计入。WAI 原有分类、认知重构、维护等调用另外存在，实时 token 合计不是全部费用。

工具调用接收/入队不等于动作已经展示。报告区分首 PCM、实际 WebAudio 开播、渲染观察、最终播放确认。口型由音频特征驱动，不是音素识别；一条表情/动作计划也不意味着逐词重音或精确语义时间轴。

本轮不启用后台自主行为、摄像头和 Neo4j。日记、记忆维护是否实际发生以队列和持久化证据为准，不把“代码接通”写成所有可选能力均已验收。

旧实验在“我。”处断句后增加了最多 1.2 秒的窄范围悬句合并。本轮再次调用云端发现，长句也能在语义看似完整的“绘制步骤”处提前分段，该保护没有覆盖这种情况。后半句取消回复且用量为空，故本轮真实插话接续未通过。另一次约三分钟空闲后监听会话报告 `provider_error`；没有用量未知，保留记录并确认清理后重新连接。连接长时保活和断句可靠性仍未解决。
