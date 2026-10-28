# 完整动作库扩展：生活活动与受支撑交流验收

这份报告只覆盖本轮的生活活动执行、持续中段、暂停恢复、受支撑交流和下巴接触。结论是：**原有 75 项生活活动，加上为真实家具进入补上的 1 项坐姿移椅能力，共 76 项，已在明示前置条件下，通过实际控制器、爱弥斯骨架和物品接触回执逐项跑完；其中 7 项支持延长工作中段，22 项持物变体也分别完成了实际接触验收。** 这证明动作能够执行、结束和正确更新物体归属，不等于已经由人连续看过全部画面，更不证明回复模型会自然使用整个动作库。

实施在独立目录 `F:\AI-Shared\model_test\face-library-expansion-20261027`。测试只读使用本机已有角色资料，无云端调用，没有借用对话测试额度。本文不包含原生 109 组行为的最终验收、完整双工语音测试或模型现场选择动作的结论，它们由总报告另行汇总。

## 1. 什么叫一项生活活动已经完成

负责选择行为的模型决定“做什么”。本地执行器检查眼下是否具备真实支撑和物体条件；播放器推进角色动作；物品显示层根据实际接触决定是否把物品交给手，或者从手交给桌面。台词、动作名字或动画时间到点，都不能代替这些事实。

本次逐项验收沿用这条过程：

1. 明确摆出本项所需的真实场景物品。测试脚本记录这些安排，不伪造“已经拿到”的回执。
2. 需要坐姿时，先实际播放坐下；需要持书、持杯、持笔或抱箱时，先实际拿取。前置步骤失败，后续项目不会被当作成功。
3. 以每步 1/30 秒推进控制器，使用实际模型骨架求出手脚的位置，再更新真实尺寸的物品和接触回执。
4. 检查控制器是否确实结束，最后站着还是坐着、手里有什么、物品还在手上还是已经落在桌面。每项最多推进 900 步，超出则保留失败，不能仅因为等得够久就写“完成”。

这里的“真实模型”是指使用当前爱弥斯 PMX 的骨架尺寸和正向运动学，以及与浏览器共用的物品接触代码。逐项脚本没有绘制 GPU 画面；头发、袖口、裙摆与动作连续观感需要浏览器画面和人工审阅继续确认。

最终逐项记录是 [activity-final-76-v2.json](../outputs/library-expansion-20261027/activity-final-76-v2.json)，使用修复后的真实椅前落座及移椅前置。文件中保留各项前置安排、执行结果、结束现场和失败列表。另用声明的结束姿态、拿取归属和放置归属核对全部结果，[activity-final-76-summary.json](../outputs/library-expansion-20261027/activity-final-76-summary.json) 中没有不符项。可复现脚本为 [audit-activities.mjs](../scripts/character-center/audit-activities.mjs)。此前的 [activity-final-75.json](../outputs/library-expansion-20261027/activity-final-75.json) 保留作历史，不能用它来证明后来才修复的家具进入。`outputs` 属于私有测试结果，不随源码提交；他人在没有私有模型与输出资料的环境中无法直接复现这些模型测试。

## 2. 本轮修复了哪些会阻断实际执行的问题

### 站姿拿物原来等不到抓取请求

场景声明使用分区桌面时，旧采样逻辑会一律采用坐姿的 2.1 秒抓取门控。但是站姿拿物和抱箱的控制器仍在 1.45 秒等待握持回执。身体时间被固定在 1.45 秒，动画永远发不出 2.1 秒的抓取请求。

现在由动作的真实起始姿态决定拿取时序：坐姿长路线保留；站姿和抱箱仍采用自己的 1.45 秒门控。家具采用什么布局，不再错误地改掉另一类动作的时间。书、杯和箱子仍需要测得握点、相对速度以及桌面支撑，才能获得归属。

### 桌后方的书和杯确实需要身体前倾

修好门控后，分区桌面后方的书、杯仍然够不到。这次保留了失败证据，没有直接放宽握持误差。原因是桌后方目标比原先桌边拿取更远。

现在采样器根据物体或摆放目标的实际位置，有限地增加站姿前倾与骨盆前送；脚的位置、骨长和物品世界位置保持原有约束。站姿后桌拿取和放回采用相同的可达范围。拿取目标超过范围时，预检返回“实际握点不可达”，不开始一段注定拿不到的动作。摆放也必须获得真实承接回执，不能把够不到的位置当作已经放好。

**近桌边源位置的旧站姿轨迹保留不变。** 新增回归逐字段比较了它在没有分区桌面声明和有分区桌面声明时的姿态。没有缩小原身体幅度、伸长手臂或者把物品瞬移到手边来通过检查。有限前倾的新增轨迹已通过手脚和物品回执检查；它在全部衣发视角下是否好看，仍须连续画面审阅。

### 明确结束有限时长活动，也要走正常收尾

原来的结束接口只认识“无限保持”。例如把打字总时长设为 90 秒，再要求结束，接口会拒绝结束中段，调用方只能落入通用停止，电脑可能仍开着。

现在有限延长中段同样支持明确结束：从当前进度预留回到原收尾入口的过渡，然后按原速度关电脑。已经进入收尾的任务不会为了再次结束而延长。回归覆盖了 90 秒打字在暂停后被明确结束：头部先平滑撤回注意层，电脑只关闭一次，不重新打开。普通“用户打断后停稳”和“明确完成工作、走正常收尾”仍是不同的含义。

## 3. 时长怎样算，为什么不会靠整段变慢凑数

总时长许可包含实际进入过渡和原动作收尾。播放器在隔离的控制器副本上试算启动，得到本次实际需要的进入时间，再决定可用的工作中段。这一预检不会推进当前身体、修改物品归属或取消正在暂停的活动。

如果模型给出一个允许区间，而区间上限连进入和原动作都装不下，预检直接返回 `unreachable_total_duration`。若只给一个期望值，可以返回实际可达的更长最短时间，并明确说明没有精确达到该值。调用方不能把它继续显示成原期望时间。

