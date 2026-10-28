import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CHARACTER_CATALOG,NATIVE_GROUPS} from '../../realtime/character-center/catalog.mjs';

// Consolidates disjoint real-target batches without disguising historical
// failures or treating a partial process output as complete coverage.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2),outputIndex=args.indexOf('--output');
if(outputIndex<0||!args[outputIndex+1])throw Error('Specify --output and the input report paths.');
const destination=path.resolve(root,args[outputIndex+1]);
if(!destination.startsWith(root+path.sep))throw Error('Output must remain in this worktree.');
const proofIndex=args.indexOf('--catalog-proof');
const proof=proofIndex<0?null:JSON.parse(fs.readFileSync(path.resolve(root,args[proofIndex+1]),'utf8'));
const hashNative=groups=>crypto.createHash('sha256').update(JSON.stringify(groups)).digest('hex');
const nativeCatalogSha256=hashNative(NATIVE_GROUPS);
if(proof&&(proof.nativeCatalogSha256!==nativeCatalogSha256||hashNative(proof.nativeGroups)!==nativeCatalogSha256))throw Error('Native contracts changed since the saved proof.');
const inputs=args.filter((_,i)=>i!==outputIndex&&i!==outputIndex+1&&(proofIndex<0||i!==proofIndex&&i!==proofIndex+1));
if(!inputs.length)throw Error('At least one input report is required.');
let targetSha256=null,startedAt=null;const groups=new Map(),provenance=[];
for(const relative of inputs){
  const file=path.resolve(root,relative),bytes=fs.readFileSync(file),report=JSON.parse(bytes);
  if(report.catalogHash!==CHARACTER_CATALOG.hash&&report.catalogHash!==proof?.catalogHash)throw Error('Catalog version mismatch: '+relative);
  if(report.nativeCatalogSha256&&report.nativeCatalogSha256!==nativeCatalogSha256)throw Error('Native contract mismatch: '+relative);
  if(targetSha256&&report.targetSha256!==targetSha256)throw Error('Target model mismatch: '+relative);
  targetSha256=report.targetSha256;
  if(!startedAt||report.startedAt<startedAt)startedAt=report.startedAt;
  for(const row of report.groups){
    if(!NATIVE_GROUPS[row.id])throw Error('Unknown native behavior: '+row.id);
    if(groups.has(row.id))throw Error('Overlapping evidence: '+row.id);
    groups.set(row.id,row);
  }
  provenance.push({file:path.relative(root,file).replaceAll('\\','/'),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),catalogHash:report.catalogHash,groups:report.groups.length,finishedAt:report.finishedAt??null});
}
const missing=Object.keys(NATIVE_GROUPS).filter(id=>!groups.has(id));
if(missing.length)throw Error('Incomplete real-target evidence: '+missing.join(','));
const ordered=Object.keys(NATIVE_GROUPS).map(id=>groups.get(id));
const failures=ordered.filter(row=>!row.passed).map(({id,sourceFamily,reason})=>({id,sourceFamily,reason}));
const result={schema:1,catalogHash:CHARACTER_CATALOG.hash,nativeCatalogSha256,targetSha256,startedAt,finishedAt:new Date().toISOString(),
  scope:'Actual source GLTF and target PMX skeleton. All declared source phases, boundaries and quarter points; start/loop/end-kind cancellations. Does not certify GPU rendering, clothing collision clearance, subjective naturalness or all pairwise action transitions.',
  evidenceNotes:[
    'Inputs remain separate and unchanged; a completed partial prefix may be combined with disjoint continuation shards only when catalogue and target fingerprints match.',
    ...(proof?['The saved catalogue proof independently verifies unchanged native contracts across unrelated activity-catalog additions. Original whole-catalogue fingerprints remain in provenance.']:[]),
    'This measures numerical execution and declared contacts. Scene staleness, asynchronous cancellation ownership, blocked routes and distinct loop variants have separate real-target regression tests.',
    'An exposed single-loop phase permission is the exact same route as the corresponding default behavior. Thinking02 has two distinct loop alternatives, exercised separately in native-library-real-target.test.mjs.'
  ],provenance,groups:ordered,failures,passed:failures.length===0,
  coverage:{requested:Object.keys(NATIVE_GROUPS).length,completed:ordered.length,passed:ordered.filter(row=>row.passed).length,
    sampledFrames:ordered.reduce((n,row)=>n+row.samples.length,0),phaseCancellations:ordered.reduce((n,row)=>n+row.cancellations.length,0)}};
fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({destination,...result.coverage,failures:failures.length}));
if(failures.length)process.exitCode=1;
