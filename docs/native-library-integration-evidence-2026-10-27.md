# 原生动作扩库：接入与验收明细

核对日期：2026-10-27。实施位置：`F:\AI-Shared\model_test\face-library-expansion-20261027`。

这份记录说明原生身体资源接进中枢以后，实际源骨架和目标 PMX 骨架的检查结果。它不把自动通过等同于人工已看过、衣发全程无穿插，也不把镜像、重复和变速计为新增动作。

本轮 149 个来源组中，109 个在当前单角色场景内接通，35 个需要范围外场景或物件，5 个属于禁用来源。109 项全部完成真实目标骨骼检查：1250 个阶段采样点和 311 次阶段打断，失败 0。原始资源 319 段包含同一行为的起势、中段和收势，因此没有当成 319 个独立行为。

完整证据见 `outputs/library-expansion/native-target-final.json`。旧的 `native-target-results.json` 保留初次 81/109 通过、28 项失败的结果，修复后各分片也原样保留；合并报告记录每份输入的 SHA256。

## 本轮实际补了什么

- 站姿、坐姿、蹲姿和走动使用当前模型的实际腿长和脚底位置检查可达性。必要时修正身体根部高度，不能拉长骨头，也不能把 IK 够不到的位置记成已接触。
- 座椅以真实座面和人物骨盆测量对齐；桌面承接以真实肘部和桌面位置核验，键盘以真实手指、手腕和电脑位置核验。
- 地面落座补了 2.4 秒进入过程；缺入口及桌面接触项补了 0.8 秒进入过程。6 个进入过程纳入了总时长。
- 64 项走同源 End；19 项播完完整原片段后收稳；26 项预留正常支撑回收。正常收势与紧急数值停稳在协议中分别记录。
- Weak_Sit 保留原上身表现和原播放时钟，同时根据真实椅位重新安排两脚交替移动。它不继续把双脚钉在游戏原场景的坐标上。
- 移动检查真实桌、椅、箱和平台的占用范围。阻挡时返回具体物体，保持原现场，不替模型选择别的行为。
- 资源按项加载并验证指纹；单项失败不清除其它已准备项目。准备工作分片让出浏览器主线程，每次让出前恢复正在显示的姿态。
- 准备完成后再次核对身体朝向、支撑、手部占用、人物位置和道具的位置、旋转、缩放、开合状态。准备期间取消不会恢复旧帧覆盖新显示。

## 时长和变体证据

总时长包含正常原速起势、获准的整圈中段、收势，以及实际所需的进入/收稳时间。数值目标返回最近可达时长，区间必须实际容纳完整周期；没有整段减速凑时间。现有 Thinking01 单次 6.4666666 秒，两圈 9.1333333 秒。状态更新不重新启动动作计时。明确给定总时长区间时，数学精力会在该区间内选择可达的整圈数；Thinking01 的 [6,15] 秒许可，低值选择 1 圈 6.4667 秒，高值选择 4 圈 14.4667 秒。标量目标仍选最近可达时长，省略许可时仍然单次。

73 个只有一条 Loop 的 phase 许可与默认路径逐项核对为同一条真实执行路径。Thinking02 的两条不同 Loop 另在真实 PMX 上分别检验完整入口、重复三次、完整出口和中段打断。

目录与生命周期回归 14/14；异步准备/取消/现场变化和实际桌面阻挡回归 2/2；Thinking02 的两条实际变体回归通过。测试文件：`tests/character-library-catalog.test.mjs`、`tests/native-library-lifecycle.test.mjs`、`tests/native-library-real-target.test.mjs`。

## 证据边界

- 109 项检查读取真实 GLTF 源和目标 PMX 骨架，但没有通过 GPU 观察每一帧的最终蒙皮、头发裙摆碰撞或主观自然度。预览中的人工审阅仍必须保留。
- 每个源阶段检查边界与四分点，准备过程还检查约 24Hz 的支撑路径；打断覆盖各类起势、中段、收势。不是任意两项动作之间的所有排列组合证明。
- 分片并行期间的 elapsedMs 受机器争用影响，只表示测试执行时间，不能当作浏览器帧耗时或语音延迟。浏览器性能由独立、无争用的新旧对照给出。
- 没有调用云端模型，也没有声称模型已经自然使用全部动作。