没有给延长许可时，继续使用原速单次。给了许可时，只有下面已验证的 7 个工作中段可以扩展。表中的秒数来自现有采样器，是原片段时间，不是用户举例的“4～10 秒”。每项仍保留原来的进入和退出；循环拼接留出 0.4 秒的过渡，使位置和变化速度在接缝处连续。

| 活动 | 原动作时长 | 可延长中段 | 保留的事件与边界 |
| --- | --- | --- | --- |
| 坐着认真倾听（`sit_listen`） | 7 秒 | 原时间 1.3～5.6 秒 | 进入和退出原速；原持物或支撑不重建 |
| 坐着放松休息（`sit_relax`） | 8 秒 | 原时间 1.3～6.6 秒 | 进入和退出原速；原持物或支撑不重建 |
| 站着读书（`read_standing`） | 6 秒 | 原时间 1.2～4.6 秒 | 进入和退出原速；原持物或支撑不重建 |
| 坐着读书（`read_seated`） | 6 秒 | 原时间 1.2～4.6 秒 | 进入和退出原速；原持物或支撑不重建 |
| 桌前边读边思考（`study_at_desk`） | 9 秒 | 原时间 4～7.6 秒 | 进入和退出原速；原翻页事件不重复 |
| 坐着写字（`write_at_desk`） | 8 秒 | 原时间 1.8～6.6 秒 | 进入和退出原速；原持物或支撑不重建 |
| 坐着打字（`type_at_desk`） | 8 秒 | 原时间 2～5.8 秒 | 进入和退出原速；开合电脑仅各一次 |

持续阅读不会反复拿书；持续写字不会反复取笔；持续打字只开一次电脑，再工作，最后关一次。读书中的翻页事件和电脑开合事件留在工作中段之外，不靠重复这些事件填时间。

局部变化也需要许可。目前可用的是小幅注视变化，以及不承担握持或桌面接触的空闲手指放松。持书、握笔、敲键盘的手不会为了添加小动作而松开接触。这些局部变化不另外生成情绪，不改变模型选择的行为含义。

后来补测到一个容易被忽略的情况：坐姿倾听和休息本身没有写“拿书”，但上一段拿书可能仍然成立。中段控制现在同时读取实际继承的握持。两只手都拿书时，手指放松会明确报告被接触约束抑制；单手拿杯时，只有真正空闲的另一只手可以变化。不会先声称小动作已执行，再靠后面的持物覆盖把它抵消。

## 3.1 家具进入为什么额外增加了一项能力

浏览器检查揭示了原数值审计没有覆盖的问题：默认椅子中心在 z=-1.2，座垫向前延伸到 z=1.4；桌子后沿在 z=1.8。两者只有 0.4 个模型单位的空隙，角色不能在这里站直。仅把模型放在桌椅之间，然后让动画开始，并不是有效的落座过程。

修复采用明确的初始布置：独立预览开始时，椅子已经拉到 z=-8.2，桌子和桌面物保持原位置。角色在椅前的安全站位由实际脚部基准计算，不手抄近似坐标：`椅子 z + 1.2 + (3.3 - 左脚原始 z)`。当前模型得到根位置 z=-2.594705891609191。辅助函数只生成初始场景和目标；不会在活动中挪动现有椅子或传送人物。

落座使用原起身轨迹的反向支撑过程：双脚先就在椅子前方，身体屈膝向后降低，不能从座垫里面把腿移出来。坐稳后，新增独立能力“坐稳后移椅到桌前”（`approach_desk_seated`）：脚轮换着支撑，身体和椅子一起前移到桌边，桌和物品仍在原处。这是补上的实际执行能力，因此生活条目由 75 增至 76；没有给旧动作改名凑数。

执行器会检查真椅、真桌、已经坐稳的接触、椅桌朝向和横向位置、可用行程以及明显的地面障碍。朝向差超过 0.04 弧度、横向偏差超过 0.08、垂直偏差超过 0.04，或者所需行程不在 0.15～7.05 个模型单位内时拒绝执行，并保留现场。紧靠桌子的站姿落座返回“没有进入空间”；从侧面或背面直接要求落座返回“需要先到椅前”。不会用一段普通位置混合穿过家具。

三条桌前连续活动——阅读后离开、桌前写作与休息、安静午后——也改成先真实落座，再明确移椅到桌前。独立预览使用“已拉出的椅子”初始场景；实际交互中的旧家具不会被这份初始配方强行重排。若本来已经坐在同一张桌前，已有条件判断可以跳过这两步。

打断落座时，身体完成必要的支撑转移；打断移椅时，座面随实际身体位置平滑停下，之后可以从这把椅子真的停在哪里继续；起身已开始时，先完成必要的站稳，不把人冻在半空。这里的自动验收检查实际骨架的大腿、小腿与座垫体积、躯干与桌板、座面接触及脚部求解，不冒称已经做了皮肤、头发、裙摆的全碰撞模拟。

## 4. 说话时怎样保留坐姿、握持和工作进度

工作暂停只在已确认的工作中段生效：当前必须已经站稳或坐稳，没有正在执行的进入过渡，而且前方留得下收尾。暂停使工作时间逐渐停下来，同时允许头部和视线转向用户；座位、脚和手中的物品继续由原活动保留。

恢复必须指向同一项尚未撤销的活动。控制器核对活动标识和版本，成功后从停住的工作进度继续；不会重新拿书或重新开电脑。错误的、过时的恢复标识被拒绝。任务已被明确撤销时，后续迟到恢复不能把它重新启动。

坐姿或持物下的点头、摇头、侧头、短暂转视线和倾听，使用专门的局部适配层。它保留原活动的脚、骨盆、座位和物体握点，只改变获准的交流部位。原始站姿空手动作并没有因此自动获得“坐着也能全身照播”的许可。

