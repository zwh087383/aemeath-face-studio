# 独立闲时活动联动 demo

日期：2026-10-24。实验性、独立数据、站姿空手小范围。入口为 <http://127.0.0.1:18798/idle-activity-demo/>。

同日更新：用户禁用截图中持续抬手的 Stand2。当前版本的初始站姿、暂停、倾听、完成与取消回落都改为原生 Stand01；显式禁用规则在初始化及每次换段检查，不能改名引用旧来源。原素材与旧录像保留为历史。更新验收见本文末尾，后续自主中枢的完整计划见[人物调度中心实施计划](autonomous-character-director-plan-2026-10-24.md)。

本版将实际导入的 WAI ActivityPlanner、LifeThreads 与已有原生动作执行器连起来。它没有接管正式 WAI 进程、正式生活任务、记忆、历史或语音链；也没有调用云端模型。后台工作是实际读取随 demo 附带的公开说明文本，逐段提取标题、字符数与指纹，再经 LifeThreads 保存一份真实段落索引。这里复用了真实生命周期和存储保护，未运行完整 V2 Life Runtime 的模型生成、网络搜索及主动输出。

## 如何看

从 face 根目录启动：

~~~powershell
node realtime/idle-activity-demo/server.mjs --port 18798
~~~

默认从相邻 WAI 源码导入两项组件；异地运行时可传入：

~~~powershell
node realtime/idle-activity-demo/server.mjs --port 18798 --wai-root F:/AI-Shared/WAI --python python
~~~

所需 PMX、原生 GLTF、已处理的动作与表情数据沿用本机现有目录；源码库不附带私有游戏资源。三个界面区域分别显示角色、后台实际进度、交流状态。

- 点击“播放完整流程演示”：自动执行开始 → 暂停 → 恢复 → 模拟用户开口 → 结束交谈 → 恢复 → 完成，所有步骤调用同一后台接口。
- 手动使用开始、暂停、继续、取消，可以在任意阶段检查。
- 点击“启用麦克风”后，本地持续音量检测触发同一开口流程；声音不上传。检测不是 ASR，噪声也可能触发。停止说话后保持交谈，点击“交谈结束”才允许活动继续。
- 没有麦克风权限时可以点击“模拟我开口”。这里仅完成转入倾听，不生成回复语音。
- “查看已保存的成果”展示真实产物，不拿播放结束当作后台完成。

## 谁决定，依据是什么

| 环节 | 负责方及事实 | 实际行为 |
| --- | --- | --- |
| 开始 | WAI ActivityPlanner 接纳一个隔离生活线活动；已有 LifeThreads 登记材料来源 | 实际处理文本，身体进入原生 Thinking01 起势和循环 |
| 暂停 | 手动暂停或本地开口检测调用 ActivityPlanner.on_user_present | 后台保存剩余时长和已处理段落；身体保存阶段，沿同源 End 收势，回到 Stand01 |
| 恢复 | 原计划检查恢复条件、活动未取消、交流已结束 | 后台继续剩余段落；身体从保存的片段和时间位置接续，不重演完整起势 |
| 产物就绪 | LifeThreads.advance 接纳实际段落索引，ActivityPlanner.set_artifact 记录产物 | 显示“成果已就绪”；不伪称模型仍在计算，也不先把计划记成完成 |
| 完成 | 原计划时间及真实产物条件均满足 | 后台确认 done；身体完整收势，清除恢复点，回到陪伴 |
| 开口 | 本地持续声音门控先请求注意，再由后台接纳暂停 | 立即停止安排新闲时段落；原生收势后进入面向交流的站姿；短暂停声不关闭交谈 |
| 失败或取消 | 真实状态及活动代次 | 拒绝旧指令；不继续生成旧活动产物，身体走已有退出过程 |

仅把活动类型、阶段、代次和必要演示信息交给人物，不根据私人记忆正文猜动作。普通日志/缓存维护没有表演。完成、取消和实际身体收稳是不同事件。

## 两条时间分别推进

- 后台使用独立加速时钟：120 倍。原恢复条件中的 600 秒约为现实 5 秒。开始时直接跳到隔离计划的首个合法活动时段，以便立即观看。
- 本地段落处理每段约 0.25 秒起步，作为观察节奏；这不是模型速度、真实后台算力或端到端语音延迟测试。
- 原生动作始终 1 倍速、1 倍幅度，不因后台时钟加速。等待或暂停不把原生收势冻结。
- running 与 artifact-ready 单独呈现；计划剩余时间不被拿来声称云端仍在运算。
- 开口后保持交谈；原恢复窗口到期并不能越过仍在交谈或手动暂停的事实。

## 复用的素材及新增能力

身体仅允许两组已处理资源：

- Stand01：native:c38c5010f63da5b2，aimisi-stand01。此前的抬手 Stand2 已按用户要求禁用。
- Thinking01：native:ac884e85b5aef5d1，aimisi-thinking01-start/loop/end。

