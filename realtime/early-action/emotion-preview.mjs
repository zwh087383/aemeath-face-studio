import {C,PRESET_BY_ID} from '../../preview/core/profile.js';
import {PreparedFaceController} from './preparation.mjs';

const fields=['V','A','D','S','L','T','effectiveEnergy'];

/** Lab-only, explicit scenario choices. These are neither a replacement for WAI
 * dynamics nor a classifier that can infer shyness/thinking from six numbers.
 * Existing expression recipes are reused, with an explicitly bounded local
 * mouth-corner calibration. This never changes articulation or cloud cues.
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
  const cornerLowering=sample.cornerLowering??0;
  if(!Number.isFinite(cornerLowering)||cornerLowering<0||cornerLowering>.35)throw Error('Invalid mouth-corner calibration');
  return {id:sample.id,label:sample.label,preset:sample.preset,strength,cornerLowering,
    emotion:Object.fromEntries(fields.map(key=>[key,sample[key]])),
    context:sample.context,source:'handwritten_local_test',experimental:true};
}

export function applyEmotionSample(face,sample){
  const result=previewFromSample(sample);
  if(result.cornerLowering&&!face.setEmotionCalibration)throw Error('Emotion calibration is unavailable');
  if(face.setPreset(result.preset,result.strength)!==true)throw Error('Emotion preview was rejected');
  face.setEmotionCalibration?.(result.cornerLowering);
  return result;
}

export function restoreComparisonFace(face){
  face.clearEmotionCalibration?.();
  return face.setPreset('neutral',.8);
}

/** Only the handwritten idle preview owns this correction. Its own smoothed
 * offset avoids feeding the corrected result back into the shared controller.
 * Model responses use the original PreparedFaceController output unchanged.
 */
export class EmotionPreviewFaceController extends PreparedFaceController {
  constructor(){super();this.cornerTarget=0;this.cornerOffset=0;this.previewWeights=new Float32Array(this.weights.length);}
  setEmotionCalibration(value){
    if(!Number.isFinite(value)||value<0||value>.35)throw Error('Invalid mouth-corner calibration');
    this.cornerTarget=value;
  }
  clearEmotionCalibration(){this.cornerTarget=0;this.cornerOffset=0;}
  begin(epoch){const accepted=super.begin(epoch);if(accepted)this.clearEmotionCalibration();return accepted;}
  update(now,dt,lip,idle,options={}){
    const base=super.update(now,dt,lip,idle,options);
    if(this.active||options.mouthMode==='speech'){this.clearEmotionCalibration();return base;}
    if(!options.paused&&this.status!=='paused'){
      const step=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0));
      this.cornerOffset+=(this.cornerTarget-this.cornerOffset)*(1-Math.exp(-step/.12));
    }
    if(this.cornerOffset<1e-7)return base;
    this.previewWeights.set(base);
    this.previewWeights[C.frown]=Math.min(.5,base[C.frown]+this.cornerOffset);
    return this.previewWeights;
  }
}