生活库有 15 项行走和转向的持物版本，原有 6 项坐站或静候持物版本，加上本轮新补的坐姿移椅持物版本，共 22 项。这些项目现在不只是目录标记：每项都从真实桌面拿到书或杯，再逐帧经过控制器和物品层验收。双手持书和右手持杯交替选用；坐姿项目有实际座椅，移动项目先实际后退离桌两次，桌子一直留在原位。

验收逐帧核对物品可见、归属不变、握点误差、原拿取回执没有被重新制造、没有偷偷放置；原根位置、身体、骨盆和脚部轨迹与来源逐字段相同，空闲的左手仍保留原动作。最终记录覆盖 3589 个持物帧，其中 3302 个原动作帧完成幅度比较；最大握点误差约为 `4.784×10^-13` 模型单位，最大踝部求解误差约为 `6.226×10^-15`。这些极小数值是同一模型坐标内的数值闭合，不是现实测量精度或人体自然程度评分。

逐项证据见 [activity-held-variants-v3.json](../outputs/library-expansion-20261027/activity-held-variants-v3.json)，复现入口为 [audit-held-variants.mjs](../scripts/character-center/audit-held-variants.mjs)。每项至少通过一套记录下来的实际条件；不把变体数量加成额外独立行为，也不声称测试了每项动作与每种物品、每个家具尺寸及每种朝向的全部组合。

| 变体所属动作 | 本次真实持物 | 验收结果 |
| --- | --- | --- |
| `walk_forward` | 双手持书 | 通过 |
| `walk_backward` | 右手持杯 | 通过 |
| `walk_left` | 双手持书 | 通过 |
| `walk_right` | 右手持杯 | 通过 |
| `walk_forward_left` | 双手持书 | 通过 |
| `walk_forward_right` | 右手持杯 | 通过 |
| `walk_back_left` | 双手持书 | 通过 |
| `walk_back_right` | 右手持杯 | 通过 |
| `walk_slow` | 双手持书 | 通过 |
| `walk_stop` | 右手持杯 | 通过 |
| `turn_left` | 双手持书 | 通过 |
| `turn_right` | 右手持杯 | 通过 |
| `turn_around` | 双手持书 | 通过 |
| `walk_curve_left` | 右手持杯 | 通过 |
| `walk_curve_right` | 双手持书 | 通过 |
| `sit_down` | 右手持杯 | 通过 |
| `stand_up` | 双手持书 | 通过 |
| `stand_up_from_desk` | 右手持杯 | 通过 |
| `approach_desk_seated` | 双手持书 | 通过 |
| `sit_listen` | 右手持杯 | 通过 |
| `sit_relax` | 双手持书 | 通过 |
| `sit_cross_ankles` | 右手持杯 | 通过 |

受支撑交流回归特别验证了：拿书时点头等变化不改变原脚、骨盆和书的握持；新语义不能悄悄替换正在运行的局部动作；局部动作取消后回到当前实际活动，而不是安排另一套新动作。

## 5. 轻点下巴怎样保证是接触，而不是指向固定坐标

新增的轻点下巴是明确可选的一项动作。它不会只因为用户问了问题就自动出现。

接触点来自当前 PMX 下巴皮肤上的实测顶点，先随头骨求出位置，渲染层还可以传入已受嘴部变形影响的皮肤位置。手指目标跟随这个点以及表面方向，不能写成固定世界坐标。右手正在拿东西或承担工作接触时，动作被拒绝。

接触使用食指；其余手指以独立弯曲量自然收拢，避免四指竖直遮在下巴前。原动作没有指定逐指弯曲时，继续用原来的手型参数。测试逐骨比较了这个默认兼容性。

发音时，手指平滑撤离嘴下方空间；停止发音后可以平滑回到允许的接触范围。力度低也不能把整个手臂缩成悬空却仍报告“已经碰到”。数值验收包含头转动、根节点平移、坐姿、嘴部变形后的接触，以及实际手指蒙皮表面没有越过下巴下表面。

这一检查是针对已校准角色和下巴局部皮肤的几何验证，不是全身体积碰撞系统。不能由它推出所有袖口、头发和脸部区域在任意组合下都不会相交。

## 6. 76 项生活活动逐项覆盖

以下每一行都有最终逐项记录，均在该行声明的站坐、道具和握持条件下完成。测试前明确建立的道具场景，不等于运行时会替模型自动摆家具。实际交互中，缺道具、支撑不成立、手被占用或目标超出可达范围，必须返回原因，让模型基于真实现场选择下一步。

**抱箱范围特别说明：** `pickup_box` 的现有名称是“从台面抱起物品”。本轮测试把箱子实际放在桌面上，由接触回执交给双手。默认场景中的箱子若在地上，这个动作应被拒绝，不能把地面附件改一个标签后假装台面拾取。地面抱箱需要自己的动作和地面接触回执，不在这条既有动作已通过的含义之内。

### 行走与转向：15 项

| 动作 | 标识 | 本次执行条件 | 结束支撑 | 结果 |
| --- | --- | --- | --- | --- |
| 向前走 | `walk_forward` | 站姿 | 站姿 | 完成 |
| 向后退 | `walk_backward` | 站姿 | 站姿 | 完成 |
| 向左侧移 | `walk_left` | 站姿 | 站姿 | 完成 |
| 向右侧移 | `walk_right` | 站姿 | 站姿 | 完成 |
| 向左前方走 | `walk_forward_left` | 站姿 | 站姿 | 完成 |
| 向右前方走 | `walk_forward_right` | 站姿 | 站姿 | 完成 |
| 向左后方退 | `walk_back_left` | 站姿 | 站姿 | 完成 |
| 向右后方退 | `walk_back_right` | 站姿 | 站姿 | 完成 |
| 慢慢踱步 | `walk_slow` | 站姿 | 站姿 | 完成 |
| 走两步停下来 | `walk_stop` | 站姿 | 站姿 | 完成 |
| 踏步左转 | `turn_left` | 站姿 | 站姿 | 完成 |
| 踏步右转 | `turn_right` | 站姿 | 站姿 | 完成 |
| 转身回望 | `turn_around` | 站姿 | 站姿 | 完成 |
| 向左绕弯走 | `walk_curve_left` | 站姿 | 站姿 | 完成 |
| 向右绕弯走 | `walk_curve_right` | 站姿 | 站姿 | 完成 |