## 逐项真实执行结果

| 来源 | ID | 入口 → 完成支撑 | 正常结束路线 | 阶段点 / 打断 | 结果 |
|---|---|---|---|---|---|
| Body/Talk02 | native:168fbd5a42cf1a09 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Talk01 | native:730dcd7037c77c20 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Showhand01 | native:e560c488675ec4c4 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Stand01 | native:stand01 | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Body/Thinking01 | native:thinking01 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/Hi01 | native:ead9651275d32134 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Calm01 | native:01264d94a150921f | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Calm03 | native:b522206a16ac1e1e | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Calm02 | native:dfdde4ac9b876bd0 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Thinking02 | native:104ba27f7bc5ad17 | 站姿 → 站姿 | 同源收势 | 20 / 3 | 通过 |
| Body/However01 | native:c1a24979d6098d10 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Breath01 | native:6c953aff6e278d31 | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Body/Zhixiang01 | native:ed755d3ea28bcd61 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Cheek01 | native:f2f5c57d62879e5f | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Body/Whisper01 | native:2c7063bb0f829c97 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Angry01 | native:583ed4ee49053cfd | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Finger_Snap | native:fc1ee2807089b35e | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Liaofa | native:6b090eb2ba175b43 | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| BaseAnim/Sushe_Hair | native:cbdffb3d5bb811b3 | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Dongbu/DZ_Liaotoufa01 | native:eac45cb1361960e5 | 站姿 → 站姿 | 已预留的支撑回收过程 | 10 / 2 | 通过 |
| Body/Shy05 | native:17039f62ce6ac23b | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Shy01 | native:2f91b51041038b8b | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Shy03 | native:69ee9727a6290ed3 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Promise01 | native:7436ad5898f0b9d7 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Complain04 | native:9387f2034f744008 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Complain01 | native:b301d59356a01ccb | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Shy02 | native:c2e6400f4b7a11bc | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Embarrassment01 | native:fb4efdf4f17daa1f | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Relax01 | native:1641f65892632ccc | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Body/Tsundere01 | native:dc63553da1c0390a | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Tsundere02 | native:f23790a60f7f21f0 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/DZ_Baobi_laugh01 | native:29b2a60deef700c3 | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Dongbu/Pleading01 | native:8e2d91199e9633de | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Squat02 | native:c82adcc82df86c86 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Stand_DownHead01 | native:b448711ae81f52a4 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Squat01 | native:e8dcf6069e0a8190 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/Wuzui01 | native:9c4593a540925363 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/Wuzui02 | native:f028ae3669e3164b | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/Cazui01 | native:a0f0a1e857d9492a | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Dongbu/DZ_Tanqi01 | native:371b5ec2ffb45558 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/SitTalk01 | native:e66ba6cf43df4d9f | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Body/Sit04_Talk | native:67b49b0813c45621 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/DZ_Sit04_Hi | native:e9b327876cac6b40 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Body/Sit_RestChin | native:67e53baf536fdd76 | 座椅支撑 → 座椅支撑 | 同源收势 | 20 / 3 | 通过 |
| Body/SitCalm01 | native:d3b5d9fbfa699c46 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Body/SitThinking01 | native:5dd7b2ec53df6fc7 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Body/SitThinking02 | native:f18926c9c6ae3a02 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Body/Sit01 | native:025acfb4d0c464f4 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/Sit05 | native:1deceb077016a1cb | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/Sit04 | native:539388203f969fa6 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Body/Sit03 | native:65585aa0d468f19e | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Body/SitPromise01 | native:3b5c4aa86e99aefa | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| BaseAnim/sit_headmove_01 | native:990c5233ed91a7c5 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Body/Sit_LeanBack | native:b75b36a81e91faa8 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/Sit04_Head | native:52072905c66442c9 | 座椅支撑 → 座椅支撑 | 已预留的支撑回收过程 | 10 / 2 | 通过 |
| Dongbu/Sit05_expect | native:18101c2d7c1499f1 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/DZ_Sit_Baoyuan01 | native:d387689ca7480266 | 站姿 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/Sit05_ShakeLegs | native:d1e93a95857c2d8e | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/DZ_Sit04_Laugh | native:db4626e99feb7e66 | 座椅支撑 → 座椅支撑 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Dongbu/DZ_Sit_laugh01 | native:3e7d2e4ca88e3987 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 2 | 通过 |
| Dongbu/Sit05_Land | native:0d1b6626eed14232 | 座椅支撑 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Body/Turn_L90D | native:2ba3ae789ad0d170 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| Body/Turn_R90D | native:acae286c3825e722 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| fuyong/Walk_F | native:359075bde1cd63ab | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| BaseAnim/Walk_B | native:65e33cc96ca7a053 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| BaseAnim/Walk_F | native:fabd7f5580e95c98 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| Body/Salut01 | native:aae38a0a6cf43e12 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| Body/Walk_Talk01 | native:dad0169588a92206 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| Body/Walk_Thinking01 | native:fabfc1a266253797 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| Dongbu/Walk_Talk01 | native:2ee4821bc53b21dc | 站姿 → 站姿 | 已预留的支撑回收过程 | 10 / 2 | 通过 |
| Body/Walk_Hi | native:8c19e5ec15494254 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| Body/Shy_Walk_F | native:6e264419d6e47fc3 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/Sit02 | native:d262c73450c9d3ad | 站姿 → 站姿 | 同源收势 | 15 / 2 | 通过 |
| Dongbu/DZ_Beishouzhuanshen01 | native:56112c2a6f97abf5 | 站姿 → 站姿 | 已预留的支撑回收过程 | 10 / 2 | 通过 |
| fuyong/Run_F | native:0d275dbec31ab567 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| Body/Run02 | native:bd7bb000626b6381 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| BaseAnim/Sushe_Farewell | native:cef58b36cd8e1b38 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| Body/Weakness_walk | native:942a1d1065b1a92a | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| Body/keboard01 | native:fdc84d12a3151b50 | 站姿 → 站姿 | 已预留的支撑回收过程 | 10 / 1 | 通过 |
| Body/Pat | native:76b3f218509705d3 | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| CommonAnim/Stand1_Action01 | native:0821a125b3bc93c6 | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| CommonAnim/Stand1_Action02 | native:7d7d364e5da57ae0 | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| CommonAnim/Stand1_Action03 | native:902af91933f3a798 | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| Body/Raise01 | native:61f3db07af939056 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Awareness01 | native:8bb02e3a6717aaa1 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/DZ_Taishou02 | native:0e3a31216f8c9935 | 站姿 → 站姿 | 已预留的支撑回收过程 | 10 / 2 | 通过 |
| Dongbu/DZ_Taishou01 | native:95aeab3f92086a6a | 站姿 → 站姿 | 已预留的支撑回收过程 | 10 / 2 | 通过 |
| Dongbu/DZ_Shenshou01 | native:d2f3148cb5cfd8eb | 站姿 → 站姿 | 已预留的支撑回收过程 | 10 / 2 | 通过 |
| Dongbu/Fool02 | native:a51e7295fd231dab | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/Fool01 | native:8cce8938720a1b6d | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Body/SitFool01 | native:a7cd241c33832136 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/Kanziji01 | native:e53cd836a014e696 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| UiAnim/Team_Stand1 | native:ea99ebc3749ee92d | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| UiAnim/Team_Stand3 | native:f9d38840ac9a5ded | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Dongbu/DZ_SitUP | native:34ca221c842830de | 座椅支撑 → 座椅支撑 | 已预留的支撑回收过程 | 10 / 2 | 通过 |
| Body/Qujing01 | native:411ce67ca8355ca3 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/DZ_Tanzuo02 | native:f94835ea8f8c0133 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/DZ_Tanzuo04 | native:272fbf2faacc5e96 | 座椅支撑 → 座椅支撑 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Dongbu/DZ_Tanzuo01 | native:4bde59c71e519dbf | 座椅支撑 → 座椅支撑 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Body/Weak_Sit | native:a5508661ae29831d | 站姿 → 站姿 | 已预留的支撑回收过程 | 5 / 3 | 通过 |
| Dongbu/DZ_Tanzuo03 | native:f8ad9f06284a95af | 座椅支撑 → 座椅支撑 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Dongbu/DZ_Chiru01 | native:0dfd916932ec9a86 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/DZ_SaveMoning | native:cb7da0b5a6b1f70d | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/Bi01 | native:05b72e5acc306c50 | 站姿 → 站姿 | 同源收势 | 15 / 3 | 通过 |
| Dongbu/DZ_ShaqingXingfen | native:5924adfac19e652c | 站姿 → 站姿 | 完整原片段 + 收稳 | 5 / 3 | 通过 |
| Dongbu/DZ_Pa01 | native:8bde3fee17e4dc32 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 2 | 通过 |
| fuyong/DZ_Pa01 | native:f61670cf9d5f4df6 | 座椅支撑 → 座椅支撑 | 同源收势 | 15 / 2 | 通过 |
| Dongbu/DZ_Mofang02 | native:49008d5c5a53d8a5 | 站姿 → 站姿 | 已预留的支撑回收过程 | 10 / 2 | 通过 |
| Dongbu/DZ_Mofang01 | native:ca61a9572029829a | 站姿 → 站姿 | 已预留的支撑回收过程 | 10 / 2 | 通过 |

