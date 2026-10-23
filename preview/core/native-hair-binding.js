/** Explicit aliases for the 1.05 PMX's rebuilt long-hair chains.
 * The PMX inserts unweighted helper bones and renames the weighted native joints.
 * All 63 pairs were checked by head-relative bind position AND nearest weighted
 * ancestor topology. Four joints have edited bind positions; no runtime nearest
 * point selection is performed. Units are the PMX scene's native units.
 * Source/target bind positions were compared at retarget scale 0.12945839230207268.
 * This mapping transfers existing tracks; it does not synthesize hair physics.
 */
const rows = [
  ["右侧发A1","Bone_Hair071_R",0.001864,"Bip001Head","頭"],
  ["右侧发A3","Bone_Hair072_R",0.00146,"Bone_Hair071_R","右侧发A1"],
  ["右侧发A5","Bone_Hair073_R",0.001385,"Bone_Hair072_R","右侧发A3"],
  ["右侧发A7","Bone_Hair075_R",0.001702,"Bone_Hair073_R","右侧发A5"],
  ["右侧发A9","Bone_Hair076_R",0.002499,"Bone_Hair075_R","右侧发A7"],
  ["右侧发A11","Bone_Hair077_R",0.003221,"Bone_Hair076_R","右侧发A9"],
  ["右侧发B2","Bone_Hair081_R",0.001673,"Bone_Hair073_R","右侧发A5"],
  ["右侧发B4","Bone_Hair082_R",0.002493,"Bone_Hair081_R","右侧发B2"],
  ["左侧发A1","Bone_Hair071_L",0.001864,"Bip001Head","頭"],
  ["左侧发A3","Bone_Hair072_L",0.001461,"Bone_Hair071_L","左侧发A1"],
  ["左侧发A5","Bone_Hair073_L",0.001385,"Bone_Hair072_L","左侧发A3"],
  ["左侧发A7","Bone_Hair075_L",0.0017,"Bone_Hair073_L","左侧发A5"],
  ["左侧发A9","Bone_Hair076_L",0.002497,"Bone_Hair075_L","左侧发A7"],
  ["左侧发A11","Bone_Hair077_L",0.003217,"Bone_Hair076_L","左侧发A9"],
  ["左侧发B2","Bone_Hair081_L",0.001671,"Bone_Hair073_L","左侧发A5"],
  ["左侧发B4","Bone_Hair082_L",0.002493,"Bone_Hair081_L","左侧发B2"],
  ["后辫子中A1","Bone_Hair101_M",0.002745,"Bip001Head","頭"],
  ["后辫子中A3","Bone_Hair102_M",0.003054,"Bone_Hair101_M","后辫子中A1"],
  ["后辫子中A5","Bone_Hair103_M",0.002386,"Bone_Hair102_M","后辫子中A3"],
  ["后辫子中A7","Bone_Hair104_M",0.002368,"Bone_Hair103_M","后辫子中A5"],
  ["后辫子中A9","Bone_Hair131_L",0.003302,"Bone_Hair104_M","后辫子中A7"],
  ["后辫子中A11","Bone_Hair132_L",0.00512,"Bone_Hair131_L","后辫子中A9"],
  ["后辫子中A13","Bone_Hair133_L",0.007151,"Bone_Hair132_L","后辫子中A11"],
  ["后辫子中A15","Bone_Hair141_L",0.220836,"Bone_Hair133_L","后辫子中A13"],
  ["后辫子中A17","Bone_Hair135_L",0.009256,"Bone_Hair133_L","后辫子中A13"],
  ["后辫子中A19","Bone_Hair136_L",0.011216,"Bone_Hair135_L","后辫子中A17"],
  ["后辫子中B2","Bone_Hair142_L",0.010173,"Bone_Hair141_L","后辫子中A15"],
  ["后辫子中B4","Bone_Hair143_L",0.01172,"Bone_Hair142_L","后辫子中B2"],
  ["左辫子A2","Bone_Hair111_L",0.002937,"Bone_Hair104_M","后辫子中A7"],
  ["左辫子A4","Bone_Hair112_L",0.004823,"Bone_Hair111_L","左辫子A2"],
  ["左辫子A6","Bone_Hair113_L",0.006897,"Bone_Hair112_L","左辫子A4"],
  ["左辫子A8","Bone_Hair114_L",0.009026,"Bone_Hair113_L","左辫子A6"],
  ["左辫子A10","Bone_Hair115_L",0.011104,"Bone_Hair114_L","左辫子A8"],
  ["左辫子B2","Bone_Hair121_L",0.0032,"Bone_Hair104_M","后辫子中A7"],
  ["左辫子B4","Bone_Hair122_L",0.005083,"Bone_Hair121_L","左辫子B2"],
  ["左辫子B6","Bone_Hair124_L",0.300367,"Bone_Hair122_L","左辫子B4"],
  ["左辫子B8","Bone_Hair151_L",0.009064,"Bone_Hair124_L","左辫子B6"],
  ["左辫子B10","Bone_Hair152_L",0.010991,"Bone_Hair151_L","左辫子B8"],
  ["左辫子BB2","Bone_Hair125_L",0.009266,"Bone_Hair124_L","左辫子B6"],
  ["左辫子BB4","Bone_Hair127_L",0.011416,"Bone_Hair125_L","左辫子BB2"],
  ["右辫子A2","Bone_Hair131_R",0.003302,"Bone_Hair104_M","后辫子中A7"],
  ["右辫子A4","Bone_Hair132_R",0.005041,"Bone_Hair131_R","右辫子A2"],
  ["右辫子A6","Bone_Hair133_R",0.007052,"Bone_Hair132_R","右辫子A4"],
  ["右辫子A8","Bone_Hair134_R",0.009037,"Bone_Hair133_R","右辫子A6"],
  ["右辫子A10","Bone_Hair135_R",0.010962,"Bone_Hair134_R","右辫子A8"],
  ["右辫子B2","Bone_Hair111_R",0.183776,"Bone_Hair104_M","后辫子中A7"],
  ["右辫子B4","Bone_Hair112_R",0.004877,"Bone_Hair111_R","右辫子B2"],
  ["右辫子B6","Bone_Hair113_R",0.006931,"Bone_Hair112_R","右辫子B4"],
  ["右辫子B8","Bone_Hair115_R",0.009053,"Bone_Hair113_R","右辫子B6"],
  ["右辫子B10","Bone_Hair116_R",0.011154,"Bone_Hair115_R","右辫子B8"],
  ["右辫子C2","Bone_Hair121_R",0.003288,"Bone_Hair104_M","后辫子中A7"],
  ["右辫子C4","Bone_Hair123_R",0.097994,"Bone_Hair121_R","右辫子C2"],
  ["右辫子C6","Bone_Hair142_R",0.006894,"Bone_Hair123_R","右辫子C4"],
  ["右辫子C8","Bone_Hair143_R",0.00905,"Bone_Hair142_R","右辫子C6"],
  ["右辫子C10","Bone_Hair144_R",0.010451,"Bone_Hair143_R","右辫子C8"],
  ["右辫子C12","Bone_Hair145_R",0.011783,"Bone_Hair144_R","右辫子C10"],
  ["右辫子CC12","Bone_Hair124_R",0.007062,"Bone_Hair123_R","右辫子C4"],
  ["右辫子CC14","Bone_Hair125_R",0.008987,"Bone_Hair124_R","右辫子CC12"],
  ["右辫子CC16","Bone_Hair126_R",0.010692,"Bone_Hair125_R","右辫子CC14"],
  ["右辫子CC18","Bone_Hair127_R",0.012196,"Bone_Hair126_R","右辫子CC16"],
  ["右辫子CC22","Bone_Hair152_R",0.007118,"Bone_Hair123_R","右辫子C4"],
  ["右辫子CC24","Bone_Hair153_R",0.00915,"Bone_Hair152_R","右辫子CC22"],
  ["右辫子CC26","Bone_Hair154_R",0.011128,"Bone_Hair153_R","右辫子CC24"],
];

