import test from 'node:test';
import assert from 'node:assert/strict';
import {findNativeRibbonCompanion} from '../preview/core/native-companion.js';
const body={resourceKind:'body',sourceAsset:'Character/Aimisi/CommonAnim/Stand2.uasset',sourceSkeleton:'Aimisi'};
const companion={resourceKind:'ribbon',status:'ready',id:'rib-stand2',sourceSkeleton:'Aimisi',sourceAsset:'Character/Aimisi/RibbonAnim/Rib_Stand2.uasset'};
test('pairs the exact authored filename even when the body display name is localized',()=>{
  assert.equal(findNativeRibbonCompanion({...body,name:'待机'},[companion]),companion);
});
test('rejects partial names, unavailable data, other skeletons and non-body requests',()=>{
  for(const row of [{...companion,status:'archived'},{...companion,sourceSkeleton:'Other'},{...companion,sourceAsset:'Character/Aimisi/RibbonAnim/Rib_Stand20.uasset'}])assert.equal(findNativeRibbonCompanion(body,[row]),null);
  assert.equal(findNativeRibbonCompanion({...body,resourceKind:'prop-animation'},[companion]),null);
  assert.equal(findNativeRibbonCompanion(undefined,[companion]),null);
  assert.equal(findNativeRibbonCompanion({resourceKind:'body'},[companion]),null);
});
test('uses the character-specific path and refuses equally plausible matches',()=>{
  const unrelated={...companion,id:'common',sourceAsset:'Shared/RibbonAnim/Rib_Stand2.uasset'};
  assert.equal(findNativeRibbonCompanion(body,[unrelated,companion]),companion);
  assert.equal(findNativeRibbonCompanion(body,[companion,{...companion,id:'ambiguous',sourceAsset:'Character/Aimisi/Other/Rib_Stand2.uasset'}]),null);
});