## 保留索引但未开放的项目

这些项目保留原始来源及原因，没有用改名动作绕过禁用，也没有因为执行器尚未完成就把本轮范围内动作划到这一表。

| 来源 | 类型 | 原因 |
|---|---|---|
| CommonAnim/Stand2 | 禁用 | 用户禁止的精确 Stand2 来源，不用于待机、倾听、恢复、兜底或改名变体。 |
| Dongbu/Kao_Stand01 | 范围外 | 原姿态含倚靠；当前场景没有相应竖直承接面，不能用空气承担身体。 |
| CommonAnim/StandChange | 禁用 | 此来源由已禁止的抬手 Stand2 起始姿态转换，保留索引，不作为绕过禁用的入口。 |
| BaseAnim/Sushe_Paperplane | 范围外 | 需要可持握、可释放并有飞行结果的纸飞机；普通纸张不是该物件。 |
| Body/Stand_Cidai01 | 范围外 | 需要与源手位一致的磁带及握持回执。 |
| Dongbu/Run_cidai | 范围外 | 需要与源手位一致的磁带及握持回执。 |
| Dongbu/Take_Mai01 | 范围外 | 需要真实话筒及交接对象。 |
| BaseAnim/Sushe_Scripting | 范围外 | 真实源骨架是俯卧并屈腿的书写现场，不是当前桌椅坐姿写字；缺匹配躯干承接面及纸笔握点。 |
| BaseAnim/Sushe_Texting | 范围外 | 需要真实手机与手机握点。 |
| BaseAnim/Sushe_Guitar | 范围外 | 需要吉他、承重位置及双手弦面接触。 |
| BaseAnim/Aimisi_Fanclub | 范围外 | 原剧情应援路线与对象不在当前单角色桌椅场景。 |
| fuyong/MotorPassenger_Stand | 范围外 | 源姿态以载具及其接触点为前提；当前没有载具。 |
| Body/Mortor_Zhixiang01 | 范围外 | 源姿态以载具及其接触点为前提；当前没有载具。 |
| Dongbu/DZ_Motor_shouji01 | 范围外 | 源姿态以载具及其接触点为前提；当前没有载具。 |
| Body/Motor_Dajian01 | 范围外 | 源姿态以载具及其接触点为前提；当前没有载具。 |
| Body/Touch01 | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Dongbu/DZ_Sit_Guabi02 | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Dongbu/Fu01 | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Dongbu/Guabizi01 | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Dongbu/DZ_Bao01 | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Body/Stand_Qianshou01 | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Body/DZ_GuabiziEND | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Dongbu/DZ_Baoku01 | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Body/Hold_hands | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Dongbu/DZ_Woshou01 | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Body/DZ_Woshou_01 | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Dongbu/Beizhuashou01 | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Dongbu/DZ_Beila01 | 范围外 | 需要第二人物或被接触对象的真实锚点、让位和交接。 |
| Dongbu/Readiness04 | 禁用 | 战斗准备上下文及伸拳姿态尚未被证明为独立非战斗生活表达；禁止在交流目录试猜。 |
| Body/Readiness02 | 禁用 | 战斗准备上下文及伸拳姿态尚未被证明为独立非战斗生活表达；禁止在交流目录试猜。 |
| Dongbu/Readiness03 | 禁用 | 战斗准备上下文及伸拳姿态尚未被证明为独立非战斗生活表达；禁止在交流目录试猜。 |
| CommonAnim/XA_Loop_Stand | 范围外 | 实测身体不是地面直立支撑；需要原特殊悬空/承接现场。 |
| UiAnim/Ui_Resonant | 范围外 | 原游戏装备展示关联对象与表现层未在当前场景提供；保留来源，不改名成为日常手势。 |
| UiAnim/Ui_Nature | 范围外 | 原游戏装备展示关联对象与表现层未在当前场景提供；保留来源，不改名成为日常手势。 |
| UiAnim/Ui_Chip | 范围外 | 原游戏装备展示关联对象与表现层未在当前场景提供；保留来源，不改名成为日常手势。 |
| UiAnim/Team_Stand2 | 范围外 | 此来源不是被禁 Stand2，但实际单腿高抬姿态缺匹配承接条件；暂不作为普通站姿。 |
| Dongbu/DZ_Rushui01 | 范围外 | 入水与游动的支撑关系不能在平地冒充。 |
| Dongbu/DZ_Rushui02 | 范围外 | 入水与游动的支撑关系不能在平地冒充。 |
| Body/DZ_Fly01 | 范围外 | 飞行姿态没有地面支撑，当前场景没有飞行能力。 |
| Body/DZ_Hunmi | 范围外 | 原生后仰悬托姿态需要躯干承接面或另一承接者；当前椅子不是该承接关系。 |