export const NATIVE_HAIR_BINDINGS = Object.freeze(rows.map(
  ([target, source, bindError, sourceParent, targetMappedParent]) => Object.freeze({
    target, source, bindError, sourceParent, targetMappedParent,
    confidence: bindError > .05 ? 'topology-verified-edited-bind' : 'position-and-topology-verified',
  })));
const sourceByTarget = new Map(NATIVE_HAIR_BINDINGS.map(row => [row.target, row.source]));
const targetsBySource = new Map();
for (const row of NATIVE_HAIR_BINDINGS) {
  const values = targetsBySource.get(row.source) ?? [];
  values.push(row.target);targetsBySource.set(row.source, values);
}
for (const [source, targets] of targetsBySource) targetsBySource.set(source, Object.freeze(targets));
const empty = Object.freeze([]);

/** The caller must check that this source exists in the selected clip. */
export function nativeHairSource(targetName) {return sourceByTarget.get(targetName) ?? null;}
export function nativeHairTargets(sourceName) {return targetsBySource.get(sourceName) ?? empty;}

function parentNames(bones) {
  return new Map(bones.map(bone => {
    let parent = bone.parentName;
    if (parent === undefined) {
      const value = bone.parentIndex ?? bone.parent;
      parent = typeof value === 'number' ? bones[value]?.name ?? null :
        typeof value === 'string' ? value : value?.isBone ? value.name : null;
    }
    return [bone.name, parent ?? null];
  }));
}

/** Accepts decoded source descriptors and either Three.Bone[] or PMX descriptors.
 * Missing bones are reported, never invented. Walk clips without hair tracks may
 * legitimately have missingSource > 0. Resolve only bindings whose source exists.
 */
export function auditNativeHairBindings(sourceBones, targetBones) {
  const sourceParents = parentNames(sourceBones), targetParents = parentNames(targetBones);
  const ancestorSource = new Map(sourceByTarget);
  ancestorSource.set('頭', 'Bip001Head');ancestorSource.set('Bip001Head', 'Bip001Head');
  const details = NATIVE_HAIR_BINDINGS.map(binding => {
    const sourcePresent = sourceParents.has(binding.source), targetPresent = targetParents.has(binding.target);
    let parent = targetParents.get(binding.target), visited = new Set();
    while (parent && !ancestorSource.has(parent) && !visited.has(parent)) {
      visited.add(parent);parent = targetParents.get(parent);
    }
    const targetMappedParent = parent ?? null, targetMappedParentSource = ancestorSource.get(parent) ?? null;
    const sourceParent = sourceParents.get(binding.source) ?? null;
    return {...binding, sourcePresent, targetPresent, targetMappedParent,
      targetMappedParentSource, actualSourceParent: sourceParent,
      topologyMatch: sourcePresent && targetPresent && sourceParent === targetMappedParentSource};
  });
  const mapped = details.filter(row => row.sourcePresent && row.targetPresent).length;
  const topologyMatched = details.filter(row => row.topologyMatch).length;
  return {expected: details.length, mapped, topologyMatched,
    missingSource: details.filter(row => !row.sourcePresent).length,
    missingTarget: details.filter(row => !row.targetPresent).length,
    complete: mapped === details.length && topologyMatched === mapped, bindings: details};
}
