# 爱弥斯原生非战斗资源完整提取实验

这批在已验收的 Stand2 和 73 段常用动作基础上，继续处理本机盘点出的表情、注视、衣发、道具、默认面部与台词口型。新增角色原生待机、宿舍与生态场景动作，继续排除攻击、技能、处决、受击、死亡、闪避、战斗武器和战斗专用伴随动画。资源名只用于筛选与查找，不作为表演含义已经人工确认的证据。

本机最终预览：<http://127.0.0.1:18792/native-resources/>。旧的单片预览 18789、73 段动作库 18790 和本批验收实例 18791 保留。页面按类别搜索、40 项分页、详情按需读取、最近 3 项缓存，可暂停、拖时间轴、切换面部/侧面视角，身体、注视、衣发、表情和口型共用时间轴。

## 实际导出结果

| 类型 | 数量 | 当前状态 |
|---|---:|---|
| 身体动作 | 319 | 全部解码并适配；含原生待机、交流、坐蹲、转身、宿舍/生态等；2 段共用步行 |
| 衣发伴随 | 245 | 243 段可播放，2 段原始包已归档但缺少有效叠加基准 |
| 注视方向样本 | 9 | 可播放，局部叠加到首/头，保留身体基底 |
| 注视混合配置 | 1 | 配置参数可读；当前按方向样本审阅，尚未恢复游戏完整 AimOffset 控制器 |
| 爱弥斯角色表情 | 17 | 原生浮点曲线全部解析，108/108 通道对应当前 PMX |
| 默认面部资源 | 43 | 29 完整映射、2 部分映射、12 无匹配；特殊控制保留原值 |
| 台词口型 | 3039 | 3037 含曲线，2 个原生空序列；属于全游戏素材，角色归属未确认 |
| 道具模型 | 6 | 白纸飞机、纸飞机、话筒、海豹、磁带、蓝色唱片，可独立灰模查看 |
| 道具配套动画 | 10 | 已关联实际模型，可播放自身骨骼动画 |
| 材质 | 36 | 原始参数、转换结果、纹理及配套文件可查看 |

合计 **3725 个精确路径资源**。583 段骨骼动画中 581 段可播放，另 2 段保留错误记录；3142 项面部/材质/模型/配置资源已提取。319 段身体动作累计约 1502.97 秒、45408 帧，最长单片约 63.1 秒。旧 73 段包含在其中，不重复计数。

全部原始包保留在本机 `outputs/native-complete-20261022/raw/`，共 7450 个 uasset/uexp 文件、99,811,337 字节，逐文件大小与 SHA-256 校验通过。解码数据、模型、纹理、原始包和验收截图/记录均为私有运行产物；当前目录约 2.83 GiB。Git 仅收录工具、筛选元数据、运行模块、测试和说明。

## 实现与证据边界

`Program.cs` 的 `export-complete` 逐个处理明确白名单：归档原始包及哈希；UAnimSequence 经 CUE4Parse/ACL 解码为完整局部骨骼轨迹，再 gzip 保存；有效 additive 使用其原生基准烘焙。局部层只提取允许的骨骼增量，不能把整个衣发文件当作身体姿态。恢复时检查资源来源及文件存在，检查点先写临时文件再替换，最终结果包含此前恢复带入的失败项。

`NativeFaceExport.cs` 读取实际 float curves、插值模式与切线，保存原始属性，不凭文件名编造表情。`native-expression.js` 保留线性、常量、Hermite 和带权 Bezier 插值，通过原生英文 morph 标识和明确半脸别名映射到 PMX。`SeqMouthAlpha` 只是未应用的控制量，不能擅自乘成嘴型幅度。

17 个表情共 108 个曲线通道全部匹配。43 个默认脸共 536 个通道，204 匹配，332 个 `Special_F_*` / `Special_Body_*` 没有当前 PMX 对应；不会猜映射。3039 个口型包含 20734 个可映射通道与 3036 个 `SeqMouthAlpha` 控制。全量面部审计读取 3,585,284 个原生键，完成 7,268,224 次采样检查，无非有限值或解析失败。

`native-resource-layer.js` 将每根允许骨骼的 rest-local 到 sampled-local 增量叠加到本帧身体基底，按绑定轴校准到 PMX；父层只继承一次，不把 source 身体姿态带进局部层。look 明确映射 `Bip001Neck/Head` 到 `首/頭`，排除嘴、脸颊及肘辅助；衣发过滤排除胸部与手腕 helper。PMX 保持位置、长度和缩放；原骨架允许使用真实局部位移与缩放增量。宿主每帧先重放身体，之后叠加局部层，避免累计误差。