### 跑步与快速并步：5 项

| 动作 | 标识 | 本次执行条件 | 结束支撑 | 结果 |
| --- | --- | --- | --- | --- |
| 轻松慢跑 | `jog_forward` | 站姿、双手可用 | 站姿 | 完成 |
| 加速跑几步 | `run_forward` | 站姿、双手可用 | 站姿 | 完成 |
| 原地小跑 | `jog_in_place` | 站姿、双手可用 | 站姿 | 完成 |
| 向左快速并步 | `side_shuffle_left` | 站姿、双手可用 | 站姿 | 完成 |
| 向右快速并步 | `side_shuffle_right` | 站姿、双手可用 | 站姿 | 完成 |

### 跳跃：8 项

| 动作 | 标识 | 本次执行条件 | 结束支撑 | 结果 |
| --- | --- | --- | --- | --- |
| 原地起跳落地 | `jump_vertical` | 站姿、双手可用 | 站姿 | 完成 |
| 向前跳 | `jump_forward` | 站姿、双手可用 | 站姿 | 完成 |
| 向左跳 | `jump_left` | 站姿、双手可用 | 站姿 | 完成 |
| 向右跳 | `jump_right` | 站姿、双手可用 | 站姿 | 完成 |
| 小幅后跳 | `jump_backward` | 站姿、双手可用 | 站姿 | 完成 |
| 轻轻弹跳 | `small_hop` | 站姿、双手可用 | 站姿 | 完成 |
| 跳起转身 | `jump_turn` | 站姿、双手可用 | 站姿 | 完成 |
| 开合跳 | `jumping_jack` | 站姿、双手可用 | 站姿 | 完成 |

### 坐站与坐姿表现：10 项

| 动作 | 标识 | 本次执行条件 | 结束支撑 | 结果 |
| --- | --- | --- | --- | --- |
| 靠近椅子坐下 | `sit_down` | 真实椅前站位、已拉出的椅子、前方空间可用 | 坐姿 | 完成 |
| 扶稳慢慢坐下 | `sit_down_carefully` | 真实椅前站位、已拉出的椅子、双手可用 | 坐姿 | 完成 |
| 从椅子上站起 | `stand_up` | 坐姿、椅子、椅前没有被桌面占据 | 站姿 | 完成 |
| 退椅离桌后起身 | `stand_up_from_desk` | 坐姿、椅子、桌面 | 站姿 | 完成 |
| 坐稳后移椅到桌前 | `approach_desk_seated` | 已坐在拉出的椅上、椅桌对齐、实际前移空间可用 | 坐姿，椅与人实际前移 | 完成 |
| 坐着认真倾听 | `sit_listen` | 坐姿、椅子 | 坐姿 | 完成 |
| 坐着放松休息 | `sit_relax` | 坐姿、椅子 | 坐姿 | 完成 |
| 坐着抬手交谈 | `sit_talk` | 坐姿、椅子、右手可用 | 坐姿 | 完成 |
| 坐着伸个懒腰 | `sit_stretch` | 坐姿、椅子、双手可用 | 坐姿 | 完成 |
| 坐着轻交脚踝 | `sit_cross_ankles` | 坐姿、椅子 | 坐姿 | 完成 |

### 阅读：7 项

| 动作 | 标识 | 本次执行条件 | 结束支撑 | 结果 |
| --- | --- | --- | --- | --- |
| 站着读书 | `read_standing` | 站姿、书、已实际持有书 | 站姿 | 完成 |
| 坐着读书 | `read_seated` | 坐姿、椅子、书、已实际持有书 | 坐姿 | 完成 |
| 站着翻页 | `page_turn_standing` | 站姿、书、已实际持有书 | 站姿 | 完成 |
| 坐着翻页 | `page_turn_seated` | 坐姿、椅子、书、已实际持有书 | 坐姿 | 完成 |
| 读书时抬头回应 | `read_look_up` | 坐姿、椅子、书、已实际持有书 | 坐姿 | 完成 |
| 合上书想一想 | `close_book` | 坐姿、椅子、书、已实际持有书 | 坐姿 | 完成 |
| 桌前边读边思考 | `study_at_desk` | 坐姿、椅子、书、桌面、已实际持有书 | 坐姿 | 完成 |

### 运动与伸展：15 项

| 动作 | 标识 | 本次执行条件 | 结束支撑 | 结果 |
| --- | --- | --- | --- | --- |
| 完整深蹲一次 | `squat` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 下蹲保持再站起 | `squat_hold` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 左腿前弓步 | `lunge_left` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 右腿前弓步 | `lunge_right` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 左侧弓步 | `side_lunge_left` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 右侧弓步 | `side_lunge_right` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 抬左脚单腿平衡 | `balance_left` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 抬右脚单腿平衡 | `balance_right` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 双臂向上伸展 | `stretch_up` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 向左侧伸展 | `stretch_left` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 向右侧伸展 | `stretch_right` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 站姿左右转体 | `torso_twist` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 站姿向前舒展 | `forward_fold` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 舒展肩膀 | `shoulder_roll` | 站姿、运动垫、双手可用 | 站姿 | 完成 |
| 重心流动与推掌 | `tai_chi_shift` | 站姿、运动垫、双手可用 | 站姿 | 完成 |

### 日常取放与工作：16 项

