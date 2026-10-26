// The existing server rejects a response beyond 35 seconds. Admit its bounded
// burst even when generation outruns playback; the .04 s start lead is unchanged.
export const CHARACTER_AUDIO_OPTIONS=Object.freeze({leadSeconds:.04,maxBufferedSeconds:40,maxRetainedSeconds:120});
