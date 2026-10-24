/** Explicit user exclusions. Passing this check is not automatic-use approval.
 * Keep source identity on renamed, mirrored or retimed derivatives.
 * Archive/resource inspection pages are not autonomous scheduling entrypoints.
 */
export const USER_MOTION_EXCLUSIONS=Object.freeze([
  Object.freeze({
    key:'user-excluded-raised-hand-stand2-20261024',
    groupId:'native:8b2e802a90db3da3',
    clipId:'body-stand2-84d0c0a158',
    sourceFamily:'Client/Content/Aki/Character/Role/FemaleM/Aimisi/CommonAnim/Stand2',
    reason:'用户禁止截图中持续抬起一只手的 Stand2 姿态；不得用于待机、倾听、恢复或兜底，也不得以改名、镜像或变速重新启用。',
  }),
]);

const normalizeSource=value=>String(value??'').replaceAll('\\','/').replace(/\.uasset$/i,'').toLowerCase();

export function motionExclusionFor(record={}){
  const ids=[record.id,record.sourceId,record.groupId,...(record.memberIds??[]),...(record.sourceIds??[])];
  const paths=[record.sourceAsset,record.sourceFamily,record.sourceRef,record.originalSourceAsset].filter(Boolean).map(normalizeSource);
  return USER_MOTION_EXCLUSIONS.find(rule=>ids.some(id=>id===rule.groupId||id===rule.clipId)||paths.includes(normalizeSource(rule.sourceFamily)))??null;
}

export function assertMotionAllowed(record){
  const excluded=motionExclusionFor(record);
  if(excluded)throw Error('User-excluded motion: '+excluded.key+' — '+excluded.reason);
  return record;
}