| 动作 | 标识 | 本次执行条件 | 结束支撑 | 结果 |
| --- | --- | --- | --- | --- |
| 站着举杯喝水 | `drink_standing` | 站姿、杯、已实际持有杯 | 站姿 | 完成 |
| 坐着举杯喝水 | `drink_seated` | 坐姿、椅子、杯、已实际持有杯 | 坐姿 | 完成 |
| 坐着写字 | `write_at_desk` | 坐姿、椅子、桌面、纸、笔、已实际持有笔、左手可用 | 坐姿 | 完成 |
| 坐着打字 | `type_at_desk` | 坐姿、椅子、桌面、电脑、双手可用 | 坐姿 | 完成 |
| 从台面抱起物品 | `pickup_box` | 站姿、桌面、箱子、箱子原先在桌面 | 站姿 | 完成 |
| 抱着物品后退离桌 | `carry_box` | 站姿、箱子、已实际持有箱子 | 站姿 | 完成 |
| 站着把书稳放桌面 | `put_book_standing` | 站姿、桌面、书、已实际持有书 | 站姿 | 完成 |
| 坐着把书稳放桌面 | `put_book_seated` | 坐姿、椅子、桌面、书、已实际持有书 | 坐姿 | 完成 |
| 站着放稳杯子 | `put_mug_standing` | 站姿、桌面、杯、已实际持有杯 | 站姿 | 完成 |
| 坐着放稳杯子 | `put_mug_seated` | 坐姿、椅子、桌面、杯、已实际持有杯 | 坐姿 | 完成 |
| 写完后把笔放稳 | `put_pencil_seated` | 坐姿、椅子、桌面、笔、已实际持有笔 | 坐姿 | 完成 |
| 站着从桌面拿书 | `take_book_standing` | 站姿、桌面、书、书原先在桌面 | 站姿 | 完成 |
| 坐着从桌面拿书 | `take_book_seated` | 坐姿、椅子、桌面、书、书原先在桌面 | 坐姿 | 完成 |
| 站着拿稳杯子 | `take_mug_standing` | 站姿、桌面、杯、杯原先在桌面 | 站姿 | 完成 |
| 坐着拿稳杯子 | `take_mug_seated` | 坐姿、椅子、桌面、杯、杯原先在桌面 | 坐姿 | 完成 |
| 坐着拿起桌上的笔 | `take_pencil_seated` | 坐姿、椅子、桌面、笔、笔原先在桌面 | 坐姿 | 完成 |

## 7. 已实际运行的测试与结果

本代理先合跑以下三份测试文件，**31 项通过、0 失败、0 跳过**：

```powershell
node --test tests/activity-continuation.test.mjs tests/supported-conversation.test.mjs tests/activity-standing-take.test.mjs
```

随后修正预检的旧速度选项时长元数据，相关只读预检 2 项再次通过，不累计为不同测试。补家具进入与继承握持后，又用当前源码合跑上述三份加上 `activity-micro-permissions.test.mjs`、`activity-furniture-entry.test.mjs`，**49 项通过、0 失败、0 跳过**；包括 7 项中段许可与 11 项家具进入/打断。之前独立运行的普通拿取测试 8 项通过；它们使用普通桌面条件，不拿这份结果替代新分区桌面的回归。随后另外运行三条迁移后完整桌前活动链，3 项全部通过。合计为 60 个不同回归项（当前源码合跑 49 + 完整活动链 3 + 之前独立普通拿取 8），不把重复执行累计成更多项目。下面按测试名称列出。

76 项逐项运行和 22 项持物变体是另外两份执行审计，不混进单元回归数量。旧代理已经跑过的 `full-body-controller.test.mjs` 14 项，在当时都通过，包括旧 75 项完成和三时点打断；当次合跑命令里另有后来修复的新测试失败，所以不能把那条历史命令写成“整条全绿”。本代理没有为了增加数字再次运行那份约 320 秒的旧全套；当前家具进入另有新专用检查。旧证据保存在 [activity-state-audit.json](../outputs/library-expansion-20261027/activity-state-audit.json) 的 `reusedEvidence` 中。

### tests/activity-continuation.test.mjs：14 项通过

1. `all 76 default activities use their source sampler unchanged` — 通过。
2. `each declared working middle preserves exact source entry and exit at irregular durations` — 通过。
3. `overlapped middle loops and arbitrary exit seams preserve pose and velocity, including contact targets` — 通过。
4. `long typing opens once, works with the lid open, then closes once at source speed` — 通过。
5. `holding retains source object events and release allocates a complete exit` — 通过。
6. `micro variation never uncurls a holding or surface-contact hand` — 通过。
7. `attention keeps a typing task and its open laptop; only a matching explicit resume advances it` — 通过。
8. `a stop while attention-paused invalidates resume, keeps seat and prop ownership, and can safely play a new activity` — 通过。
9. `duration options preserve default speed and reject unsupported or shorter actions without disturbing owner` — 通过。
10. `explicit finish during attention exits without reopening the laptop or allowing a stale resume` — 通过。
11. `read pause preserves the measured held book and resumes the same acquisition epoch` — 通过。
12. `read-only duration preparation reserves the actual entry bridge and refuses an impossible range atomically` — 通过。
13. `read-only preparation can evaluate a measured adoption without replacing a live activity or retaining its attention object` — 通过。
14. `explicit finish of a finite extended task uses its original exit and closes the laptop exactly once` — 通过。

### tests/supported-conversation.test.mjs：10 项通过

1. `supported gestures retain actual feet, seat and held book contacts while moving the head` — 通过。
2. `overlay cancellation returns to current task and never schedules another gesture` — 通过。
3. `measured native-like seated and standing poses preserve world root, support, chest, and feet on adoption` — 通过。
4. `unverified seat, unknown support and incomplete measured frames are rejected without changing the owner` — 通过。
5. `chin marker is an actual head-skinned underside face vertex in the private PMX` — 通过。
6. `chin tip contact follows live head rotation, translated root, seat and rendered mouth-morph point` — 通过。
7. `voicing retreat is continuous and the chin gesture cannot occupy a typing or holding hand` — 通过。
8. `soft chin touch still reaches the measured surface and cancellation returns without frozen contact` — 通过。
9. `chin touch keeps its index contact while the other fingers fold naturally and zero dt preserves the pose` — 通过。
10. `real skinned finger surfaces remain outside the underside chin plane during contact and voicing` — 通过。

