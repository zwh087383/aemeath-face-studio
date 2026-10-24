# 原生动作用途准备：先知道她为什么能做，再决定怎样接入

日期：2026-10-23。本页只说明本轮离线用途整理；未修改正式人物、语音或记忆代码，未调用云端模型。

本轮把当前319段原生身体片段全部放进了有具体用途和限制的审阅分组。它们归到146个名称家族，由88条规则覆盖；每段恰好命中一条，没有漏项或重复命中。**这不是新增319套完整动作，也不代表319段都可以自动使用。**起势、循环和收势仍分别计算片段数。

这里146按去掉阶段后缀的名字合并。执行与接缝测量保留完整源目录，因此有149个来源组，不能跨目录借用同名End。按名称统计缺End17组、单段49组；按完整目录则缺End18组、单段50组，缺Start均为7组。后续实际拼接使用完整来源组，名称统计只帮助查找。

机器可读资料在[原生用途规则](../preparation/native-usage-rules.json)。完整本机逐片段来源、覆盖和阶段缺口记录在私有审阅文件；原始动作和曲线不进入公开说明。

## 由谁判断，依据是什么，没看懂怎么办

负责回复的Qwen说明用户要求与这段话想表达的意思；已有后台分析可说明具体需要消化什么。数学情绪系统提供最终情绪。本地程序核对正在播放哪段话、手是否空闲、坐站、场景物体与取消记录。素材含义、接触和可退出阶段由我们用轨迹及真实模型检查，不让Qwen根据文件名批准。

如果只知道名字，规则就写“名称候选，未确认”。如果没有椅子、物体、另一人物或退出路线，就只供预览。没有动作建议时，声音正常继续；迟到的建议不在下一句话补演。

名字和目录能帮助找素材，但不能证明表演含义。旧73片段的适配/浏览采样记录是有用基线；它没有证明全部319片段的语义、道具接触、自然衔接和任意阶段打断。

## 已经准备了哪些用途

| 方向 | 已明确的使用边界 |
| --- | --- |
| 站姿保持、平静交流 | 先确认真实站姿与衣发；双方都叫站姿不等于能直接切换。呼吸素材是完整姿态，不能当万能呼吸叠层。 |
| 说话、解释、转折、指向、思考 | Qwen提供目的，本地核对时机、身体与真实目标；每个字幕块不重启一次手势。 |
| 开心、害羞、尴尬、抱怨、别扭等 | 数学状态与具体事件共同约束，不用情绪词直接发令，不把持续情绪反复演成新事件。 |
| 坐姿说话、思考、后靠、晃腿 | 必须已经坐稳并有匹配的座面/靠背；不同坐姿编号先分开核对。坐姿End不等于通用起身。 |
| 转身、走路、跑步 | 要有真实移动理由、路线和落脚出口；原生转身含根部位移，不能只旋转外层模型。 |
| 脸边手势、拨发、响指、招呼 | 近脸袖口/长发和回收路线需看实模；原生致意有位移，不直接取代当前利落挥手。 |
| 纸飞机、吉他、手机、键盘、麦克风 | 先有对应物体与真实握点/放回过程。当前有某类道具，也不证明与每个演出自动配套。 |
| 牵手、握手、拥抱、被拉、倚靠 | 对方或承接表面必须存在；单人空场播放不算多人互动或接触已支持。 |
| 展示界面、长待机、特殊剧情 | 先查实际道具/相机/战斗和出口，不用来随机填满普通交谈。 |

用户已经排除攻击动作。当前319条身体原名没有命中常用英文攻击关键词，**这只能说明名称扫描没命中，不能证明每段都非攻击。**准备姿态、未知拼音、长演出与特殊剧情仍需观看排除攻击和武器展示。

## 哪些阶段明显还缺

按名称去掉阶段后缀后，有7个家族没找到Start，17个家族没找到End。49个家族只有单段式文件；单段式也不能默认有完整起收。

| 没有找到的阶段 | 涉及家族 | 实际处理 |
| --- | --- | --- |
| Start | DZ_GuabiziEND、DZ_Motor_shouji01、DZ_Pa01、DZ_Sit_laugh01、Motor_Dajian01、Run_cidai、Sit02 | 先确认当前姿态是否本来就适合；否则补进入过程，不能从站立直接切循环。 |
| End | DZ_Baoku01、DZ_Beishouzhuanshen01、DZ_Liaotoufa01、DZ_Mofang01、DZ_Mofang02、DZ_Shenshou01、DZ_SitUP、DZ_Taishou01、DZ_Taishou02、DZ_Woshou01、DZ_Woshou_01、Hold_hands、keboard01、Motor_Dajian01、Readiness03、Sit04_Head、Take_Mai01 | 先补可退出路线和阶段，不用相似名字的其它End补位。 |

