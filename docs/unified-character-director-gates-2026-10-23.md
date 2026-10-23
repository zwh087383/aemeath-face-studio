# 统一角色导演：门控、调度与交付细则 v0

日期：2026-10-23。配套总设计：[统一角色调度中心](unified-character-director-design-2026-10-23.md)。

**状态：设计规格，尚未实现或进行运行验收。** 本文通过主代理和三名子代理核对源码、讨论反例形成。所有“拟新增”字段、规则和数值是实施要求；数值初值须实模调参，不能当成测量结果。此次不改语音、模型、记忆、动作执行器，不调用云端。保留现有身体幅度、近身肘部及利落挥手；优先使用已验证原生资源。

便于直接讨论角色行为的完整说明见[人物为什么这样动，以及动作怎样自然地接起来](unified-character-director-engineering-2026-10-23.md)。该说明将候选来源、逐项淘汰、真实姿态/速度过渡、持物、衣发、表情、媒体及异常处理逐项展开。

本次白话方案已为所有环节补充“谁判断、依据是什么、判断不出来怎么办”，并逐项区分当前Qwen语义建议、已有后台分析、程序事实与数学结果。它也补了有限恢复、分阶段放松和未完成动作的反馈要求；相关判断来源与未知处理以该说明为准。新增时间只作待测试调起点，不代表本文规则已实现，也不取消原有记忆纠正、打断和交付保护。

后续源码核对勘误：当前 transport 的内容进度是 AudioContext 排程估计，未实现硬件消费测量；本文的消费/排空条件须带证据级别，不能称当前已实测扬声器。有效精力也应分闲时生活状态和直达回复策略，后者的允许回答/醒睡修正不能覆盖前者。当前手部已有可复用的保留速度衔接，原生全身统一接续仍待接入。

源码检查基线：WAI `8a715a00d5a8bf8b161b86e55e16fe2da349c99e`，face `70709916ae93dbf5e9e2b6590f5efe1d7f47a1cb`。工作区有其他未提交工作，本文不认领、不修改；源码默认值不代表机器私有配置。

## 1. 必须拆开的七个判断

| 判断 | 谁决定 | 成立说明什么 | 不说明什么 |
| --- | --- | --- | --- |
| 产生候选 | WAI 有效状态/事件与本地白名单映射 | 有值得表达的理由 | 可以占身体或发声 |
| 允许开始表现 | 本地导演 | 当前语义、身体、通道、预算均允许 | 声音必须等动作 |
| 允许主动开播 | WAI 交付策略＋媒体宿主 | 当前接收者拥有有效音频交付许可 | 后续永久不会撤销 |
| 允许继续 | 各自 owner 的续行检查 | 本轮仍有效，未被其他 owner 抢占 | 再收一次候选预算 |
| 实际交付结算 | WAI＋媒体消费回执 | 已合法发生的内容可以结算 | partial 可冒充全部说完 |
| 允许放松 | 本地导演＋真实输出状态 | 可以收势、降低注视强度 | 对话结束、任务恢复 |
| 允许恢复业务 | WAI ActivityPlanner/Life Runtime | 后端任务可以继续 | 必须重新拿书或站起来 |

没有一个全局 `can_speak`、`is_idle` 能同时替代它们。身体、注意、用户输入、自身输出仍是四条正交状态轴。

## 2. 事实、版本与时钟契约

### 2.1 事实所有者

| 事实 | 唯一权威 | 人物端用途 |
| --- | --- | --- |
| 数学情绪 E4、关系 R2、有效精力 | WAI identity / 有效运行状态投影 | 选择偏好和表情基底，禁止反向积分或写回 |
| 内心提示 InnerFrame | WAI 短期、非权威提示 | 低权重偏好，不授权发声、任务、持物 |
| 话轮接纳/合法打断/inputGeneration | 当前 voice host/runtime | 撤销旧语义、正式倾听，保留已接纳输入 |
| 实际播放、暂停、消费帧、清空确认 | 当前媒体 owner | 口型、语音 cue、结束判定 |
| 任务开始/暂停/恢复/撤销 | WAI activity/life runtime | 视觉映射和书签有效性 |
| 当前姿态、支撑、手持物、接触 | 身体执行器＋场景对象管理 | 转场与占用，不能由 LLM 文本改写 |
| 发言预约、来源版本、边界与静音策略 | WAI 交付系统 | 主动媒体许可，人物端只可拒绝，不能自行批准 |
| 语义动作建议 | 已接纳的工具调用/字幕旁路 | 有上下文和期限的候选，不能直接写骨骼 |

拟新增统一投影 `InteractionPolicy`：`conversationCommitment`、`allowsDisengage`、`allowsAmbientStart`、`allowsAmbientResume`、`businessResumeAllowed`、`reason`、`revision`、`validUntil`，并绑定计算依据的 `inputGeneration / mediaGroupRevision / activityGeneration`。由 WAI 结合当前话轮、待回答问题、接话计划、输入活动和任务权限计算；不存在接话计划不等于已经结束对话。允许不再持续注视，不等于允许新开休闲。人物计时器不自行把许可置 true；依据改变后旧投影立即失效为 UNKNOWN，不因 TTL 尚未过期沿用旧话轮许可。

