# 2026-10-15 人物联合验收

本轮验证真实 PMX 人物接线，区别于此前只记录命令的独立调度台。测试日期按宿主本地日期记录，原始证据 UTC 时间为 2026-10-16。机器为 Windows、Node 24、Headless Chrome 155，使用 NVIDIA GeForce RTX 5070 Ti Laptop GPU，Web Audio 48 kHz。没有调用云端、读取真实凭据或启用麦克风。

## 最终结果

| 范围 | 结果 |
| --- | --- |
| Node：realtime 全部专项 + 原 face/controller、motion 测试 | **166 通过，0 失败，0 跳过** |
| 实际人物控制链 | **20 项通过** |
| 30 秒实际播放与渲染性能窗口 | **2 项通过** |
| 真实字幕 Worker → 调度 → 人物，以及边界场景 | **24 项通过**，5 个独立 part |
| 实际画面 | 八种表情 + 四种手势正面/侧前，共 **16 张截图** |
| 页面操作演示 | 实际点击手势巡览、字幕联动和打断按钮，保存 WebM 画面记录 |
| 最终运行源码冻结 | **24 份运行源码/页面文件**前后 SHA-256 一致 |

浏览器自动验收合计 **46 项**。16 张截图与录屏另计，不混入断言数量。最终截图已人工查看：面部差异、头部短动作和四种上肢姿态可见，未发现数值爆炸或大面积手臂穿过躯干。静态截图不证明全过程无接触；衣发物理关闭，Claude 交付已提示的袖子/饰带与头发接触仍列为美术复核事项。

## 实际控制行为

- 八种表情写入真实 PMX morph，五种短动作检查实际 head quaternion 或眨眼权重；身体动作检查真实手腕位置，所有绑定齐全。
- 语音、嘴型、表情、身体共用回复 epoch 与媒体播放时间。暂停时媒体时间与语义动作年龄冻结、嘴型关闭；恢复不重播同一手势。
- 发声帧打断后源节点与调度/控制器队列清零，旧字幕和旧动作无法复活；真实 prepare、stroke、recover 阶段分别做了取消，观察到自然收势完成。
- 字幕专项没有调用手工 `enqueue`。分片否定“我不会”+“摇头。”不触发；肯定字幕经真实 Worker 输出 happy + wave，并观察到实际 morph 和骨骼变化。
- 断供专项由字幕触发抚胸，PCM 停供 1.2 秒；缓冲期间嘴闭、媒体时间及动作年龄冻结，恢复后同轮继续，动作只派发一次。
- 自动测试字幕暂停 900 ms 不继续输入；恢复后在同一回复继续。
- `ended_cancel` 与 `ended_replace` 均真实播完约 14.935 秒音频，再检查尚存的手势尾巴。前者可主动收回，后者立即换轮也会回收；旧字幕拒绝，新轮字幕可继续驱动。

独立肯定字幕测试从提交到观测到人物动作约 **194.1 ms**，包含调度提前量、Worker 消息和浏览器观测间隔；这是单次场景值，不是推理耗时分位数或逐词同步保证。

## 本机性能与打断

30 秒窗口在第 14、28 秒替换回复，持续供给同一段 PCM，保留自然呼吸和微动。四个身体大动作由调度器拥有，内部音量自动手势关闭。窗口中 300 次状态采样 **300 次 playing**，2482 个渲染帧；画布 757×648，DPR=1。

| 指标 | 本轮测量 |
| --- | ---: |
| 平均 RAF 画面帧率 | 82.72 FPS |
| 帧间隔 p95 | 20.00 ms |
| 驱动 CPU p95：同步、嘴型采样、面部、身体和骨骼写入 | 0.60 ms |
| 身体控制器 CPU p95 | 0.20 ms |
| 渲染提交 CPU p95，含 MMD helper/update | 12.20 ms |
| 大于 50 ms 的帧间隔 | 0 |
| 独立开口帧打断 → 实际嘴型权重降至阈值 | 45.6 ms |
| prepare / stroke / recover 取消 → 自然收势完成 | 818.8 / 663.9 / 862.5 ms |