### tests/activity-standing-take.test.mjs：7 项通过

1. `take_book_standing uses its own gate in a partitioned scene, and an actual stationary object grants ownership` — 通过。
2. `take_mug_standing uses its own gate in a partitioned scene, and an actual stationary object grants ownership` — 通过。
3. `pickup_box uses its own gate in a partitioned scene, and an actual stationary object grants ownership` — 通过。
4. `far standing sources are rejected before the live controller, prop or prior ownership changes` — 通过。
5. `near-edge standing sources preserve the original source pose even with partitioned furniture declared` — 通过。
6. `standing book can return to its real back-desk support without a timed ownership shortcut` — 通过。
7. `standing mug can return to its real back-desk support without a timed ownership shortcut` — 通过。

### tests/activity-prop-take.test.mjs：8 项通过

1. `take_book_standing: source is physically present and stationary until real hand contact grants ownership; first acquisition is continuous` — 通过。
2. `take_book_seated: source is physically present and stationary until real hand contact grants ownership; first acquisition is continuous` — 通过。
3. `take_mug_standing: source is physically present and stationary until real hand contact grants ownership; first acquisition is continuous` — 通过。
4. `take_mug_seated: source is physically present and stationary until real hand contact grants ownership; first acquisition is continuous` — 通过。
5. `take_pencil_seated: source is physically present and stationary until real hand contact grants ownership; first acquisition is continuous` — 通过。
6. `pickup_box: source is physically present and stationary until real hand contact grants ownership; first acquisition is continuous` — 通过。
7. `take cannot create an absent object or table, and unknown start hand anchors block approach` — 通过。
8. `actual hand acquisition and tabletop footprint are invariant under a common scene yaw` — 通过。

### tests/activity-micro-permissions.test.mjs：7 项通过

1. `sit_listen: explicit micro permissions preserve all real grips and source exits` — 通过。
2. `sit_relax: explicit micro permissions preserve all real grips and source exits` — 通过。
3. `read_standing: explicit micro permissions preserve all real grips and source exits` — 通过。
4. `read_seated: explicit micro permissions preserve all real grips and source exits` — 通过。
5. `study_at_desk: explicit micro permissions preserve all real grips and source exits` — 通过。
6. `write_at_desk: explicit micro permissions preserve all real grips and source exits` — 通过。
7. `type_at_desk: explicit micro permissions preserve all real grips and source exits` — 通过。

这些测试对每个中段分别比较未许可、只许可注视、只许可手指、两者均许可的实际采样；未知许可拒绝且不换主人。实际执行中持续核对持物握点，坐姿倾听和休息额外从真实拿书接入，确认继承握点也会禁止手指放松。记录见 [activity-micro-permissions.json](../outputs/library-expansion-20261027/activity-micro-permissions.json)。

### tests/activity-furniture-entry.test.mjs：14 项通过（11 项进入/打断，加 3 条完整活动链）

1. `tight desk refuses standing entry and side approach before changing any owner` — 通过。
2. `pulled-out actual chair accepts front lowering and supported approach, then actual retreat and rise` — 通过。
3. `a real floor box blocks the entry route without moving it aside` — 通过。
4. `sit_down interrupted at 0.4s stops on real support and can resume explicitly` — 通过。
5. `sit_down interrupted at 1.4s stops on real support and can resume explicitly` — 通过。
6. `sit_down interrupted at 2.6s stops on real support and can resume explicitly` — 通过。
7. `approach_desk_seated interrupted at 0.5s stops on real support and can resume explicitly` — 通过。
8. `approach_desk_seated interrupted at 1.7s stops on real support and can resume explicitly` — 通过。
9. `approach_desk_seated interrupted at 2.7s stops on real support and can resume explicitly` — 通过。
10. `stand_up interrupted at 0.9s stops on real support and can resume explicitly` — 通过。
11. `stand_up interrupted at 1.8s stops on real support and can resume explicitly` — 通过。

12. `reading_break executes the declared pulled-chair entry and complete unchanged furniture sequence` — 通过。
13. `desk_session executes the declared pulled-chair entry and complete unchanged furniture sequence` — 通过。
14. `quiet_afternoon executes the declared pulled-chair entry and complete unchanged furniture sequence` — 通过。

原始记录见 [activity-furniture-entry.json](../outputs/library-expansion-20261027/activity-furniture-entry.json)。骨段检查覆盖大腿、小腿和座垫、躯干和桌板；接触检查覆盖实际座位与双脚。这里没有把身体中心线无交叉当作全部皮肤或衣物碰撞通过。

## 8. 保留的失败记录与不能越过的证据边界

最初的 [activity-state-audit.json](../outputs/library-expansion-20261027/activity-state-audit.json) 保留了 9 项失败；其中一些是拿取失败后，依赖它的读书、翻页、喝水或放回无法开始。修门控后的 [activity-nine-retest.json](../outputs/library-expansion-20261027/activity-nine-retest.json) 继续保留真实不可达情况，没有抹掉失败。后续 [activity-reach-retest.json](../outputs/library-expansion-20261027/activity-reach-retest.json)、[activity-put-retest.json](../outputs/library-expansion-20261027/activity-put-retest.json) 与最终 75 项报告分别记录修复后的取物、放物和整库结果。