### 2.2 依赖向量

```text
DependencyVersion {
  trustedStreamId, semanticStateRevision, interactionPolicyRevision,
  inputGeneration,
  mediaGroupId, mediaGroupRevision, mediaOwnerGeneration,
  activityId, activityGeneration,
  sceneRevision, contactRevision,
  planId, planRevision,
  permitId, claimOwnerGeneration
}
```

只绑定该计划真正依赖的字段。持杯动作依赖接触版本，不能因一条新情绪数值而全部失效；旧话轮的解释手势必须因 `inputGeneration` 改变而失效。新流 ID 只能来自可信连接握手；旧流的更大 seq 不能压过新流。

状态采用 `TRUE / FALSE / UNKNOWN`，未知不等于没有占用：

- 身份、许可、支撑或物体归属未知：禁止依赖它的新发声/新运动，维持最后可信接触或已验证最小稳定过程。
- 媒体状态未知：不宣告播放完成；不因此停止已由宿主管理的语音。
- 情绪过期：停止情绪依赖选择，表情缓慢回保守基底，明确动作请求与倾听仍可执行。
- WAI 已有的 engagement/task_state unknown 规则保持原样；人物端不能把它升级为一律禁止主动候选。
- 可信撤销立即生效，不能等下次全量快照。事件链断档后须补可信快照，不能靠“最近收到过消息”续期。

每个许可/状态域由生产者提供 revision、有效期和撤销语义，不用一个统一的“6 秒新鲜度”套全部状态。宿主将许可有效期保守换算为本地单调截止时间；不能直接比较远端 monotonic 与浏览器 `performance.now()`。

本文伪码 `!pendingReply` 等否定条件指该事实严格等于 FALSE，许可条件指严格等于 TRUE；缺字段/超时为 UNKNOWN，禁止用 JavaScript `!undefined` 放行。每个候选只查自己声明依赖的事实，未知情绪不能阻止不依赖情绪的明确动作。

### 2.3 三种进度

1. **媒体进度**：当前 owner 实际消费帧及 segment 映射，控制口型和与语音绑定的表现；不是收到音频的时间。
2. **本地单调时间**：注意转移、收势、候选期限、抗抖和部分预算；不受系统时间修改影响。
3. **实际动作阶段进度**：执行器真正推进的阶段与接触检查点。网页隐藏 40 秒不能据墙钟假报拿杯/放杯已完成。

恢复可见或重连时先取最新快照，清过期 cue；口型采样当前媒体位置，实体动作从可信当前状态重规划。不得高速补演积压动作。

## 3. 候选生成：有理由才动，保持也是结果

WAI 负责内心、情绪和任务；本地只把已授权事实映射成有限候选。心情变化不是动作命令，字幕 delta 不是新动作次数。

输入必须分三类：**持续状态 level** 更新表现目标，不重复派发；**真实边沿 edge** 最多产生一次短反应；**当前活动 phase** 延续已选轨迹，不重新决定“想干什么”。例如任务 running 刷新 20 次仍是同一个专注目标；planned→running 才是开始边沿。来源撤销先删除目标和未开始机会，再让已经开始的表现收势。

| 输入 | 可产生的候选 | 不能据此产生 |
| --- | --- | --- |
| 有效业务任务进入 running，表现标签 quiet_focus | 安静专注、姿态/视线适度收拢 | 凭 reading 字段生成实体书、虚构已读内容 |
| 有效业务任务 paused / 用户到场 | 保存活动上下文、让出冲突通道、注意用户 | 删除椅子和物体、恢复标准站姿 |
| 有效舞台休闲许可＋场景满足 | 一项已验证 ambient 活动的 entry/loop/exit | 写业务进度、消耗第二套真实精力 |
| 情绪跨越已审核表现区间且稳定 | 更新表情基底、重评活动偏好，必要时一次微反应 | 每次数值更新都演一次、由高兴自动授权搭话 |
| 短期 InnerFrame 倾向 | 已存在合格候选之间的小幅偏好 | 新造业务任务或提高发声权限 |
| 场景中可信对象/目标发生变化 | 合法的视线定向或当前活动重规划 | 从用户未授权的摄像头/传感器补造事件 |
| 有效工具/字幕语义机会 | 与该机会对应的身体＋表情候选 | 无机会 ID 的无限队列或重复确认性点头 |

持续目标使用 `sourceKind/sourceId/sourceGeneration/function` 作 key；边沿使用 `sourceKind/sourceId/transitionType/semanticOccurrenceId` 作 key，不能把每次快照 seq 当动作 ID。重连快照只重建 level，不补演历史开始/完成；同一原因导致的任务暂停和用户到场合并为一次注意反应。

表现侧可保存区间 latch 防抖，不积分心理状态。v0 示例：有效 energy ≤0.35 进入低能量 episode，≥0.45 退出；S ≥0.65 进入高压力 episode，≤0.50 退出。进入条件连续稳定 2 秒才提出最多一次非紧急姿态候选；可信新输入不等这个计时。持续期间只保留偏好，不反复叹气/坐下。数值是待校准的表现分区，既有 V2 默认清醒日节律 energy 约 0.6–0.9，不应为了触发休息而伪造低值。睡眠权限另查 WAI。

