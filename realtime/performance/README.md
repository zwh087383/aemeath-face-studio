# 动作与表情联动实验

此分支是 **实验性动作系统**：将原有 4 种手势扩充为 16 种完整表达，让腰背、骨盆、胸肩、头颈、视线、双手和表情共同参与。用于本地角色表达研究，不代表完整 WAI 记忆检索、真实双工语音或生产环境已经验收。

## 预览

从仓库根目录启动已有只读本地服务器：

```powershell
node realtime/avatar-server.mjs --port 18768
```

打开 <http://127.0.0.1:18768/performance/>。沿用项目已有本地 PMX、贴图与前端依赖，不下载新模型、不连接云服务、不采集麦克风。模型资源仍需按项目原有方式在本机准备。

页面默认循环“见到你”：轻快招呼 → 俯身抬眼微笑 → 开心轻笑 → 会意点头。可以点单个动作，切上身、侧前、侧面、全身或面部视角，暂停观察，以及在任意阶段打断收势。动作面板单独滚动，人物画面保持可见。

“叠加测试口型”是无声音的合成元音压力测试，用于观察微笑与张嘴能否共存；它不是语音识别或真实语音生成。

## 本分支特点

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
```

浏览器验收需要本地 Chrome 和 Playwright；脚本只创建、关闭自己的浏览器。结果与当前边界见 [VALIDATION.md](./VALIDATION.md)。

衣发物理仍关闭。网格启发式检查不能证明全角度无穿模；右肩飘带与侧发仍有少量接触。动作自然程度保留人为观感判断，测试通过只说明被测行为和数值满足条件。