两项不能可靠播放的衣发姿态是 `Rib_Fall_LeanPose_0` 和 `Rib_Landslide_Sprint_Pose_F`：源 additive 缺少有效基准。它们已完整归档，页面显示原因，未假造一套参考姿态来让导出“成功”。

身体与表情可以在审阅页叠加，但这次没有把全库自动投入正式 Qwen 语音调度。台词口型缺少配套语音和角色映射，不能称为任意实时音频转口型。道具当前独立播放，人物手部挂接、家具/乐器/手机锚点、原生 shader、游戏衣发物理与碰撞仍需场景适配。循环保留原生首尾差异，没有擅自磨平。新提取资源未改动既有程序动作的身体幅度、近身肘部或利落挥手参数。

## 验证与复现

本机证据目录 `outputs/native-complete-20261022/`：

- `manifest.json`、`export-results.json`：最终清单、可播放/归档状态与错误原因。
- `complete-offline-audit.json`：581 段完整源数据验证，25,155,052 个骨骼变换；319 段身体 × 5 点共 1595 个 PMX 姿态，有限值与骨长通过。
- `face-complete-audit.json`：全部角色表情、默认脸和台词口型的真实曲线与映射覆盖。
- `raw-integrity.json`：7450 个原始文件哈希与大小独立复核。
- `browser-body-acceptance.json`：真实浏览器的身体/蒙皮、切换、暂停与播放验收。
- `ui-layer-browser-audit.json`、`ui-resource-browser-audit.json`：局部叠加与其他资源的实际浏览器验收。
- `ui-clock-browser-audit.json`：1 秒表情重复时，4 秒身体保持自身周期；清层和倒放均不跳姿态。

真实 Chrome 中 319 段身体 × 5 点全部通过，两侧蒙皮均有实际运动，PMX 最大骨长误差为 0，浏览器异常为 0。A→B→A 还原、暂停/恢复、代表片段的循环与末停通过。该批时间轴定位并双侧渲染中位约 5.8 ms、P95 10.2 ms；它不是稳定帧率或穿插检查结论。252 段可播放衣发/注视 × 2 点保持受保护的身体骨骼基底，最大局部差异为 0。另对全部 17 表情、43 默认脸、6 模型、10 道具动画、36 材质和 2 归档记录进行了浏览器检查，口型浏览器抽样 8 项，全量曲线在离线审计覆盖。短表情循环采用累计播放时钟，避免把长身体动作提前截断；清层、暂停、倒放保持确定姿态。

24 项自动回归覆盖原生坐标、插值、单姿态样本、局部叠加与骨长、面部映射/插值、只读资源服务、压缩和路径隔离：

```powershell
node --test tests/native-motion.test.mjs tests/native-library.test.mjs tests/native-expression.test.mjs tests/native-resource-layer.test.mjs tests/native-resources.test.mjs
node realtime/native-resources/server.mjs --port 18792
node --expose-gc scripts/native-motion/audit-complete.mjs
node scripts/native-motion/audit-complete.mjs --integrity-only
node scripts/native-motion/browser-complete-acceptance.cjs
```

提取器需本机 .NET 10、CUE4Parse 源码及 ACL native DLL；沿用 `build-probe.ps1` 构建。索引来源为本机安装的游戏 3.7.13 资源，换版本后应重新生成目录、复核筛选并重新验收。密钥只通过调用者本机文件参数传入，工具和文档不包含值。

```powershell
node scripts/native-motion/build-complete-catalog.mjs
# 各目录变量由本机调用者提供，不将其配置写入仓库。
.\scripts\native-motion\run-complete.ps1 -PaksDirectory $paksDirectory -PatchDirectory $patchDirectory -KeysJson $localKeysFile -ProbeDirectory $probeDirectory -DotNetExe $dotnetExecutable
# 同一白名单意外中断后可明确添加 -Resume。
node scripts/native-motion/audit-complete.mjs
node scripts/native-motion/finalize-complete.mjs
```

本批没有调用任何云端模型，没有合并主分支。发布分支为 `codex/native-complete-resources-20261022`，属于实验性原生资源提取与适配审阅功能。