InnerFrame 只在后端白名单投影少量标签：stay_quiet→克制，keep_digesting→专注，wait_for_user→可接话；未知字符串忽略，私有全文不下发。它只影响已有合格候选偏好，不能创建任务、物体或主动许可。

**现有情绪事件缺口：** `emotion_system.py:148–170` 一次更新可能分别发 V/A/D/S 四条 EMOTION_SPIKE，目前没有共同 updateId。桥需按同一次已提交状态版本合并一次机会；无法可靠合并时 v0 只读完整快照更新基底，关闭独立 spike 动作，不能四个维度各演一次惊讶。

连续行为由现有活动内部的阶段和循环维持。循环边界只是“可重评”的时刻，不强迫切动作。没有新理由时继续有效活动，或保持安静陪伴。

```text
onTrustedEvent(event):
  updateFactsAndRevokeFirst(event)
  upsertPersistentGoalsFromCurrentFacts()
  edges = [] if event.isSnapshot else coalesceActualSemanticEdges(event)
  for mappedIntent in approvedMappings(edges):
    upsertBy(sourceId, semanticOccurrenceId, opportunityId)
    // 同一事实快照或字幕增量只更新原候选，不续 TTL、不加预算
  evaluateAffectedCandidatesAndHold()
```

内心生成、解析、情绪求解不会被挪进渲染循环；事件到来只读最新有效投影。后台解析尚未完成时，语音沿当前快速通道继续，人物使用现有事实或安静保持。

## 4. 门的顺序和返回值

每个行为声明其所需门。生理眨眼、姿态保持不需要“理解了台词”门；确认性点头需要。一次语义动作执行顺序如下。

| 顺序 | 门 | 检查什么 | 失败处理 |
| --- | --- | --- | --- |
| G0 | 身份与来源 | 当前流、owner、话轮、来源版本、未撤销、未重复 | DROP；旧任务不能复活 |
| G1 | 有效时间与语义 | 来源期限、本地 TTL、媒体窗口、机会未消费、没有换话题 | DROP；不延到下一句 |
| G2 | 行为权限 | 当前互动策略允许；主动语音另查 WAI 许可 | 可恢复条件 DEFER，否则 DROP |
| G3 | 身体与场景 | 姿态族、支撑、持物、进入/让出路径及衣发配套 | 已登记替代版本，否则保持/DEFER |
| G4 | 通道冲突 | 完整依赖闭包与占用者、优先级、让出承诺 | 让出请求/兼容替代，不抢写骨骼 |
| G5 | 表现预算 | 密度、重复族、活动最低保持；明确请求可越过部分软门 | DEFER 到真实机会或 DROP |
| G6 | 选择与抗抖 | 优于保持、连续性、同级稳定时间、原生优先 | 保持；不把保持当失败 |
| G7 | 提交复核 | 相关版本、期限和所有必需通道仍匹配 | 原子提交；失配重报一次或等待事件 |

```text
GateDecision {
  candidateId, eventId, phase: admit | continue | settle,
  verdict: ACCEPT | DEFER | SUBSTITUTE | DROP,
  reasonCode, checkedAtMono, dependencyVersion,
  blockedResources[], retryOn[], latestStart?, substitutePlanId?,
  bypassedSoftRules[]
}
```

`DEFER` 必须同时有唤醒事件和截止条件；例如等待 `right_hand_released` 且未过本句窗口。默认只保留同语义键的一个候选，不轮询所有失败项。无唤醒条件或没有剩余窗口直接 DROP。

候选 TTL 从第一次收到有效机会起算，重复更新不能延长；`latestStart` 同时受来源、语义窗口和本地期限约束，不把不同钟直接取数值最小。v0 无更短期限的自发语义 cue 最多保留 2 秒；明确请求由请求 owner 指定有效期，缺失时只在当前请求上下文有效，不跨新话轮偷偷补做。

“换版本”必须说明结果：空闲手挥手是已审核等价版本；点头不等于挥手，不能报原请求完成。表现执行失败仅影响表现，不能据此停止语音。

## 5. 事件优先级、资源占用与抢占

### 5.1 处理顺序不等于强制截断身体

同批事件：验证身份去重 → 可信撤销/owner 替换/话轮失效 → 媒体与场景事实 → 阶段反馈 → 新候选与提交。

同一资源竞争按以下顺序：

1. 已发生的支撑/接触约束和最小稳定收势必须完成。
2. 可信停止、合法打断、来源撤销立即禁止旧语义后续。
3. 已接纳用户带来的注意与明确动作请求。
4. 当前有效语音的口型和有窗口的交流表达。
5. 已许可主动搭话的准备。
6. 当前活动连续性、弱事件和自发微反应。
7. 新开舞台休闲。

这是按资源的优先级，不是七条互斥全局状态。用户请求可以让出原活动，不能抢走承重脚；口型始终属于实际音频，挥手请求不能覆盖嘴的音素通道。用户要求与当前语音同组时，身体/表情构成一个计划，不重复抢占自身。

### 5.2 占用模型

至少分 `root/support`、`torso`、左右臂/手、`head_neck/gaze`、`brows_eyes`、`mouth_corners`、`visemes`、`prop:objectId`。兼容性按 exclusive/additive/target-constraint、父子骨/IK/grant 依赖闭包判断，不能把“左手空着”当成整条肩链自由。

