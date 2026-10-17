# D 方案：记忆与连续双工实验

**实验性，不是稳定版承诺。** 配套 WAI 分支：`codex/experimental-qwen-duplex-d-20261017`。本分支同名。

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

默认页面 `http://127.0.0.1:18772/duplex/`，实测页面 `/duplex/results.html`。启动辅助脚本先检查本地 embedding，再生成本地用户问题素材并启动服务。打开页面不会发起云端生成；点击“连接语音”才开始监听。

一个批次最多 8 次 WAI 回复、16 个 Qwen 实时响应。失败计入，取消用量缺失即停，旧 ledger 不清空。`DataDirectory` 必须在共享源码之外；不要通过换目录或提高限额绕过未知用量暂停。

自动化：设置 `window.__duplexCase={name,input,mode,directory}`，再用 `playwright-cli -s=duplex run-code --filename=realtime/browser-duplex.cjs`。`normal` 等到真实播放送达；`barge` 在生成完成、仍在播放时送入另一段问题；`cancel` 在生成中取消。脚本没有自动重试。

## 特殊性

这次是“真实 WAI 和云端回复＋隔离合成记忆＋本地合成用户语音”的受控实验，不是原个人记忆库迁移，也不是固定回答配音。持续麦克风入口存在，但自动测量不等于真实扬声器回声、真实人声远场或网络波动验收。

监听会话会产生一个被隔离的简短文本响应，其用量也计入。WAI 原有分类、认知重构、维护等调用另外存在，实时 token 合计不是全部费用。

工具调用接收/入队不等于动作已经展示。报告区分首 PCM、实际 WebAudio 开播、渲染观察、最终播放确认。口型由音频特征驱动，不是音素识别；一条表情/动作计划也不意味着逐词重音或精确语义时间轴。

本轮不启用后台自主行为、摄像头和 Neo4j。日记、记忆维护是否实际发生以队列和持久化证据为准，不把“代码接通”写成所有可选能力均已验收。

实测还出现了 `smart_turn` 在“我。”处断句的问题。测试后补了一个窄范围保护：仅对这类孤立悬句最多等待 1.2 秒，将下一段原始转写一并交给 WAI；正常完整句子没有此等待。该补丁已通过离线事件回归，因本批取消用量未知，尚未重新调用云端验证。
