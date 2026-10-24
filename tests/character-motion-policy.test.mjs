import test from 'node:test';
import assert from 'node:assert/strict';
import {USER_MOTION_EXCLUSIONS,motionExclusionFor,assertMotionAllowed} from '../preview/core/character-motion-policy.js';

const excluded=USER_MOTION_EXCLUSIONS[0];
test('user exclusion covers family, clip and original asset identity',()=>{
  for(const value of [{id:excluded.groupId},{id:excluded.clipId},{memberIds:[excluded.clipId]},
    {sourceAsset:excluded.sourceFamily+'.uasset'}]){
    assert.equal(motionExclusionFor(value),excluded);
    assert.throws(()=>assertMotionAllowed(value),/User-excluded motion/);
  }
});
test('renamed or retimed plans retain exclusions through source provenance',()=>{
  for(const value of [{id:'another-name',sourceId:excluded.clipId},
    {id:'mirrored',originalSourceAsset:excluded.sourceFamily+'.uasset'},
    {id:'retimed',sourceAsset:(excluded.sourceFamily+'.UASSET').replaceAll('/','\\')},
    {id:'combined',sourceIds:['aimisi-stand01',excluded.clipId]}])assert.throws(()=>assertMotionAllowed(value),/User-excluded motion/);
});
test('other approved demo sources are not matched by a vague stand-name ban',()=>{
  for(const value of [{id:'aimisi-stand01'}, {id:'aimisi-thinking01-loop'},
    {sourceAsset:'Client/Content/Aki/Character/Role/FemaleM/Aimisi/CommonAnim/UiAnim/Team_Stand2.uasset'}])assert.equal(motionExclusionFor(value),null);
});