每个候选提交一个完整 plan：身体、必要表情、配套衣发和允许降级版本。常驻情绪基底可作为输入合成，不意味着短表情无条件抢占眉眼。嘴角资源与口型实际共享的 morph 必须列出互斥/混合规则；不能只按名称认为已经隔离。

```text
quote = quoteTransition(plan, currentBodyFacts) // 不占锁、不抢通道
commit(quote):
  reject if tombstoned or expired
  compare relevant dependency revisions
  check every required resource and current contact owner
  atomically reserve all resources + budget + plan revision
onFirstVisibleSample:
  recheck active, latestStart, relevant revisions, resource/budget reservations
  // 失效释放预约；尚未消费机会，但已过期机会仍 DROP，不能续命
  convert budget reservation to spent
```

同一语义组合不能先笑了才发现手势不允许；按登记变体整组接纳。注意到用户是独立低承诺计划，可以先于整组挥手。已开始后的视觉故障不能回滚过去的画面，应停止后续错误表现、合法收势并记 degraded。

旧语义 plan 被 tombstone 时，必要承重/持物收势由新的本地 stabilization owner 原子接管既有占用，并记录原 plan 与撤销原因。不能先清空旧资源再等待新收势取得它们；新 owner 只准执行登记的最小恢复，不能继续原语义或恢复旧音频。

完成、释放、退款回执都带 `reservationToken + ownerGeneration`，按 compare-and-release 处理；旧异步 completed 不能释放已经交给稳定计划或新动作的通道。稳定计划授权来自当前可信身体现场和撤销处理器，不再依赖已撤销的旧语义来源通过 G0。

取消发生在实际可见前，释放预算 reservation；可见后不退回消耗。语义机会去重和来源撤销仍保留，不能退款后重复播放。报价过期同一事件周期最多重算一次，之后等待真实状态变化，避免忙循环。

## 6. 五条完整路径

### 6.1 闲时启动或继续活动

```text
mayStartIdle = validActivitySourceOrAuthorizedAmbient
  && interactionPolicyCurrent && interactionPolicy.allowsDisengage
  && interactionPolicy.allowsAmbientStart
  && !acceptedUserTurnActive
  && mediaQuietConfirmed && !pendingReply && !pendingHandoff
  && !activeProactiveClaim
  && compatibleBodyScene && verifiedEntryExitYield
```

`mediaQuietConfirmed` 可以来自“从未开始输出且当前宿主明确空闲”的初始化快照，也可以来自正常完成；不能要求首次进入闲时必须先说过一句话。取消后的安静只满足媒体这一项，新的用户话轮或互动承诺仍阻止退闲时。

新活动还须超过保持得分，并通过 20 秒新开间隔和 loop 最少保持 8 秒；这些仅针对同级自发切换。用户到场、来源撤销与明确请求可越过。活动继续只检查来源、上下文、支撑及被撤销情况，不每帧重新收费，不循环重演 entry。

首次启动没有 `lastAmbientStartedAt` 时不应用 20 秒间隔；8 秒从实际 loop_started 算，不能拿进程起点假设已有活动。稳定 0.6 秒的软门允许设置一次可撤销到期事件，届时重过相关门；否则完全事件驱动下可能永远等不到下一事件。到期只触发重评，不直接启动动作。

### 6.2 闲时转交谈

| 阶段 | 门与表现 | 音频规则 |
| --- | --- | --- |
| 疑似发声/本地音量/speech_started | 低承诺视线和头部注意，暂缓新开分心活动；不声称已理解 | 服从宿主 provisionalPause，不另加 cancel，也不强行 resume |
| 宿主认定合法打断 | 撤销旧话语候选，向当前活动发 yield；支撑/物体保留 | 宿主取消对应旧输出 |
| accepted_input | 新代次正式倾听；可独立开始头脸注意 | 沿现有快速语音链，不等身体让出 |
| 已完成且理解确认 | 可以候选确认性点头 | 静音本身不等于同意 |

当前宿主真实实现见 `tools/voice_avatar/duplex_runtime.py:199,281` 与 face `realtime/duplex/client.mjs:78`：有效 speech_stopped 先撤销旧答；接纳调度还需监听 response.done、非空最终转写、latest_valid、预算和停止状态。孤立尾词最多聚合 1200 ms 是既有输入规则，不是导演新加的等待。

**现有缺口：** valid 目前用 `reason != "turn_invalid"` 判断。实施规范化层时应列可信 provider reason 白名单。未知 stop 原因既不能当作有效话轮，也不能当成 turn_invalid 自动恢复旧声音或认定用户已说完；宿主保持待判并按其有界超时/失败策略收束，导演只保留可撤回注意。不能声称现状已严格实现这一点。

### 6.3 交谈中的自然表达

必要条件：有效逻辑回复组、有效机会 ID、未撤销/未消费、当前上下文一致、在语义窗口内、身体有兼容版本。