原生契约子集 SHA256：`9bbcc52e4d2b67819219e587323a1d75070c1db499edd8b8997a389312dbc08a`。活动目录增补时，只要这一子集与保存的完整证明逐字一致，就可以沿用原生几何证据；原报告的全目录版本不会被改写。

## 2026-10-28：真实椅前站位的 Weak_Sit 补验

新增的独立场景明确使用世界坐标：椅子位于 `[0,0,-8.2]`，人物从 `[0,0,-2.594705891609191]` 的椅前站位开始，仅保留这把椅子。没有回退到人物与椅子重叠的起点。

旧实现把游戏原场景到真实椅子的平移修正集中在身体下降的短时间里，起身时又撤掉这一修正。结果是身体先沿游戏原路线走远，再被拉回椅边，脚目标超出实际腿长。本次把真实椅位修正分布到接近过程；下降前保留椅前净空，落座后保留已经到达的位置，起身只从已建立座面接触的前方退出。原关节曲线的幅度、上身表现和源播放时钟保留，世界移动路线和脚部落点按真实场景适配，并非宣称游戏原世界坐标轨迹不变。

- 实际 PMX 以 60Hz 检查完整源片段及收稳，并在 2、8.5、10.8 秒各做一次取消，全部通过；真实椅面确实出现接触，完成和取消终态均为站姿。独立证据：`outputs/library-expansion/native-weak-seat-fixture.json`，含驱动代码指纹。
- 实际无界面 Chrome 通过同一网页入口验证完整播放及三次取消，4/4 通过、页面异常 0。完整播放回执为 `action_completed`；取消后原生播放器到达 `cancelled-held`。证据：`outputs/library-expansion-20261027/browser-native-weak-final.json`。
- 已查看实际角色的进入、坐稳和收势截图：`weak-seat-complete-0.png`、`weak-seat-complete-8.95.png`、`weak-seat-complete-15.png`。它们不代替连续自然度人工验收，也不证明衣发与椅面所有时刻都无穿插。
- 实际浏览器先发现了两项集成问题：计时器调用需要正确的浏览器接收者，以及布景位置被额外加上人物初始位移。修复后的成功运行重新核对了椅子和人物的世界坐标；两份失败历史仍保留，没有改写成成功。