更严格补验收时的记录也保留：`activity-held-probe.json`、`activity-held-variants-initial.json`、`activity-held-seated-retest.json` 与 `activity-micro-permissions-first.json`。初版持物测试曾把较高的 PMX 根骨误当成座垫接触点，后来改为采样器已有的 10.55 坐姿接触基准；初版读书测试曾不允许正常翻页时暂时变为左手持书，后来按实际动作修改了测试条件。这两项属于测试假设纠正。起身初段的支撑标签也修正为：骨盆开始离座后由脚承担支撑，不能仍把这一小段称为座面接触。现在的 76、22 和 7 项结果使用新进入条件和最新控制器重新执行，旧失败没有被覆盖。

本报告可以支持的结论是：在记录过的条件下，76 项能够被实际执行到声明结束状态，22 项持物变体有实际握点与原身体幅度证据；受约束中段、暂停恢复、家具进入、下巴接触与真实拿放具有相应回归证据。

本报告不能单独支持以下结论：

- 模型已经自主且自然地使用了全部新能力。本轮是显式本地命令，没有新云端对话。
- 全部动作经过人工连续观看并被认为流畅。数值、浏览器渲染与人工观感必须分别记录。
- 任意新家具尺寸、任意物体位置或任意模型都能直接使用这些轨迹。真实几何不在校准范围内时应重新检查。
- 每个原生来源、每一种身体与表情组合、所有衣发碰撞都已经通过。本报告只覆盖上述生活执行与局部能力；原生和整体展示见总报告。
- 任意方向的导航和拉空椅已经完成。当前新增的是从明确可进入的椅前落座，以及坐稳后用脚移椅；独立场景的椅子从开始就已拉出。已有紧靠桌面的椅子不会在用户交互中自行瞬移到拉出位置，条件不满足会拒绝并说明。
- 背景业务已经完成。动作结束只说明身体表现结束，后台任务是否完成仍由业务记录决定。

人工审阅应优先看：后桌站姿拿放的前倾和袖口、手持书的侧面遮挡、坐姿倾听时座位与脚、有限长打字的暂停恢复和正常关盖、轻点下巴的正面及右侧视角。观察不佳时，应退回对应动作修复；不能用这份通过表替代审阅。

## 9. 最终旧入口、连续流程与逐帧接触复核（2026-10-28）

本节补充扩库完成后的旧入口回归。旧预览曾依赖“调用坐下就顺带出现家具”的准备方式，新版必须区分空舞台布景和已经存在的现场。旧 `realtime/activities/viewer.mjs` 现在只在没有可见物品、没有正在执行动作的空舞台读取活动组声明的初始场景：椅子初始拉出 7 个模型单位，人在计算得到的椅前站位。实际落座、移椅到桌前、取放和退椅仍逐段执行。桌椅或物品已经存在时，不会为了播放成功而重排；旧 `ActivityDirector` 会返回缺少实测初始场景、进入位置被挡或具体路线被家具阻挡等原因。

三个旧测试文件中的场景也改为同一明确起点。原来的握点误差上限 0.025、手臂目标可达比例上限 0.995001、脚部误差、世界位置连续性和取消后不复活断言均保留。`activity-sequences.test.mjs` 保留了真实桌椅网格包围盒的退出检测，还用一个脱离现场的探针重演不安全直走：它确实能撞到桌板；公开播放入口同时必须拒绝该路线，且拒绝不能改变身体或道具。

移动的安全检查在执行前从当前真实姿态准备一份隔离轨迹，检查实际骨骼与桌、椅、箱、平台的实体部件。它覆盖步行、跑跳和搬运；正常坐姿桌面接触仍走各自的接触检查。循环动作每一圈都重新检查下一圈，不会因为第一圈安全便盲目继续。检查失败保留当前已到达位置并报告原因，不会暗中改成绕行或回中。

逐帧复核又发现并修正了以下实际问题：

- **刚拿到就放回，以及刚放好就重新拿起：** 原实现可能从已经前探的位置再叠加一次前探。现在以椅子原有支撑位置计算目标，从当前已达到的身体位置开始；已经处于放置目标时不再绕回桌前后又送回。旧入口还会保留同一真实桌面的布局上下文，省略重复参数不会把桌后物品误当成桌边物品。
- **展开的书放到闭书存放位：** 不能把展开的书直接旋转到预设闭书姿态。现在放书包含 1.4 秒的实际收合子阶段，双手跟随封面上的真实握点，收合完成后才进入原放置路线。它仍是一次放书行为，完成仍必须拿到实际桌面回执。闭书保持原时长；展开书的实际动作时长、只读准备估算与打断时钟都包含这额外的 1.4 秒。
- **从闭书持握转到展开阅读的极短接缝：** 240 Hz 检查发现过一个握点误差超过 0.025 的帧。桥接中增加了向内的肘部导向，起点和终点的改变量及速度均为零；身体幅度和原动作两端不变，没有把肘部向外撑。修后同一诊断记录为零个超限帧。

新增 `tests/activity-legacy-entry-contact.test.mjs` 单独验证站姿和坐姿放展开书的实际收合、总时长、接触与回执，验证收合、移动放置、即将释放三个时刻的中断，并验证空舞台初始化和旧紧桌现场的原子拒绝。最终通过数及完整回归日志以本节下方的执行回执为准；保留早期失败日志，不以某一项最终姿态完成替代整段逐帧验收。

### 最终执行回执

最后的活动业务源保持不变后，完整连续性证据为 `sourceStable=true`、`coverageComplete=true`，共 **433 条**分类验收记录。76 项完成、228 个活动三阶段取消、7 条完整活动组、21 个活动组阶段取消、4 个非零速度衔接、5 个持物变体过渡、23 个拿放回执帧竞争、56 个跨活动组持物入口、1 个已放物现场复用、2 个退椅取消和10 个真实坐姿入口全部记录完毕。实际持物和表面目标检查失败均为 **0**；最大握点误差为 `6.1222e-9`，最大表面目标误差为 `9.6508e-9`，最大手臂目标可达比例为 `0.991764`。这些数值是模型单位下的骨骼与道具计算误差，不能等同于衣物碰撞或人工观感结论。