- 实际消费音频决定口型；音频可播放时立即走既有链路。表现没有加载、未让出、未到准备姿势都不构成语音等待条件。
- 有可信音频锚点时：`latestPrepareStart = targetApex - measuredPrepareDuration`。来不及只选已验证短准备版本或略过，不能加速全段或拖住声音。
- 没有精确词级对齐时，可做窗口内不声称精确重音同步的表达；不能伪造毫秒级对应。连所属段也未知则不发语义动作。
- Qwen1→Qwen2 仍是一个逻辑回复组，机会、预算、取消关系不重置。
- 等待模型每组最多一次准备变化；等待变长不是新动作理由。
- 倾听用可撤回注意和小幅接收姿态；“我理解/我同意”的点头额外要求 `understandingConfirmed && speakerCompleted && !partnerVoicing`。不要把所有生理头动都标成确认。
- 语音暂停时不能冻结持物中途：撤回该语义计划的后续，身体按本地时间收势；若宿主恢复，按剩余窗口重新决定，不机械续演已错过的重音动作。嘴形随暂停的实际播放处理，不补积压口型。

### 6.4 交谈回到闲时

用两个不同终态：

```text
normalFinal = groupSucceeded && hasDeliveredContent
  && handoffClosed && segmentsFinalized
  && currentOwnerDrainConfirmed && finalConsumedFrameMatches
  && noPendingSchedule && !paused && !underrun && !reconnecting

cancelQuiet = cancellationAccepted
  && currentOwnerStopAndClearConfirmed
  && acknowledgedClearGenerationMatches

failureQuiet = hostFailureTerminal && handoffClosed
  && matchingOwnerDrainedOrCleared && noPendingSchedule
```

第一段排空、字幕结束、provider done、暂时欠载都不足以证明 `normalFinal`。失败、转交失败、纯工具空回复的 terminal 不能冒充正常完整交付；失败安静只允许相应收势，不做“已说明完毕”的确认。首次启动宿主明确空闲则记 initialQuiet。以上各类 quiet 都不自行授权休闲。取消不用把未播放音频播完，但必须收到匹配清空确认；没有确认时可先收势，不能谎报已经安静。

正常结束可以立即开始合法收势，短表达回到当前情绪基底；收势完成后 v0 约 2.5 秒逐渐降低持续注视。**这个计时只改变注视/准备强度，不结束对话、不批准休闲。** 等用户回答问题也可以放松身体，不必一直紧盯。

`cancelQuiet` 不触发正常句尾点头或完整交付确认。无论正常还是取消，舞台活动恢复仍检查 WAI 互动策略、无新输入/待回复/转交和身体兼容；业务任务恢复另查业务许可。历史 ACK 和后台维护不阻塞放松。

### 6.5 活动恢复

```text
mayResumeActivity = interactionPolicyCurrent
  && allowsAmbientResume && noConversationCommitment
  && mediaQuietConfirmed && !acceptedUserTurnActive && !pendingReplyOrHandoff
  && bookmarkActivityGenerationMatches && sourceCurrent
  && !userRevoked && supportPropsMatch && verifiedReentryCheckpoint
```

书签保存活动身份、已执行阶段、当前物体/支撑和合法重新进入点，不是一个未来强制执行命令。恢复同活动不扣新活动额度，不强制重演拿书 entry。书不存在、任务撤销、椅子移动到不兼容位置时标记 `replan_required`，保留还合法的坐姿，不复活物体。

**当前业务规则保留：** `activity_planner.py:158–201` 暂停业务的恢复还需 `allow_start`、距最近用户到场至少 600 秒（或未记录）、未到睡眠；新任务还有计划时间、剩余时间和任务间隔等约束。人物无须因此保持 600 秒强倾听。不能通过视觉恢复绕过真实任务暂停。

## 7. 休闲转主动搭话：四次不同的门

### 7.1 候选准入：复用 WAI，不能人物端重写

当前 `UrgeEngine.evaluate` / `V2Outlet.hard_hold` 核对来源、取消、边界、主题、隐私、危机、睡眠、专注、未回应、业务渠道、时机与预算等。普通 engagement/task_state unknown 提高阈值而非一律禁止。

部分现有评分为：

```text
score = pressure * fit * gain
refractory = 0.2 * exp(-secondsSinceLastSent / 1800)
threshold = max(0.25,
  (0.5 * coefficient * (1.35 if unanswered == 1 else 1)
   + refractory) * paceFactor) + learnedThresholdDelta
```

留言/返回/A 类到时有专门分支，详见 `wai/proactive/urge.py:147–182`。这些是现有 WAI 发言策略，不是人物“心情好就讲话”公式。

预约需生成前后代次与来源一致、FinalGuard 通过、主话题覆盖、版本 reserve 成功，持久化 outbox 后才发送交付事件。当前 reservation 尚无设备/媒体 owner/音频授权字段；`live / leave / return` 是业务渠道，不能直接映射为扬声器权限。

### 7.2 开始主动音频：拟新增媒体许可

```text
mayStartProactiveAudio = reservationCurrentForStart
  && deliveryModeAllowsAudio && businessChannelAllowsAudio
  && sessionAndRecipientAndDeviceMatch
  && uniqueClaimCurrent && claimLeaseValid
  && inputGenerationMatches && !confirmedNewUserInput
  && !foreignOutputOwner && !quietOrPaused
  && audioCapabilityReady
```

