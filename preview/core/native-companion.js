const leaf=row=>String(row.sourceAsset??'').split('/').at(-1).replace(/\.uasset$/i,'').toLowerCase();
const commonPath=(a,b)=>{
  const left=String(a).split('/'),right=String(b).split('/');let count=0;
  while(count<Math.min(left.length,right.length)&&left[count]===right[count])count++;
  return count;
};

/** Pair only an exact authored Rib_<body asset name> on a compatible skeleton.
 * Ambiguous ties stay unpaired; display labels never infer choreography. */
export function findNativeRibbonCompanion(body,clips){
  if(!body||body.resourceKind!=='body'||!body.sourceAsset)return null;
  const expected='rib_'+leaf(body);
  const matches=clips.filter(row=>row.resourceKind==='ribbon'&&row.status==='ready'&&leaf(row)===expected&&
    (!body.sourceSkeleton||!row.sourceSkeleton||body.sourceSkeleton===row.sourceSkeleton));
  const ranked=matches.map(row=>({row,score:commonPath(body.sourceAsset,row.sourceAsset)})).sort((a,b)=>b.score-a.score);
  return ranked.length&&(ranked.length===1||ranked[0].score>ranked[1].score)?ranked[0].row:null;
}