| 最终检查 | 结果 | 记录 |
| --- | --- | --- |
| 旧入口、连续性、完整活动组与新收书接触 | 43 / 43，通过，进程退出码 0 | [activity-legacy-final-v2.log](../outputs/library-expansion-20261027/activity-legacy-final-v2.log) |
| 中段、家具进入与打断、微动作许可、站姿实际拿放 | 42 / 42，通过，进程退出码 0 | [activity-owned-final.log](../outputs/library-expansion-20261027/activity-owned-final.log) |
| 支持姿态交流、下巴接触及实际皮肤点 | 10 / 10，通过，进程退出码 0 | [activity-supported-final.log](../outputs/library-expansion-20261027/activity-supported-final.log) |
| 全部生活活动实体审计 | 76 / 76，无失败 | [activity-final-76-v2.json](../outputs/library-expansion-20261027/activity-final-76-v2.json) |
| 全部开放持物变体 | 22 / 22，无失败 | [activity-held-variants-v3.json](../outputs/library-expansion-20261027/activity-held-variants-v3.json) |
| 7 个可延长中段的允许／禁止微变化 | 7 / 7，无失败 | [activity-micro-permissions.json](../outputs/library-expansion-20261027/activity-micro-permissions.json) |

以上三组 Node 合计 **95 项测试通过**。活动、变体及中段审计是另外的逐项证据，不将它们简单混成一个“测试总数”。旧失败批 `activity-legacy-final.log`、`activity-legacy-targeted.log` 和 `activity-legacy-contact-v2/v3.log` 保留；最终成功批使用新的文件名。

汇总及可复跑命令保存在 [activity-final-validation-summary.json](../outputs/library-expansion-20261027/activity-final-validation-summary.json)。当前目录为 262 项，最终目录 hash 为 `sha256:88c8ca9dc4fde9d8da4e86e768d97a32f1fc2dd92ce7a7eb4f129232b469116b`；后一次目录变化仅补充了模型可见条件与展开书需要额外 1.4 秒真实收合的说明。

旧入口新增复核的 43 个实际测试名称及结果如下（每项均通过）：

- `quintic bridge retains nonzero measured boundary velocities` — 通过。
- `nonstationary actual PMX wrist velocity survives replacement and seated cancellation` — 通过。
- `a body owner changed outside the director cannot resume an old sequence` — 通过。
- `a held fixed-size book retains its grip in declared variants and atomically rejects a main hand gesture` — 通过。
- `a moving held book and its measured palm continue their nonzero velocity when interrupted` — 通过。
- `a placement clock never fabricates a receipt and cancelled transfer owners cannot release later` — 通过。
- `all six actual takes preserve acquired ownership when stopped, replaced or placed in the receipt frame` — 通过。
- `every real placement permits an immediate new take in the same receipt frame` — 通过。
- `all published activities and three different-phase cancellation probes preserve real FK and ownership` — 通过。
- `all seven complete recipes use real placement receipts and do not drop persistent objects between steps` — 通过。
- `all seven recipes cancel during preparation, a live middle activity, and the final recovery without reviving later steps` — 通过。
- `the farther reading desk retreat retains default clips and stops safely during seated retreat and rising` — 通过。
- `all four real held objects enter or atomically reject all seven recipes without scene setup stealing ownership` — 通过。
- `a real previously placed book keeps its attained world pose or atomically rejects an incompatible desk recipe` — 通过。
- `a stable real seated desk entry satisfies the introduction explicitly and preserves actual acquisition ownership` — 通过。
- `unmatched or unfinished actual seated desk entries reject atomically without reenacting a standing introduction` — 通过。
- `whole partitioned desk recipe keeps every actual hand constraint reachable including laptop lid contact` — 通过。
- `existing incompatible paper or open laptop is diagnosed before fixed-zone layout admission` — 通过。
- `writing uses the actual retained paper frame rather than an invented default center` — 通过。
- `sequence pause freezes its rest deadline and resuming starts only the next activity` — 通过。
- `stop retires all future sequence steps even after the body reports finished landing` — 通过。
- `manual replacement retires sequence and invalid replacement does not cancel a valid owner` — 通过。
- `reset retires the sequence and resets the clock without an old step reviving` — 通过。
- `an incompatible held object rejects a whole recipe before changing the current owner` — 通过。
- `an already held first take is explicitly satisfied without dispatching or fabricating acquisition` — 通过。
- `an existing incompatible desk layout is rejected without moving or hiding its real objects` — 通过。
- `a recipe forwards the desk context per step along with its explicit initial setup` — 通过。
- `open book standing placement includes physical cover closure in measured preparation and receipt` — 通过。
- `open book seated placement includes physical cover closure in measured preparation and receipt` — 通过。
- `legacy declared initial scene is created only while empty and existing stage is preserved` — 通过。
- `legacy existing tight desk returns the actual entry obstruction without re-staging objects` — 通过。
- `open book placement interruption during closing preserves actual object ownership` — 通过。
- `open book placement interruption during placing preserves actual object ownership` — 通过。
- `open book placement interruption during release preserves actual object ownership` — 通过。
- `real sequence reading_break executes all 12 steps and retains its final world state` — 通过。
- `real sequence morning_movement executes all 9 steps and retains its final world state` — 通过。
- `real sequence agility_practice executes all 8 steps and retains its final world state` — 通过。
- `real sequence desk_session executes all 15 steps and retains its final world state` — 通过。
- `real sequence quiet_afternoon executes all 12 steps and retains its final world state` — 通过。
- `real sequence balance_flow executes all 7 steps and retains its final world state` — 通过。
- `real sequence carry_delivery executes all 2 steps and retains its final world state` — 通过。
- `director interruption during a real sequence jump retires all remaining steps and lets the body land` — 通过。
- `the exit clearance probe detects an unsafe straight walk through the retained tabletop` — 通过。