拟新增字段：`reservationId / deliveryGroupId / businessChannel / deliveryMode / sessionId / recipientId / deviceId / claimToken / ownerGeneration / leaseUntil / inputGeneration / expiresAt / approvedContentRevision / outputOwner / capabilityRevision / quietPolicyRevision`。

检查时机为领取 claim、发模型请求前、第一帧可播放提交前、每逻辑段开始前；输入/许可/来源/owner 撤销事件立即废止本地续流状态。逐块使用有版本的本地检查，不逐渲染帧读账本、取文件锁或网络锁。

主动视觉准备只在有效 claim 和许可下开始，允许先转移注意；有疑似用户输入时暂缓新首包。姿态未准备完不拖首包；若用户先取得话轮，撤回准备并失效旧 claim，不等模型返回才停止。

### 7.3 继续：避免“自己正在生成，所以把自己取消”

当前 `v2_outlet.py:115,162,180` 将 assistant_is_generating 当作拒绝条件且 current 会重跑 hard_hold。主动语音若直接复用此路径，可能自锁；当前文本路径没设置这段生成状态，不代表新语音路径安全。

```text
busyConflict = busy && (busyOwnerUnknown || busyOwner != thisClaimOwner)
sameOwner = exactMatch(groupId, claimToken, ownerGeneration, inputGeneration)
```

只有可证明的本组 generating/foreground_busy/awaiting_delivery/lane 占用才能在续流时不算冲突；来源、隐私、用户边界、新输入、取消、到期、设备策略仍能撤销。同 owner 不重复收候选预算。当前 lane 只有 bool，需要补 owner 才能这样区分；未知 owner 不能当成自己。

sameOwner 由可信宿主按已登记身份比较，不接受候选自报 bypass 标志。已有预算 reservation 必须仍有效；避免重复收费不等于豁免额度撤销或预算失效。

### 7.4 结算：确认已经发生的事实

```text
DeliveryFacts {
  deliveryGroupId, claimToken, ownerGeneration, inputGeneration,
  authorizedAt, startEventSeq, lastConsumedFrame,
  terminalStatus, cancelCutoffSeq, actualDeliveredPrefix
}
```

状态区分 `OFFERED / CLAIMED / STARTED / PARTIAL / COMPLETE / UNKNOWN / CANCELLED`。同组唯一媒体 owner；镜像页不能二次结算。

- COMPLETE 要校验该交付在开始/消费期间持有的授权 claim 身份与有序事件证据、完整 segment 列表、实际消费总帧、provider/音频/转写终态及取消截点。未来发送检查当前 claim；已发生事实核对 captured claim，不能因 owner 后来正常交接误拒合法晚 ACK。
- PARTIAL 记录实际播放前缀及中断原因，不调用现有 V2 full confirm；没有来源覆盖证据时不把全部 snapshots 标为已说。
- UNKNOWN 不是零交付，不自动整段重播或转文本补发。
- 换路由仅限权威证明零交付、旧 claim 已撤销、新许可合法。
- 结算不重新做“现在可否开始主动发言”测试。后来静音/到期不抹除先前合法事实；完成在先但 ACK 晚到须显式 reconcile，不能暗中绕过现有 revoked 回执保护。

当前 `V2Outlet.confirm` 本就不调用 current，而按回执结算来源和预算；音频适配层必须先验证上述事实。现有用户双工 full ACK 的身份、帧数、段列表核对可作为参考，不能伪造用户输入来获得主动语音权限。

实际已说文本只能来自可信的音频—文本对齐跨度；没有对齐时记录已播帧范围和文本不确定，不能按“已播帧比例×全文字数”切字幕写成确定历史。此证据限制不阻止播放或收势。

## 8. 自发表现预算与选择公式

下面全部是 **新增 v0 初值**，不是测量结果。计数在实际可见开始；事前仅 reservation。全系统只留一个表现预算 owner，替换旧字幕旁路冷却，不能叠两套限流。

| 类别 | 初值 | 时钟/范围 | 明确用户请求 |
| --- | --- | --- | --- |
| 呼吸、原生待机、表情基底、生理眨眼 | 不收语义预算 | 原执行器 | 不适用 |
| 自发微反应 | 桶容量 2，每 4 秒补 1；同族至少 8 秒 | 本地单调时间，跨话轮保留 | 可越过密度/重复软门 |
| 说话主要手势 | 桶容量 2，每 6 秒实际播放补 1；每机会最多 1；同族至少 8 秒 | 连续交互期累计实际播放；跨回复/转交不重置 | 可越过密度，不能越过时效/重复请求 ID |
| 等模型准备 | 每逻辑回复组最多 1 次 | 逻辑组，非物理 response | 新明确要求另算 |
| 新开休闲 | 两次开始至少 20 秒；loop 稳定保持至少 8 秒 | 实际开始/实际进入 loop | 到场、撤销、明确要求可越过 |
| 合法收势/恢复原活动 | 不扣新动作额度 | 当前计划与现场 | 不能被预算阻止 |

桶满只说明可以做，不构成动作理由。长期闲置后的手势桶可在新的可信交互会话初始化到容量，但不能每轮、每个工具回执或第二 Qwen 初始化；暂停/欠载不累积应补演的手势。手势同族 8 秒使用本地单调时间，补币用实际播放时间，两者分别检查。

