/** Current user review, keyed by exact game-source identity. Raw assets remain archived. */
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
export const NATIVE_MOTION_REVIEWS = deepFreeze([
  {
    "key": "user-review-stand2-20261030",
    "groupId": "native:8b2e802a90db3da3",
    "name": "Stand2",
    "sourceFamily": "Client/Content/Aki/Character/Role/FemaleM/Aimisi/CommonAnim/Stand2",
    "clipIds": [
      "body-stand2-84d0c0a158"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-dz_sit_baoyuan01-20261030",
    "groupId": "native:d387689ca7480266",
    "name": "DZ_Sit_Baoyuan01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Dongbu/DZ_Sit_Baoyuan01",
    "clipIds": [
      "body-dz-sit-baoyuan01-end-10041149e2",
      "body-dz-sit-baoyuan01-loop-ded61639ea",
      "body-dz-sit-baoyuan01-start-974e682fc2"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户确认该动作需要两个人，移出单角色动作库。"
  },
  {
    "key": "user-review-stand_cidai01-20261030",
    "groupId": "native:a7fae56b726017f3",
    "name": "Stand_Cidai01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Stand_Cidai01",
    "clipIds": [
      "body-stand-cidai01-7695a086a0"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-run_cidai-20261030",
    "groupId": "native:fabb7cc7975abc36",
    "name": "Run_cidai",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Dongbu/Run_cidai",
    "clipIds": [
      "body-run-cidai-end-8b47110cc1",
      "body-run-cidai-loop-f78ea513f9"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-take_mai01-20261030",
    "groupId": "native:b3995daef6768540",
    "name": "Take_Mai01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Dongbu/Take_Mai01",
    "clipIds": [
      "body-take-mai01-start-ba81d303d8"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-keboard01-20261030",
    "groupId": "native:fdc84d12a3151b50",
    "name": "keboard01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/keboard01",
    "clipIds": [
      "body-keboard01-start-cc75486ba0"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-aimisi_fanclub-20261030",
    "groupId": "native:e3982a0f20f077d3",
    "name": "Aimisi_Fanclub",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/ShengtaiAnim/3_1/Aimisi_Fanclub/RoleNPC/FemaleM/Aimisi/BaseAnim/Aimisi_Fanclub",
    "clipIds": [
      "body-aimisi-fanclub-6e686ba208"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-motorpassenger_stand-20261030",
    "groupId": "native:2c08e1587c70338f",
    "name": "MotorPassenger_Stand",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/fuyong/MotorPassenger_Stand",
    "clipIds": [
      "body-motorpassenger-stand-799e288751"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-mortor_zhixiang01-20261030",
    "groupId": "native:e0f98b6937ae7581",
    "name": "Mortor_Zhixiang01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Mortor_Zhixiang01",
    "clipIds": [
      "body-mortor-zhixiang01-303530d313"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-dz_motor_shouji01-20261030",
    "groupId": "native:672f2ae8da782c1e",
    "name": "DZ_Motor_shouji01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Dongbu/DZ_Motor_shouji01",
    "clipIds": [
      "body-dz-motor-shouji01-end-af1a813cbf",
      "body-dz-motor-shouji01-loop-c142d7daa6"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-motor_dajian01-20261030",
    "groupId": "native:7ace2eeca3df3164",
    "name": "Motor_Dajian01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Motor_Dajian01",
    "clipIds": [
      "body-motor-dajian01-loop-dc02c03b56"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-touch01-20261030",
    "groupId": "native:23f5575235298821",
    "name": "Touch01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Touch01",
    "clipIds": [
      "body-touch01-end-1002ba605f",
      "body-touch01-loop-4fb7e8a8fe",
      "body-touch01-start-b7c7611287"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-stand1_action01-20261030",
    "groupId": "native:0821a125b3bc93c6",
    "name": "Stand1_Action01",
    "sourceFamily": "Client/Content/Aki/Character/Role/FemaleM/Aimisi/CommonAnim/Stand1_Action01",
    "clipIds": [
      "body-stand1-action01-39d6c0f416"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-stand1_action02-20261030",
    "groupId": "native:7d7d364e5da57ae0",
    "name": "Stand1_Action02",
    "sourceFamily": "Client/Content/Aki/Character/Role/FemaleM/Aimisi/CommonAnim/Stand1_Action02",
    "clipIds": [
      "body-stand1-action02-68a07af608"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-xa_loop_stand-20261030",
    "groupId": "native:899df122e85e24ad",
    "name": "XA_Loop_Stand",
    "sourceFamily": "Client/Content/Aki/Character/Role/FemaleM/Aimisi/CommonAnim/XA_Loop_Stand",
    "clipIds": [
      "body-xa-loop-stand-76953dcaa5"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-dz_tanzuo03-20261030",
    "groupId": "native:f8ad9f06284a95af",
    "name": "DZ_Tanzuo03",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Dongbu/DZ_Tanzuo03",
    "clipIds": [
      "body-dz-tanzuo03-3571127c36"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-dz_chiru01-20261030",
    "groupId": "native:0dfd916932ec9a86",
    "name": "DZ_Chiru01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Dongbu/DZ_Chiru01",
    "clipIds": [
      "body-dz-chiru01-end-31c0e7e4ff",
      "body-dz-chiru01-loop-5ccaefa2cb",
      "body-dz-chiru01-start-3fec81b4de"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-dz_rushui01-20261030",
    "groupId": "native:c4d8560a755b676d",
    "name": "DZ_Rushui01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Dongbu/DZ_Rushui01",
    "clipIds": [
      "body-dz-rushui01-end-b53ac20a80",
      "body-dz-rushui01-loop-d8b59f6de0",
      "body-dz-rushui01-start-86df900d93"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-dz_fly01-20261030",
    "groupId": "native:80df4ff9629d8d29",
    "name": "DZ_Fly01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/DZ_Fly01",
    "clipIds": [
      "body-dz-fly01-e8306d39ba"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-dz_hunmi-20261030",
    "groupId": "native:843267a93253e5fc",
    "name": "DZ_Hunmi",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/DZ_Hunmi",
    "clipIds": [
      "body-dz-hunmi-09d8e97640"
    ],
    "status": "excluded",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户点名或截图指定移除该动作。"
  },
  {
    "key": "user-review-shy02-20261030",
    "groupId": "native:c2e6400f4b7a11bc",
    "name": "Shy02",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Shy02",
    "clipIds": [
      "body-shy02-end-a11162eb98",
      "body-shy02-loop-86612cdd8c",
      "body-shy02-start-c87b778462"
    ],
    "status": "confirmed",
    "meaning": "身体前倾说话",
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户观看后确认：身体前倾说话。"
  },
  {
    "key": "user-review-dz_tanqi01-20261030",
    "groupId": "native:371b5ec2ffb45558",
    "name": "DZ_Tanqi01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Dongbu/DZ_Tanqi01",
    "clipIds": [
      "body-dz-tanqi01-end-05246cd8c6",
      "body-dz-tanqi01-loop-20ae225956",
      "body-dz-tanqi01-start-7dd74b2db7"
    ],
    "status": "confirmed",
    "meaning": "哭泣",
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户观看后确认：哭泣。"
  },
  {
    "key": "user-review-complain04-20261030",
    "groupId": "native:9387f2034f744008",
    "name": "Complain04",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Complain04",
    "clipIds": [
      "body-complain04-end-9c05f67b43",
      "body-complain04-loop-827f77d3e6",
      "body-complain04-start-67014e5444"
    ],
    "status": "pending",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户撤回旧解读，动作含义待确认。"
  },
  {
    "key": "user-review-wuzui01-20261030",
    "groupId": "native:9c4593a540925363",
    "name": "Wuzui01",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Dongbu/Wuzui01",
    "clipIds": [
      "body-wuzui01-end-8b7eb54cbc",
      "body-wuzui01-loop-8a924ef196",
      "body-wuzui01-start-7ea76d5513"
    ],
    "status": "pending",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户撤回旧解读，动作含义待确认。"
  },
  {
    "key": "user-review-wuzui02-20261030",
    "groupId": "native:f028ae3669e3164b",
    "name": "Wuzui02",
    "sourceFamily": "Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Dongbu/Wuzui02",
    "clipIds": [
      "body-wuzui02-end-126f9e6a29",
      "body-wuzui02-loop-ac931c9867",
      "body-wuzui02-start-ea77396c2f"
    ],
    "status": "pending",
    "meaning": null,
    "reviewedAt": "2026-10-30",
    "reviewedBy": "user",
    "reason": "用户撤回旧解读，动作含义待确认。"
  }
]);

const sourceFamily = value => String(value ?? '').replaceAll('\\', '/').replace(/\.uasset$/i, '').replace(/_(?:start|loop\d*|end)$/i, '').toLowerCase();

/** Follow provenance through compiled actions, phases and renamed derivatives. */
export function nativeMotionReviewFor(record = {}) {
  const ids = new Set(), paths = new Set(), seen = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const key of ['id', 'sourceId', 'groupId', 'clipId']) if (typeof value[key] === 'string') ids.add(value[key]);
    for (const key of ['sourceAsset', 'sourceFamily', 'sourceRef', 'originalSourceAsset', 'family']) if (typeof value[key] === 'string') paths.add(sourceFamily(value[key]));
    for (const key of ['memberIds', 'sourceIds', 'clipIds', 'phases', 'phaseData', 'sources']) for (const item of value[key] ?? []) typeof item === 'string' ? ids.add(item) : visit(item);
    visit(value.source);
  };
  visit(record);
  // A composed record inherits any exclusion before another semantic review.
  const matches = NATIVE_MOTION_REVIEWS.filter(row => ids.has(row.groupId) || row.clipIds.some(id => ids.has(id)) || paths.has(sourceFamily(row.sourceFamily)));
  return matches.find(row => row.status === 'excluded') ?? matches.find(row => row.status === 'pending') ?? matches[0] ?? null;
}

/** Project current wording onto an immutable archived preparation record. */
export function applyNativeMotionReview(record) {
  const review = nativeMotionReviewFor(record);
  if (!review) return record;
  const pending = review.status === 'pending', excluded = review.status === 'excluded';
  const purpose = excluded ? '已移出可选动作库。' : pending ? '动作含义待确认。' : review.meaning + '。';
  const trigger = excluded ? '该来源已移除。' : pending ? '人工预览确认动作含义。' : '表达目的与“' + review.meaning + '”一致时选择，并核对当前支撑与持物条件。';
  return { ...record, userReview: review, displayName: `${review.name} · ${excluded ? '已移除' : pending ? '含义待确认' : review.meaning}`,
    reviewPurpose: [purpose], firstLookReason: review.reason, usageRuleIds: [],
    reuseComparison: { nativeFirstIds: [], authoredIds: [], reasons: [review.reason], admissionGranted: false },
    prerequisitesToResolve: pending ? ['待用户确认动作含义。'] : record.prerequisitesToResolve,
    semanticStatus: review.status,
    ...(record.usage ? { usage: { ...record.usage, purpose, trigger, semanticEvidence: review.reason,
      preconditions: ['核对当前支撑、持物及进入退出阶段。'], prohibited: [], notes: [review.reason] } } : {}),
  };
}

export function reviewedNativeGroups(groups) {
  return groups.filter(group => nativeMotionReviewFor(group)?.status !== 'excluded').map(applyNativeMotionReview);
}
