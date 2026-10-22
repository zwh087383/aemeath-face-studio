# 生活与运动实验室（实验性）

在既有交流表演库之外增加真实全身位移、腿部支撑和物品交互。入口为 `/activities/`；原来的表情、小动作和交流长片段继续在 `/performance/library/`。

```powershell
node realtime/avatar-server.mjs --port 18788
```

打开 `http://127.0.0.1:18788/activities/`。可直接打开 `#sequence=reading_break` 或 `#activity=jump_forward` 自动展示指定内容。本机必须已有 `assets/Aemeath/` 模型与贴图、`preview/node_modules/` 依赖；本批源代码不包含这些素材，也不读取云密钥。

## 内容与操作

分类覆盖八个方向行走、转向与绕弯、慢跑和加速跑、各方向跳跃与缓冲落地、坐姿和起身、阅读翻页、运动伸展、喝水写字打字和抱箱。目录和数量来自 `preview/core/activity-library.js`，页面自动更新。

七段连续生活：走来坐下读书再离开、晨间运动、多方向敏捷练习、桌前工作休息、午后阅读、平衡练习、取箱后退离桌。支持名称/ID 搜索、分类、五个视角、相机跟随和下次活动的播放速度调整。

- **暂停**：冻结逻辑时间、身体、道具与序列。
- **安全停止**：撤销后续片段；腾空先落地；落座途中完成支撑转移；已坐下保留座位与当前姿态。
- **重置舞台**：明确回到原点，清除队列和道具。只有这个按钮有意重置空间位置。

独立动作之间有支撑状态检查，直接选择坐姿阅读会自动落座，从坐姿选择行走会先起身。行走结束保留实际位移，支撑脚在世界坐标固定，摆动脚才移动。静态家具保留在放置位置；杯、书、箱等手持物跟随渲染后的掌锚。

## 接入边界

`FullBodyController` 是全身层，`ActivityDirector` 是唯一序列拥有者；外层组负责根位移/朝向。每帧先计算骨骼，再应用 MMD grant、更新骨架矩阵，最后根据实际骨骼布置道具。原 `MotionController` 与 56 项交流动作没有改动，也没有让两个控制器同时写同一具身体。

```js
director.play('walk_forward');
director.playSequence('reading_break');
const clock = director.tick(performance.now() / 1000);
scene.step(clock.now, clock.dt, { paused: clock.paused });
director.stop();
```

表情使用已有 `FaceController`，由活动的 `face` 轨道选择。`scene.step()` 保留 `lip` 输入口型通道，但此页面是本地无声预览，不请求 Qwen、不录麦克风、不改 WAI 记忆或历史；本轮不能作为语音延迟复测。接入语音系统时应由宿主选择唯一身体拥有者，不能直接叠加两个骨骼解算器。

## 验证

```powershell
node --test tests/activity-library.test.mjs tests/full-body-controller.test.mjs tests/activity-props.test.mjs tests/activity-director.test.mjs tests/activity-sequences.test.mjs
node realtime/browser-activities.cjs http://127.0.0.1:18788/activities/
```

浏览器脚本使用本机 Chrome 和项目已有 Playwright，结果写入被 Git 忽略的 `outputs/full-body-activities-20261022/`。它把确定性骨骼采样与真实时间播放分开记录；不覆盖浏览器全局 rAF，因为 Three 的蒙皮缓存也依赖它。

## 当前局限

这是手工设计轨迹加 IK 的程序动画，不是动捕。没有启用衣发动力学和通用家具碰撞/寻路；测试对指定场景的脚接触、身体可达和关键道具接触负责，不等于任意动作组合都不会穿插。长发、裙摆在椅背附近仍可能穿插。书页、打字和握物属于简化表演，手指不是逐指物理抓握。

道具均由源码建模，包括椅、桌、书、杯、纸、笔、笔电、阶梯、运动垫和纸箱；阶梯是已建好的场景道具，尚未配置专用上下阶梯动作。现有搬运明确从台面取箱，不宣称已实现从地面抓取、爬楼或任意路径导航。
