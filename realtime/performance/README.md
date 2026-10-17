# 动作与表情联动实验

此分支是 **实验性动作系统**：将原有 4 种手势扩充为 16 种完整表达，让腰背、骨盆、胸肩、头颈、视线、双手和表情共同参与。用于本地角色表达研究，不代表完整 WAI 记忆检索、真实双工语音或生产环境已经验收。

## 预览

从仓库根目录启动已有只读本地服务器：

```powershell
node realtime/avatar-server.mjs --port 18768
```

打开 <http://127.0.0.1:18768/performance/>。沿用项目已有本地 PMX、贴图与前端依赖，不下载新模型、不连接云服务、不采集麦克风。模型资源仍需按项目原有方式在本机准备。

页面默认循环“近身挥手”：挥手 → 完整收回 → 轻快招呼 → 完整收回，便于检查肘部与袖发间距。“身体联动”等原有连播仍可选择。可以点单个动作，切上身、侧前、侧面、全身或面部视角，暂停观察，以及在任意阶段打断收势。动作面板单独滚动，人物画面保持可见。

“叠加测试口型”是无声音的合成元音压力测试，用于观察微笑与张嘴能否共存；它不是语音识别或真实语音生成。

## 本分支特点

第三版 `codex/close-elbows-crisp-wave-20261016` 进一步收近肘部，高位挥手采用向前弯肘；手部挥动加快，保持上一版胸腰与头部幅度。实际五条左袖骨链加入有上限的衣料姿态约束，修正收回时扫入后辫子的路径。它仍是**实验性动作系统**，衣料约束不是布料物理。此次连续运动、全阶段打断和真实模型浏览器验收见 [CRISP-WAVE-REVISION.md](./CRISP-WAVE-REVISION.md)。

第二版 `codex/natural-elbows-body-20261016` 针对实际观看反馈修正肘部外张与身体反应过小。低位对话手势的肘部加入自然下垂方向，高位挥手仍保留抬臂空间；16 个身体轨道分别加入准备、转身或倾身、停留中的变化与收回。验收直接测量实际胸部旋转及肘部相对肩的位置，不再用“任意骨骼有非零移动”作为身体参与合格的条件。前后对比和本轮限制见 [ELBOW-BODY-REVISION.md](./ELBOW-BODY-REVISION.md)。

- 修复旧 body 轨道仅合成前 6 项，遗漏 `neckForward`、`gazePitch` 的问题。
- 加入保留速度的躯干阻尼、骨盆反向配合、小幅重心位移、双脚位置和方向约束；双手目标依据实际胸部坐标跟随。
- 头、眼、胸错时响应。俯身时头部适度跟随上身，并相对胸部抬起；仰头时视线先行，胸肩随后舒展。
- 手势、表情共用动作进度；眉、眼、嘴角采用不同的起落速度。原有四手势也补充表情轨道。
- 取消时从当前位置回收；连续故事在前一动作收回阶段接入下一动作；暂停冻结本地预览，不追赶暂停期间的墙钟时间。
- 语音与无声表情明确区分嘴形归属：真实语音保留元音、宽窄嘴、闭口优先级；无声轻笑暂停不突然闭嘴，取消平滑消退。
- `AVATAR_CATALOG` 支持全部 16 个公开动作，保留旧条目顺序与时序约束；旧 avatar 与 Qwen scene 已接入新表情合成层。字幕规则仍沿用原有语义选择，未宣称所有新动作都已有自动触发规则。

| 动作 ID | 表达 |
|---|---|
| `explain` / `wave` / `shrug` / `chest` | 原有解释、挥手、耸肩、抚胸 |
| `bow_smile` | 俯身抬眼微笑 |
| `laugh` | 开心轻笑 |
| `curious` | 好奇探身 |
| `shy` | 害羞回望 |
| `explain_firm` | 郑重点明 |
| `surprise` | 惊讶回神 |
| `think` | 凝神思考 |
| `greet` | 轻快招呼 |
| `listen` | 认真倾听 |
| `comfort` | 温柔安慰 |
| `look_up` | 仰头舒展 |
| `agree` | 会意点头 |

## 接线与验证

动作数据在 `preview/core/motion-profile.js`，身体控制在 `motion-controller.js` / `motion-skeleton.js`，表情合成在 `expression-choreography.js`。新 preview 的 `PerformanceDirector` 只提供本地时钟与序列编排，使用同一套真实控制器。在线调用者继续提交 scheduler 的 `kind: 'gesture'`、`gesture: '<id>'` 指令。

`MotionController.update()` 返回的 quaternion Map 附带 `translations` Map，由 `MotionRig.apply()` 处理并恢复上一帧位移。自定义适配器需要一起应用位移，不能只复制旋转。

```powershell
node --test tests/motion.test.mjs tests/motion-dynamics.test.mjs tests/motion-library.test.mjs tests/coordinated-motion.test.mjs realtime/tests/*.test.mjs
node scripts/check-coordinated-motion.mjs
node realtime/browser-performance-acceptance.cjs
node --test tests/crisp-wave-tempo.test.mjs tests/near-elbows-clearance.test.mjs tests/wave-recovery-regression.test.mjs
node scripts/check-wave-clearance.mjs --mesh
node realtime/browser-wave-acceptance.cjs
```

浏览器验收需要本地 Chrome 和 Playwright；脚本只创建、关闭自己的浏览器。密集网格对照需要本地 PMX、Three.js 依赖和 Git 中的 `69ba756` 基线，运行耗时数分钟，原始结果写入被忽略的 `outputs/`。第一版历史结果保留在 [VALIDATION.md](./VALIDATION.md)，第二版证据见 [ELBOW-BODY-REVISION.md](./ELBOW-BODY-REVISION.md)，第三版见 [CRISP-WAVE-REVISION.md](./CRISP-WAVE-REVISION.md)。

衣发物理仍关闭。网格启发式检查不能证明全角度无穿模；右肩飘带与侧发仍有少量接触。动作自然程度保留人为观感判断，测试通过只说明被测行为和数值满足条件。