有Start、Loop、End的家族也仍需检查。循环中的任意一帧，未必能进入End的第一帧；脚在移动时要先落脚，手在脸旁要先离开碰撞范围。不能用文件齐全代替实际可执行。

## 原生与现有原创怎样比较

| 原生候选 | 现有近似原创 | 保留或补做的判断 |
| --- | --- | --- |
| standing-talk、calm-dialogue、turn-in-explanation、show-hand | explain、explain_firm、clarify、compare_options、enumerate_two、explain_sequence | 先比较一般解释与原生说话/展手是否重复。左右权衡、分两点、被打断后接续属于可能的组织能力差异，需实际轨迹比较后才保留为缺口。 |
| thinking-standing-one、thinking-standing-two、seated-thinking | think、thinking_glance、recall_up | 不能将完整托腮与低幅移目简单认定等价；记录原生实际幅度及手是否占用，原创只补合适的低占用反应或可控衔接。 |
| greeting-hand、salute-movement、dorm-farewell | wave、greet、warm_welcome、farewell_linger | 比较原地/位移、坐站、节奏与退出。Salut有位移不自动替代利落近身挥手。 |
| shy-standing、embarrassed-body、tsundere-body、crossed-arms-laugh | shy、embarrassed、laugh、amused、skeptical | 相同情绪标题不是新增用途；先看姿态与交流作用。长期情绪仍读数学状态，不在两库间各自决定。 |
| turn-90、walk-common、seated-basic | turn_left、turn_right、walk_forward、walk_backward、sit_down、stand_up、stand_up_from_desk | 优先原生已验轨迹；程序版可能补可控落脚、当前场景椅高和中断能力，二者需记录范围，不互相冒充。 |
| hair-self-groom、cheek-hand、finger-snap | 需进一步按实际轨迹检索 | 当前原创目录近似候选必须实际检索后再决定新增，改名/镜像/变速不算新增动作。 |
| touch-or-pat、hug-partner、handshake-partner | comfort、reassure | 不接触他人的安慰掌势与需要另一人物的拍抚/拥抱不同，不能用空气互动冒充完整多人动作。 |

这张对照先指向可能重合，不能单凭用途名宣称重复或不重复。程序制作的“能在改口时接续”和原生素材“完整漂亮的一段”，可能提供不同控制能力；必须把差异写成具体行为并验过。

## 还没有匹配到规则的家族

当前未匹配清单为空，319段都恰好有一条前期说明；没有用“其它通用动作”兜底。Bi、Mofang、Fu、Qujing、SitUP等含义不清的资源已经分别登记为待确认，**有分组不等于含义已经确认。**同名不同目录的文件继续分别保留，不按名字丢掉。

## 下一步怎样把说明变成可用动作

1. 从用途明确、日常频繁的站姿交流、思考、转身与坐姿交流先看，但其余家族的缺口清单保持可见。
2. 用本轮全轨测量补各片段的实际参与部位、起止姿态、速度、位移和配套衣发，测量与用途推断分别记录。
3. 选定真实模型、起始姿态和现场，连续检查进入、主体、退出；准备/主动作/收回阶段分别打断。
4. 对缺出口、依赖道具或另一人物的动作，补实际过程后再验证。只有当前版本通过，才考虑未来开放给调度器。
5. 保留当前身体幅度、近身肘部和利落挥手；不能全局降幅、慢放或撑肘掩盖问题。

本文件的覆盖检查只证明前期资料没有漏分，不是自然度验收、碰撞保证或完整人物接入。

## 供逐组查阅的规则索引

表中“片段”包含起势、循环、收势；“用途”里的候选和待确认字样保留其证据边界。详细触发、进入、退出、取消、禁用与未知处理在机器可读规则里。