当前旧 sidecar 为动作间隔 3 秒、同动作 8 秒、同表情 6 秒、fallback 12 秒；新导演接管后旁路只产候选。执行器保留物理恢复所需限制，去掉重复的自发表现冷却。

通过硬门后，同一意图合格版本内先选已验证原生完整资源，再原生组合，最后原创缺口。不同意图按以下局部表现评分比较（所有项归一化到 0–1）：

```text
S = 4*purposeMatch + 2*continuation + 2*postureEase + styleFit
    - 3*recentRepeat - 2*switchCost - executionCost
```

v0 同级自发切换须 `Snew - Shold >= 0.8` 且持续领先 0.6 秒；失去领先清零。明确要求、可信到场、取消越过该软门。分差 ≤0.2 的合格候选可按事件固定种子抽一次，不逐帧随机。`hold` 具有连续性价值，不额外处罚不动。

情绪只调选择偏好、微反应密度和已声明可调参数。可试表现滤波 τ=2 秒、允许的微反应 gain 0.75–1.15；过滤不回写 WAI。主动作 `bodyAmplitudeGain=1`、`waveStrokeTimeScale=1`，近身肘部约束保持；低精力不全局缩幅慢放。疲倦版挥手须独立资源验收。

## 9. 让出、超时和原生资源入库

每条自动活动必须具备：语义标签、姿态族、所需物体、通道闭包、完整身体/表情/衣发版本、entry/loop/exit、每阶段合法 yield 路径、实际接触事件和重新进入点。文件名像待机、能够播放或标为 ready 都不够。

```text
yieldMode: instant_safe | stop_at_window | settle_contact
           | noninterruptible_until_checkpoint
yieldWindows[]
maxYieldLatencyByPhase
releasedResourcesAtCheckpoint
minimalRecovery
postCheckpointSupport
propTransferEvents[]
```

v0 验收目标从执行器接纳 yield 开始：空手手势 0.6 秒内让出、近身持物 1.2 秒、支撑转换 1.5 秒。不是强截时限；具体资源需测量所有可到达阶段。没有验证退出路径的长动作只做手动预览，不进入自动高打断场景。

超时报告 `yield_deadline_missed` 及仍占通道；交流使用已释放头脸/继续语音，旧执行器继续已验证最小稳定过程。不报假 suspended，不瞬移、不删除道具、不冻结半空。该资源暂时退出自动候选，重新验收后恢复。

撤销旧语义不等于抹掉物体事实：授权窗口内已经实际完成且有接触 revision 证据的 hand→table 转移仍成立；迟到的旧放杯指令不能再执行。

## 10. 四个逐步场景

**坐着持书被叫到。** 书和坐姿已经是可信现场 → 疑似输入仅转注意 → 宿主确认有效输入，旧活动 yield → 当前翻页到合法检查点，继续坐着持书 → 新回复已可播放即开始口型，解释手势只有坐姿空闲手版本才可接纳 → 播完收势，但仍等待接话 → WAI 允许脱离后校验书签，再从持书 loop 重入。书被移走则重规划，不重播拿书。

**闲时想主动分享。** 有效来源通过 WAI urge/guard/reserve → 媒体路由 claim 与音频许可有效 → 本地转向用户，不强求身体完成 → 首包前重新检查输入代次和许可 → 出声后使用同 owner 续流 → 完整消费后才结算。准备时用户先开口则旧 claim 撤销，转倾听；不因“已经准备了”坚持说完。

**第一 Qwen 转第二 Qwen。** 第一段排空而 handoffPending=true → 不 normalFinal，不退闲时，不重置手势预算 → 等待只保留一次准备动作 → 第二段沿同一逻辑组续播 → 全组关闭且排空才收尾。转交失败须宿主明确组终态，不能由人物猜测超时等于结束。

**正在挥手时被纠正。** 宿主先临时暂停/后确认取消 → 人物不新增语音裁决 → 旧语义窗口失效、口型跟实际声音 → 保留已接纳用户纠正；挥手从当前状态走已验证近身收回，不扩大肘部、不重播整段 → 新回复无需等收回完成；若手还忙先只出声和兼容眉眼。

## 11. 确定性反例验收表（尚未执行）

