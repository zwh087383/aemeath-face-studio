/** Local sustained-energy detector, not ASR. No audio leaves this page. */
export class VoiceGate {
  constructor({threshold=.018,onset=.12,release=.55}={}){this.threshold=threshold;this.onset=onset;this.release=release;this.high=0;this.low=0;this.active=false;}
  update(rms,dt){
    if(!Number.isFinite(rms)||!Number.isFinite(dt)||dt<0)return null;
    dt=Math.min(dt,.1);
    if(rms>=this.threshold){this.high+=dt;this.low=0;}else{this.low+=dt;this.high=0;}
    if(!this.active&&this.high>=this.onset){this.active=true;return 'speech-start';}
    if(this.active&&this.low>=this.release){this.active=false;return 'speech-end';}
    return null;
  }
}