| 规则 | 片段数 | 用途 |
| --- | ---: | --- |
| standing-baseline | 2 | 站立保持的优先核对候选，不等于倾听或赞同。 |
| standing-alternate | 1 | 特殊站立保持候选，不能替代默认基准。 |
| breathing-full-pose | 1 | 完整呼吸姿态候选，不是可叠到任何动作上的通用呼吸增量。 |
| relax-release | 1 | 放松全身动作候选，需要确认是否舒展及脚部/位移要求。 |
| standing-change | 1 | 站姿转换候选，需要确认转换前后究竟是哪两种姿势。 |
| long-character-idles | 3 | 角色长待机/演出候选；含义、物体和出口需逐段审阅。 |
| ui-team-poses | 3 | 组队界面展示姿态候选，优先作为姿态审阅参考。 |
| ui-chip | 3 | 芯片界面演出候选，标题仅表明UI用途，不能推定实际物体。 |
| ui-nature | 3 | 属性界面演出候选，标题仅表明UI用途，不能推定实际物体。 |
| ui-resonant | 3 | 共鸣界面演出候选，标题仅表明UI用途，不能推定实际物体。 |
| standing-talk | 6 | 站姿交流身体候选，优先与已有原创解释类比较复用。 |
| calm-dialogue | 9 | 平静交流姿态候选，不自行改变长期情绪。 |
| turn-in-explanation | 3 | 转折或保留意见的交流手势候选，具体语义待看。 |
| show-hand | 3 | 展手说明候选；已知会带脚部变化。 |
| point-to-real-target | 3 | 指向真实目标的手势候选，不把动画原方向当目标位置。 |
| whisper-style | 3 | 低声交流身体表现候选，声音音量仍由语音链决定。 |
| ready-to-act | 8 | 准备姿态候选；动作意图尚不明确，需要逐版本审阅。 |
| thinking-standing-one | 3 | 站姿思考表达候选，不是微小动作。 |
| thinking-standing-two | 4 | 另一套思考姿态及两个循环候选，需确认两个Loop分别适合何种持续状态。 |
| anger-body | 3 | 生气身体姿态候选；最终情绪由现有数学系统提供。 |
| complaint-body | 6 | 抱怨身体候选，需要确认两版本是否带不同力度或对象关系。 |
| embarrassed-body | 3 | 尴尬身体反应候选。 |
| shy-standing | 12 | 害羞姿态候选，四版本需分别确认力度、朝向和参与身体。 |
| tsundere-body | 6 | 别扭身体反应候选，仅在有对应交流目的时用。 |
| pleading | 3 | 请求或恳求姿态候选，需要确认强度。 |
| promise-standing | 3 | 承诺/确认姿态候选，动作不替代业务承诺与执行。 |
| fool-expression-body | 6 | 原名Fool的身体表达候选，含义可能是愣住等，当前不确定。 |
| cheek-hand | 1 | 脸颊附近手势候选，手、袖和脸边长发需要完整回收路线。 |
| hair-self-groom | 4 | 自我整理头发候选，应先比较现有原创拨发，确认真实用途缺口。 |
| finger-snap | 3 | 响指手势候选；声音效果是独立能力。 |
| greeting-hand | 6 | 打招呼身体候选；坐姿版本必须配对应坐姿，不与站姿互换。 |
| salute-movement | 1 | 致意身体候选，已知有明显位置变化，不能当原地小挥手。 |
| crossed-arms-laugh | 1 | 抱臂笑长反应候选。 |
| seated-talk | 6 | 坐着交流候选，各自依赖相应基础坐姿。 |
| seated-thinking | 9 | 坐姿思考或托腮候选；RestChin是否依桌支撑需实看。 |
| seated-calm | 3 | 平静坐姿交流候选。 |
| seated-promise | 3 | 坐姿承诺表达候选。 |
| seated-fool | 3 | 原名SitFool的坐姿表达，实际含义待确认。 |
| seated-basic | 12 | 基础坐姿家族候选；不同版本椅高和起始状态不可假定相同。 |
| seated-two-no-start | 2 | 只有Loop/End的坐姿候选，缺进入来源。 |
| seated-leanback | 3 | 坐姿后靠候选，椅背是否承重需检查。 |
| seated-headmove | 5 | 坐姿头部变化候选，仍需核对是否也动身体和手。 |
| seated-expectation | 3 | 坐姿期待表现候选，需确认原生含义。 |
| seated-legshake | 3 | 坐姿晃腿候选，需核对座高、脚是否悬空和裙摆。 |
| seated-land | 1 | 原名Land的坐姿相关片段，是否落地/落座须实看。 |
| seated-emotional-story | 6 | 坐姿抱怨/笑演出候选，原名所示力度需确认。 |
| seated-partner-arm | 3 | 疑似坐姿挂臂互动候选，不能确认对方对象和接触前不开放。 |
| sit-up-unknown | 2 | 原名SitUP片段，不能确认是起身、坐起还是其它演出。 |
| collapse-seat | 7 | 疑似瘫坐/虚弱坐姿演出，涉及失力和承接，非普通疲倦表现。 |
| squat-support | 6 | 蹲姿家族候选，不把蹲下等同坐下。 |
| turn-90 | 2 | 约90度踏步转身，优先保留原生脚步与根部轨迹。 |
| turn-backhand-story | 2 | 背手转身候选，只有Start/Loop且用途待看。 |
| walk-common | 3 | 前进/后退步态候选；共用骨架与剧情复用版分开适配。 |
| walk-talk | 4 | 行走交流/思考候选，需要真实路线而非站姿手势。 |
| walk-greet | 1 | 边走边招呼候选，不当原地挥手。 |
| walk-shy | 3 | 带害羞表达的步行候选，情绪不能凭空批准走路。 |
| walk-weak | 1 | 虚弱步行候选，需明确剧情/身体状态，不用于一般低精力。 |
| running-general | 2 | 跑步片段候选，需要完整起跑、运动路线和停步。 |
| cassette-context | 3 | 磁带相关站立/跑动候选，持物与路线必须具体核对。 |
| handshake-partner | 4 | 疑似握手互动，两种命名版本分别核对。 |
| holding-hands-partner | 3 | 疑似牵手/握持他人手的候选，Stand_Qianshou具体含义待看。 |
| hug-partner | 5 | 疑似拥抱/抱哭互动，需确认是自我抱臂还是另一人接触。 |
| pulled-or-grabbed | 5 | 疑似被抓手/被拉动互动候选，不能作为自主普通手势。 |
| nose-contact | 5 | 疑似鼻部接触互动，可能涉及他人；仅标题不能确定。 |
| touch-or-pat | 7 | 触摸/拍抚/扶持等可能接触候选，Fu01语义尤其不明。 |
| leaning-stand | 3 | 倚靠站立候选，需要真实可承接表面。 |
| self-look | 3 | 原名看自己相关候选，实际注意目标与手动作待看。 |
| mouth-cover | 7 | 疑似捂嘴/擦嘴候选，近脸碰撞和说话可见性需检查。 |
| lower-head-standing | 3 | 低头站姿候选，可用于明确内省等语义，不能直接当悲伤。 |
| raised-hand-unknown | 9 | 抬手/伸手名称候选，需确认是表达、取物还是对人接触。 |
| uncertain-bi | 3 | Bi01缩写无法确定用途，保持未解释预览候选。 |
| uncertain-awareness | 3 | 觉察名称候选，是否惊觉或一般注意需实看。 |
| uncertain-dramatic | 7 | 特定剧情语义候选，名称不足以说明情境与对象。 |
| uncertain-mofang | 4 | Mofang可能对应不同中文，不能确认是模仿、道具或其它含义。 |
| uncertain-viewfinder | 3 | Qujing原名候选，不能确认是取景、窥视或其它用途。 |
| vehicle-context | 5 | 车辆相关互动候选，可能涉及手机、搭肩和乘客，必须恢复实际现场。 |
| lying-crawling-uncertain | 4 | Pa名称可能卧趴/爬行，当前两目录均只有Loop/End。 |
| water-context | 4 | 入水名称相关演出，需水体/地形和完整承接。 |
| aerial-or-unconscious | 2 | 飞行/昏迷名称候选，依赖特殊支撑或剧情，不属于日常交流开放范围。 |
| microphone-taking | 1 | 疑似取麦克风片段，只有Start，缺持稳和放回。 |
| keyboard-entry | 1 | 疑似键盘操作起势，原名拼写如此，只有Start。 |
| dorm-farewell | 1 | 宿舍告别长演出候选，不直接替代简短告别。 |
| dorm-guitar | 1 | 宿舍吉他演出候选，需真实乐器及握持。 |
| dorm-paperplane | 1 | 宿舍纸飞机演出候选，需核对物体拿取、飞行、交接。 |
| dorm-writing | 1 | 宿舍书写/创作名称演出候选，需确认真实道具。 |
| dorm-texting | 1 | 宿舍手机操作名称演出候选，需确认手机和握点。 |
| fanclub-performance | 1 | 粉丝互动名称长演出候选，观众/道具/音乐依赖待确认。 |
| sigh-story | 3 | 叹气名称长演出候选，不能以精力降低或回复等待直接触发。 |

参考：[完整接入准备](character-director-integration-readiness-2026-10-23.md)、[人物行为方案](unified-character-director-engineering-2026-10-23.md)、[已有73段适配证据](native-common-motions-2026-10-22.md)、[已取得原生轨迹能确认什么](../skills/native-performance-authoring/references/native-evidence.md)。