**实际速度和打断限制**：此次弱行落座的分片几何准备耗时约 5.6～7.0 秒。它会让出浏览器主线程，也不作为语音开播条件，但动作本身仍需等准备完成，不能称为低延迟即时起势。

| 取消发生在源动作的时间 | 命令撤销 | 身体到达收稳终态还需 |
|---|---|---|
| 2 秒 | 当次处理立即撤销 | 约 10.72 秒 |
| 8.5 秒 | 当次处理立即撤销 | 约 4.22 秒 |
| 10.8 秒 | 当次处理立即撤销 | 约 1.92 秒 |

原因是该来源仍使用已有的 `finish-source` 身体退出策略：继续完成 12.066667 秒原片段，再用 0.65 秒完成回收。撤销禁止旧命令继续排入队列；身体完成剩余退出路线属于正在执行的取消处理，不代表旧命令重新生效。语音取消与身体退出使用独立控制，不需等待这段身体动作结束。后续若要求更快的身体让位，需要单独制作和检验分阶段安全出口，不能把本次结果称为所有身体动作都能低延迟停下。

本次驱动新增几何分支在目录中只命中 `native:a5508661ae29831d`（Weak_Sit）。原 109 项数值验收报告仍作为其当时场景下的完整历史证据保留，本次添加同一行为的新场景证据，不宣称另外 108 项在全局布景变化后又全部重跑过。普通走路的真实桌面阻挡拒绝／空地允许回归也再次通过。新的目录仅补充了坐下、起身和移椅的真实场景条件，当前全目录 hash 为 `sha256:a1f7799f73cfb024902bbbfe303390082f9142253254bf68ab6b34858b1dfc95`；原生契约子集没有改变。