收口单独挑选实际开口帧（嘴型权重和大于0.08）触发；stroke 场景也在发声，收口约79.6ms。prepare/recover两次当时嘴已闭合，不用它们的约10ms记录宣称发声收口更快。收势保留动画缓动，不能把这几百毫秒当作音源仍在播放。

上述数据是这台机器、该画布和 Headless Chrome 的本地测量。驱动/渲染提交是 CPU 时间；RAF 不是 GPU 完成时间，源节点停止与实际 morph 变化不是扬声器声学停声。录屏使用更大视口并有录制开销，其界面显示数字不替代上述独立性能窗口。

## 验收中发现并修正

首轮性能测试300次采样只有191次playing。原因是测试 PCM 每次相对定时20ms后再送一块，渲染负载造成定时器迟到并累积供包不足。新 Session 按绝对单调到达时间计算欠包，每次最多8块，随后让出；首批4块，暂停不形成“欠包债务”，刻意断供保持1.2秒。补充了27ms回调喂20ms PCM、0.8秒迟到、10秒暂停和断供后追赶的确定性回归。最终重新加载浏览器后得到300/300playing。

只读复核还发现自动测试字幕会在用户暂停期间继续前进。新入口已暂停该模拟器的字幕游标，并完成真实浏览器暂停/恢复回归。以上修正都在新接线层，未修改 Claude 的动作文件或原 PCM transport。

## 证据与复跑

可发布摘要：[../evidence/avatar-validation-20261015.json](../evidence/avatar-validation-20261015.json)。本机原始文件位于 `outputs/avatar-integration-20261015/`：

- `node-tests.txt`：166条完整输出。
- `source-before.json`、`source-after.json`：运行源码冻结。
- `browser/avatar-acceptance.json`：core/performance。
- `browser/avatar-sidecar.json`：semantic/starve/autopause/ended_cancel/ended_replace。
- `browser/avatar-visual.json`：16次截图前后状态、morph和骨骼数据。
- `browser/avatar-*.png`：八种表情及动作画面；`avatar-live-page.png`为整页操作画面。
- `browser/avatar-integration-demo.webm`、`avatar-demo.json`：页面按钮巡览、字幕动作与打断的画面演示及状态。录屏不作为音频证据。
- `browser/preliminary-acceptance.json`、`performance-cli.txt`：初次性能失败保留，未覆盖为成功。

先启动 `node realtime/avatar-server.mjs --port 18768`，从根目录运行：

```powershell
node --test realtime/tests/*.test.mjs tests/controller.test.mjs tests/motion.test.mjs
playwright-cli -s=face-avatar open http://127.0.0.1:18768/avatar/ --browser=chrome
playwright-cli -s=face-avatar run-code --filename=realtime/browser-avatar-acceptance.cjs
playwright-cli -s=face-avatar eval 'window.__avatarAcceptancePart = "performance"'
playwright-cli -s=face-avatar run-code --filename=realtime/browser-avatar-acceptance.cjs
```

字幕专项设置 `window.__avatarSidecarPart` 为 `semantic`、`starve`、`autopause`、`ended_cancel`、`ended_replace`，各运行一次 `realtime/browser-avatar-sidecar.cjs`。结果可用 `playwright-cli -s=face-avatar --raw eval 'window.__avatarSidecar'` 取回；检查 JSON 的 `passed`，不要仅依赖 CLI 进程退出码。

画面脚本需要先设置 `window.__avatarEvidencePath` 为已存在的绝对输出目录，分别设置 `window.__avatarVisualPart='faces'`、`'body'`，运行 `browser-avatar-visual.cjs`。录屏则运行 `browser-avatar-demo.cjs`。录屏和自动截图不替代实际查看。

仍未验证：真实Qwen双工、服务输出字幕与音频的时序、新语音实时口型、麦克风插话、声学停声、跨设备帧率和所有服装/头发碰撞。原有离线曲线只匹配本地样例。