沿用 NativeBehaviorAdapter、NativeBehaviorPlayer、NativeRetarget、NativeClothBinding 和精确配套衣发选择。局部过渡继续带当前姿态和速度；原片段主体不改。没有创作新的身体动作，没有修改现有挥手、身体幅度或肘部配置。新增的是后台阶段适配、有限自动选择、检查点恢复和交流占用控制。

脸部仅用已有轻量 focus 配方表示专注，中性底色作为实验输入；未接正式数学情绪，不把任务成功直接变成高兴。原生待机与思考保持各自源轨迹；它们不是对整个动作库的自动批准。

## 验收与范围

以下 14 项与原录像是首次交付使用 Stand2 时的历史证据；本次替换的专项证据另列于末尾，不将旧画面冒充新版本画面。后台与语音规则未在此次修改。

本地专项：

~~~powershell
python tests/idle-activity-backend-test.py
node --test tests/idle-activity-scheduler.test.mjs tests/idle-activity-server.test.mjs
~~~

共 14 项通过：7 项真实 WAI 临时存储检查，7 项调度、音量门控与独立 HTTP 边界检查。包括暂停后进度不变、原 600 秒恢复规则、停声不自动结束交谈、真实产物只保存一次、取消及旧代次、交谈中拒绝新活动、异源写入拒绝。

浏览器脚本：

~~~powershell
playwright-cli -s=idle-activity-demo open http://127.0.0.1:18798/idle-activity-demo/
playwright-cli -s=idle-activity-demo run-code --filename=scripts/idle-activity-demo/browser-lifecycle.cjs
playwright-cli -s=idle-activity-demo run-code --filename=scripts/idle-activity-demo/browser-phases.cjs
~~~

本机证据在 outputs/idle-activity-demo-20261024/：

- lifecycle.json / idle-activity-lifecycle.webm：真实后台存储、完整生命周期、真实 PMX 与衣发；浏览器合成音频走真实 AudioContext → analyser → 本地检测 → 后台暂停链。
- phase-interruptions.json：起势 0.2/0.9 秒、循环阶段 2.0/3.4/5.1 秒的退出与恢复；同帧位置/旋转接缝、有限矩阵、检查点保留。
- one-click.json：通过页面上的一键演示按钮，实际完成全部阶段与第二次独立产物保存；后台与身体均正常结束。
- working.png、listening.png、complete.png、artifact.png：阶段截图。
- 各会话子目录：实际隔离计划、生活线、产物 JSONL、处理结果与事件记录。
- first-pass/ 保留补充交谈入口保护前的第一轮录像截图。

最终完整流程约25.16秒，观察2821个浏览器帧，合成音频输入到后台确认暂停约284毫秒，末段驱动CPU耗时P95约4.8毫秒。录制的视频保持实际1倍动画速度。5个阶段打断的同帧位置跳变最大约6.94e-18模型单位、旋转差最大约4.22e-8弧度；这些接缝数值只用于检查突变，不是自然度评分。最终页面另修正了完成后的提示文案，单独检查该提示，不为文字变化重跑动画验收。

测得的输入响应时间是合成音频到后台确认，不能当作真实麦克风、ASR、云模型或扬声器延迟。连续几何检查不证明全身碰撞、任意姿态兼容或所有人认为自然。当前只验站姿空手这组；坐姿持物、任意环境、主动说话和完整语音回复不在这版内。

正式 WAI 源码、真实运行数据和原有九个脏文件保持原样；独立 demo 的新增文件单独发布在 codex/idle-activity-demo-20261024。

## Stand2 禁用更新的单独验收

2026-10-24 后续批次，分支 `codex/character-director-plan-20261024`。禁用策略的三项 Node 检查通过，覆盖组/片段/源路径识别、保留来源的改名/变速/镜像，以及不误伤其它来源。禁用检查不是自动批准规则；其它资源仍须原有许可。

真实 PMX 浏览器在 0.2、0.9、2.0、3.4、5.1 秒中断工作动作，分别进入倾听、暂停、完成、闲时和再次倾听，再检查恢复。全部回到 Stand01；完成/回到闲时的检查点清除，暂停/倾听的检查点保留。两次直接注入禁用来源均在改变播放前被拒绝。另对新站姿连续采样 8 秒，两侧手腕始终低于胸部检查点，实际衣发仍启用，身体源速与幅度均为 1。有限值和当帧接缝检查通过，不代表全身避碰或审美验收。

本机证据：`outputs/character-director-plan-20261024/motion-exclusion.json`、`stand01-front.png`、`stand01-side.png` 和约 11 秒的 `stand01-interruption.webm`。录像是明确编排的“自然站姿 → 原有工作 → 打断回落”验收，不是自主中枢演示。已核对正侧面静态画面；连续自然度仍供用户判断。没有新增云调用、物理麦克风测试或后台业务变更，也没有重新宣称旧 14 项为本次重跑。

复查命令：

~~~powershell
node --test tests/character-motion-policy.test.mjs
playwright-cli -s=idle-activity-demo run-code --filename=scripts/idle-activity-demo/browser-motion-exclusion.cjs
~~~