Weak_Sit 收稳后的续接另有独立浏览器证据：`outputs/library-expansion-20261027/native-weak-continuation-browser.json`。2 秒取消后先完成身体退出，再提交现有挥手；挥手收到 `action_completed`，角色仍有站立支撑，旧原生播放器保持 `cancelled-held`，旧动作没有重新开始。这里验证的是退出后可以继续动作，不代表身体仍在必要落脚阶段时已经允许任意双手全身手势抢占。

## 2026-10-28：Sit01 按需加载位置污染校准的修复

同一个真实椅前场景中，Sit01 曾在网页起身后被判为双脚离地。失败历史保存在 `outputs/library-expansion-20261027/browser-native-world-fixture.json`，进一步的 60Hz 浏览器定位结果在 `native-sit01-runtime-probe.json`。把离线推进从 60Hz 改为 10Hz 并不能复现；直到把“加载动作”从人物摆位前移到摆位后，离线模型才逐坐标重现网页失败。因此没有通过减小时间步或放宽地面接触条件掩盖问题。

真正原因是按需加载时，骨骼适配器把人物父级的现场位置和朝向也写进了身体校准。这个位置偏差随后被当成骨盆偏移随源动作旋转，改变了本不该改变的轨迹。现在，加载器在一个不让出执行权的短作用域内，仅按模型自身参考系建立校准，随后恢复真实父级及显示状态。执行时仍由场景驱动器把动作放到实际椅子和地面上。源文件、源时钟、源关节幅度、衣发映射和接触容差均未修改。

