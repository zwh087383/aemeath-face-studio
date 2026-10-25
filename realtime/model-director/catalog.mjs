import {AVATAR_CATALOG} from '../avatar/controller-bridge.mjs';
import {GESTURES} from '../../preview/core/motion-profile.js';
import {ACTIONS} from '../../preview/core/profile.js';
import {assertMotionAllowed} from '../../preview/core/character-motion-policy.js';

// Only executable resources, not the research/export catalogue. Expressions
// remain under the existing mathematical state and articulation owners.
export const MODEL_ACTIONS = Object.freeze(Object.fromEntries(Object.entries(AVATAR_CATALOG)
  .filter(([key]) => !key.startsWith('expression:'))
  .map(([key, definition]) => {
    assertMotionAllowed({id:key});
    const [kind, name] = key.split(':');
    return [key, Object.freeze({...definition, cooldown:0, kind, name,
      label:(kind==='gesture'?GESTURES:ACTIONS)[name]?.name ?? name})];
  })));

export function validateCommands(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)
      || Object.keys(value).some(k=>!['operation','actions'].includes(k))
      || !['append','replace','clear'].includes(value.operation) || !Array.isArray(value.actions))
    throw Error('invalid_command');
  if (value.operation==='clear' && value.actions.length) throw Error('clear_has_actions');
  return {operation:value.operation, actions:value.actions.map(row=>{
    if (!row || typeof row!=='object' || Array.isArray(row)
        || Object.keys(row).some(k=>!['action','anchor','delay_ms'].includes(k))
        || !Object.hasOwn(MODEL_ACTIONS,row.action) || !['prepare','voice'].includes(row.anchor)
        || !Number.isSafeInteger(row.delay_ms) || row.delay_ms<0) throw Error('invalid_action');
    return {...row};
  })};
}
