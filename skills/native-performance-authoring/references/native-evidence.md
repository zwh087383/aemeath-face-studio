# 已验证的资源结构与推断边界

依据本机 2026-10-22 对 Aemeath/Aimisi 导出资源及解码器的检查。换模型/资源版本时重新验证，不能当作整个游戏或行业的固定做法。

## 面部

- 17 个角色表情的面部部分共 108 曲线、3145 解码点，所有曲线时间跨度内恒定。它们提供组合姿态，不提供起势或收势时序。
- Smile 两嘴角各0.75；Wink两嘴角约0.6000006/0.6181814，存储单侧眼通道；Jingya的Pupil_Scale为-0.09090781。保留左右差异和合法负值，不统一clip到0..1。
- 4段全游戏口型抽样存在动态、多元音重叠权重，总和不必等于1。不能将其当互斥分类概率。样本不是角色专属，更不是实时音频求解器。
- ACL解码重建Time/Value，其余RichCurve字段使用Linear/Auto/WeightedNone和零切线默认值。因此导出Linear不说明原DCC使用线性插值，播放器支持Hermite也不说明源文件使用它。

## 身体、注视与衣发

- AO_LookAt真实类型AimOffsetBlendSpace：9方向，输入参数x±90/y±30，21个grid sample；各权重和约1。9方向姿态为MeshSpace additive。输入范围不等于某根头骨的实际旋转范围。
- Rib_Stand2是LocalSpace additive，RefPose基准，4秒121帧。配套衣发有显著轨迹，身体里的相应轨迹基本静止。解码器会将有效additive烘焙为完整姿态，必须检查sourceAdditiveType/additiveBakedToFullPose。
- SitTalk01有Start/Loop/End，约1.67/5.33/1.63秒。上半身连接角差小于0.004度只证明姿态吻合，不证明速度/加速度连续。
- 转身包含root约90度旋转和中间位移。不能用旋转容器等价替代，也不能由此确定游戏root-motion extraction设置。
- 不同部位有不同时间分布；不同动作先后关系会改变。累计旋转变化量T10不是动作起点，更不是神经反应延迟。

## 不能仅凭最终轨迹确认

DCC软件、手K/动捕比例、原始Bezier切线、物理求解器及刚度阻尼、IK控制器、对话导演、台词情绪与动作自动关联。可以拟合近似函数并报告误差，不能将拟合命名为恢复原制作公式。

本地原始审计（不作为可发布素材）：`outputs/production-techniques-20261022/{face-findings.md,motion-findings.md,face-analysis.json,motion-analysis.json,structure-evidence.json}`。原生数据路径由项目适配参考给出，源码仓库不附带游戏模型、包、动作曲线或资源密钥。
