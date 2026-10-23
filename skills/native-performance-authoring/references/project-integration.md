# WAI / face 适配入口

本参考定位代码，不把目录存在视为已上线。路径相对各项目根。当前宿主机WAI为`F:/AI-Shared/WAI`，face为`F:/AI-Shared/model_test/face`；移机时从实际工作区解析。

## 权威状态与语音边界

- WAI情绪入口：`wai/identity/emotion_system.py`、`wai/common/state_bus.py`。读取数学状态V/A/D/S/L/T及其变化来源；模型对文本的分类/评估是可能的输入，不是直接设置角色最终mood的权威。
- 不在动作模块重建一套长期情绪、需求/生理/关系或活动规划。对话阶段从现有运行时事件获取，保留取消、记忆纠正和交付历史保护。
- WAI正式Web与face原生资源预览是不同入口。检查`webui/src/components/CharacterStage.tsx`和`webui/src/useCompanionRuntime.ts`，再确认展示契约是否存在；不能从实验页能动推断正式端已接通。
- 现有语音实验在face `realtime/wai`、`realtime/duplex`及WAI `tools/voice_avatar`等真实目录中查找。先核对当前direct/D方案与用量保护，不为动作验收新增云调用。现有D完整工具校验后提交本地，receipt在response.done后发；“动作不阻塞音频”不等于“工具立即回ok已实测”。
- 截至2026-10-22，主Web快照尚未导出角色E4/R2及effective energy，D的expression也还是Qwen选择、强度固定.65。新实验不得伪称已接权威情绪流。新桥应取与本轮回复同口径的runtime_soul有效能量，不能只取旧soul.energy。

## 原生资源和渲染

- 私有目录：`outputs/native-complete-20261022/manifest.json`；资源位于同目录`clips`和`resources`，以manifest条目为准。
- 原生浏览：`realtime/native-resources/{server.mjs,viewer.mjs,index.html}`；可复用模块`preview/core/native-motion.js`、`native-expression.js`、`native-resource-layer.js`、`native-cloth-binding.js`。
- PMX：`assets/Aemeath/`中实际模型与`assets/Aemeath-inspection.json`；原始模型不修改。
- 当前是Three.js + three-mmd / PMX及原生GLTF参考，不为了套架构换成Unity/UE。
- 原生衣发有独立层；长发别名和裙片原生蒙皮适配已经有专门模块。不要重新猜别名或最近点，复用已验证绑定。

## 原创库和调度

- 查`preview/core/motion-profile.js`、`expanded-motion-library.js`、`expanded-expression-library.js`、`activity-library.js`；用`rg --files`确认当前文件名再加载。
- `realtime/scheduler.mjs`负责已有实时排程，`realtime/performance/director.mjs`和`realtime/activities/director.mjs`提供不同实验导演。它们不等价于已接原生资源的统一导演。
- 建议新增实验放`realtime/skill-lab/`，新控制器/测试独立命名。复用加载/绑定但不编辑旧viewer或Claude正在改的文件。
- 每次查目录后更新实际计数；不要把旧73片段、581可播或56原创等历史数永久写成能力上限。

## 新颖性证据

查全部manifest的名称、分类、group、配套关系；检查最相近候选实际内容，再查原创库。新作须说明相对最近候选新增了什么交互行为或轨迹组织。无法穷尽全游戏未提取资源时，只能声称在当前本地目录内未发现重复，不能声称全球独创。