| 输入/竞争 | 必须得到的结果 |
| --- | --- |
| 新 inputGen=8，旧 plan/gen7 报价与撤销同批到达 | 无论事件到达排列，旧 plan 无通道、无首帧 |
| raw VAD，尚未接纳，宿主 provisional paused | 导演既不 cancel 也不 resume；本地注意可继续，新主动首包等待 |
| 当前可信流 B seq2，旧流 A seq999 迟到 | 拒绝 A；不靠更大 seq 更换流 |
| quote 时右手空闲 rev21，commit 时持杯 rev22 | 重报或登记的左手版本；不丢杯、不执行半套 |
| 主动 quote 合法，首包时 permit 过期/输入代次改变 | 不开播、不 full confirm，收回准备 |
| 第一段消费完成但 handoffPending | 不 normalFinal；后台历史 ACK 慢不影响最终全组收势 |
| 取消 clearGeneration12 尚无 ACK，旧 ACK11 到达 | 不 cancelQuiet；实际收势可先做；匹配 ACK12 才确认安静 |
| 隐藏 40 秒后恢复，持杯现场，旧 cue TTL5 秒 | 不补演、不假报放杯完成，按可信现场重规划 |
| 任务书签 rev4，当前 rev5 已撤销且书消失 | 不恢复任务、不复活书；坐姿仍有效可保留 |
| 主动已播 12000 帧后断线，新 owner 接管 | PARTIAL/UNKNOWN 不整段重播、不 full confirm |
| 动作 emit 失败，音频和许可仍有效 | 只降级视觉，不调用 stop_audio |
| 主动正在生成且 busy owner 恰为同 claim | 续流不自锁；foreign/unknown owner 仍拒绝 |
| 用户“再挥一次”是新 requestId，同族未满 8 秒 | 可越过自发冷却；同 requestId 重放仍拒绝 |
| 从未输出过音频，宿主明确空闲，舞台许可有效 | 可以启动首项闲时活动，不等一次 normalFinal |
| 坐着被要求普通挥手 | 只选坐姿兼容版；不得隐式 stand_up |
| 情绪投影暂缺，但明确用户请求与身体现场有效 | 不冻结人物；取消情绪依赖选择，执行兼容请求 |
| 互动许可 TTL 未过，但 inputGeneration 已更新 | 旧允许闲时投影失效，等新权威结果，不能立即回书本 |
| commit 后页面挂起，首个可见采样时 cue 已过窗口 | 撤销预约、不扣次数、不执行首帧；该过期 cue 不重新续命 |
| 输出失败或空工具返回，队列恰为零 | 不 normalFinal、不假装完整说完；按宿主失败/空回复状态收束 |
| 一次数学状态更新产生四维 spike，或重连重复快照 | 合并一次机会/仅更新基底，不能四次反应或补演历史变化 |
| 旧 plan completed 迟到，通道已由稳定计划接管 | 旧 token 不释放新占用，也不重复退款 |
| 允许开始字段缺失，或 pendingReply 为 UNKNOWN | 不经 !undefined 放行；只阻止依赖它的新行为 |

另外验证：资源占用互斥、组合提交无半套、候选去重、预算退款/消耗、源撤销传播、已接纳输入历史不受影响、短词/回声判定不被导演改写、两种媒体 owner 不重复结算。

## 12. 接入点、缺口与分阶段验收

| 接入位置 | 当前事实 | 实施工作 |
| --- | --- | --- |
| `realtime/scheduler.mjs:69–90` | 部分表现 emit 失败会 `_fail → _cleanup → stop_audio` | 分离视觉故障和媒体撤销；仅宿主合法媒体事件停止音频 |
| `preview/core/full-body-controller.js:45–58` | 坐姿播非坐姿动作可自动 stand_up | 在调用前执行姿态族门，不能隐式触发起身 |
| `realtime/subtitle-sidecar.mjs:15–20` | 已有跨响应冷却 | 降为候选源，预算唯一归导演 |
| `wai/proactive/v2_outlet.py:86–240,293–411` | 准入/预约/当前检查/full confirm | 新媒体许可；区分准入、同 owner 续流、事实结算 |
| `wai/presence/dialogue_continuity.py:467,709` | lane 仅 bool；ACK 有撤销/交付语义 | owner 投影与显式晚回执 reconciliation |
| `tools/voice_avatar/duplex_runtime.py:199,281,604` | 当前双工接纳与 full ACK | 可信事件规范化，沿用输入/历史/帧数保护 |
| `wai/proactive/activity_planner.py:158` | 业务恢复有独立门槛 | 只读投影；不从动画 completed 反推业务完成 |

实施顺序：

1. **纯函数决策与事件回放**：版本/门结果/候选合并/预算/反例表；不接云、不改真实历史。
2. **单一表现适配**：读真实身体现场，完成原子占用、失败隔离、坐姿 gate、最小稳定收势；关闭旧导演的并行写骨骼入口。
3. **实模五类转场**：仅选具有已验收入场/让出/恢复的少量原生资源，观察书/杯/坐姿和衣发连续性。
4. **现有用户语音路径**：口型和 cue 绑定实际消费进度，检查 Qwen 转交、打断、历史保护；比较有/无导演的同条件首音频与连续播放。
5. **新增主动媒体交付**：claim/许可/同 owner 续流/partial/unknown/full receipt 单独验收后接入，不将文本预约直接外放。

决策日志只记录 ID、版本、门原因、通道、耗时和消费位置，默认不保存原文/原始语音/内心全文。建议面板显示“当前活动/注意对象/为何动或没动/占用/待让出/语音组与游标/许可与截止”，避免只有一个 playing 标签。

测量点：可信事件→可见注意（候选目标 ≤100 ms）；yield 接纳→检查点；实际音频→口型与语义峰值偏差；首音频增量；连续播放欠载；冷资源加载与稳定帧成本分开；取消请求→宿主真实静音和匹配 clear ACK 分开。硬件/worklet 缓冲残音须实测，不能保证瞬时零样本。

以上验收均为待实施清单。本次只进行了源码审阅、多代理反例讨论和文档一致性检查，未声称人物流畅度、云延迟或运行保护已经通过。