本次追加的证据分别覆盖：

| 层次 | 实际执行内容 | 结果与文件 |
|---|---|---|
| 全库加载一致性 | 109 个开放原生组的 244 个不同源片段，分别在原点和 `[3,0,-7]`、朝向 0.8 弧度的现场加载 | 校准位置、姿态及骨盆偏移误差均为 0，当前显示未变化；`outputs/library-expansion/native-load-calibration-invariance.json` |
| Sit01 实际 PMX | 人物先在椅前站好，再加载；60Hz 与 10Hz 各跑完整动作及起势／中段／收势取消 | 8 个案例均以真实地面支撑收稳；`outputs/library-expansion/native-sit01-seat-fixture.json` |
| Sit01 实际网页 | 10Hz 推进，每 0.1 秒均可实际渲染；完整播放及 1.5、5、9.5 秒取消 | 4/4 通过，页面异常 0；`outputs/library-expansion-20261027/browser-native-sit01-final.json` |
| Sit01 取消后续接 | 2 秒取消，完成必要源收势后再提交挥手 | 挥手完成、站立支撑成立、旧原生动作未复活；`outputs/library-expansion-20261027/native-sit01-continuation-browser.json` |
| Weak_Sit 复核 | 使用这次新校准重跑同一真实椅前网页场景 | 正常播放及三次取消再次 4/4 通过，结果写入 `browser-native-weak-final.json` |

已查看 `sit01-seat-complete-5.png` 与 `sit01-seat-complete-15.png`：前者坐在真实椅面上，后者起身站在椅前。截图是具体时刻的视觉证据；连续衣发、椅面穿插和观感仍需人工检查。网页此次 Sit01 分片几何准备约 **5.65～7.37 秒**，不属于即时可播；部分验证与离线计算并行，不能把这组墙钟时间作为独占机器性能基准。

Weak_Sit 在此次同时进行全库加载和 PMX 回归的复测中，几何准备墙钟为 **10.84～16.98 秒**；当前 `browser-native-weak-final.json` 保存的是这一新修复批次，上节 5.6～7.0 秒为较早批次观测。两组不能拿来直接推断加载修复本身加快或减慢了多少；它们共同说明当前场景准备延迟仍是实际限制，分片让出主线程并不等于动作立刻可播。

Sit01 的取消遵循“完成当前源阶段，再走同源收势”，不是任意时刻冻住身体。按这次实际计划，1.5 秒取消后还需约 5.9 秒到站稳，5 秒取消后约 6.4 秒，9.5 秒取消后约 1.9 秒。命令撤销和语音停止不等身体完成这些必要过程，但本结果不能表述成即时身体退出。

全库加载一致性检验确认的是：在其它世界位置按需加载时，能够获得原点校准的同一组数值。它补强原 109 项数值验收的前提，但不等于在新世界布景下重新跑完 109 项网页全过程。原 109 项完整源阶段、数值接触和取消报告继续保留原指纹；本次新场景、加载修复和浏览器证据独立保存，不改写历史结果。本节验收目录版本为 `sha256:a1f7799f73cfb024902bbbfe303390082f9142253254bf68ab6b34858b1dfc95`；之后仅活动元数据变化应单独记录新全目录版本，原生契约子集仍按上文指纹核对。

自动回归另通过 29 项原生播放器、目录、生命周期与资源接口检查；1 项依赖未在该命令中启用的私有目录检查跳过，不能计入通过数。真实 PMX 的加载恢复／失败回滚、准备取消不回滚新显示帧、Weak_Sit 入口以及 Sit01 入口均有独立通过记录。全库加载一致性检查的第一版测试同时保留全部解码对象而触及 Node 默认堆上限；改为逐项比较后释放测试缓存，244 项完整通过。这是测试容器的内存占用修正，没有改变业务按需加载策略，也未把首次失败改写为成功。
