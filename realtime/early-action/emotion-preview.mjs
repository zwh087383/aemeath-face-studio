import {PRESET_BY_ID} from '../../preview/core/profile.js';

const fields=['V','A','D','S','L','T','effectiveEnergy'];

/** Lab-only, explicit scenario choices. These are neither a replacement for WAI
 * dynamics nor a classifier that can infer shyness/thinking from six numbers.
 * Existing expression recipes are reused; no new joint/morph trajectories.
 */
export function previewFromSample(sample){
  if(!sample||typeof sample.id!=='string'||!Object.hasOwn(PRESET_BY_ID,sample.preset))throw Error('Invalid emotion preview');
  for(const key of fields){
    const lower=key==='V'?-1:0,value=sample[key];
    if(typeof value!=='number'||!Number.isFinite(value)||value<lower||value>1)throw Error('Invalid emotion sample: '+key);
  }
  // Bounded display gain only. Relationship does not jump with each mood;
  // low energy remains independent from negative valence.
  const evidence=Math.max(Math.abs(sample.V),sample.S,1-sample.effectiveEnergy);
  const strength=Math.min(.82,.32+.40*evidence+.10*sample.A);
  return {id:sample.id,label:sample.label,preset:sample.preset,strength,
    emotion:Object.fromEntries(fields.map(key=>[key,sample[key]])),
    context:sample.context,source:'handwritten_local_test',experimental:true};
}

export function applyEmotionSample(face,sample){
  const result=previewFromSample(sample);
  if(face.setPreset(result.preset,result.strength)!==true)throw Error('Emotion preview was rejected');
  return result;
}

export function restoreComparisonFace(face){
  return face.setPreset('neutral',.8);
}
