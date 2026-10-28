import { MODEL_ACTIONS } from '../model-director/catalog.mjs';
import { ACTIVITY_LIBRARY } from '../../preview/core/activity-library.js';
import { assertMotionAllowed } from '../../preview/core/character-motion-policy.js';
import { compileCharacterCatalog, deepFreeze, validatePerformance } from './catalog-compiler.mjs';
import { NATIVE_GROUPS as nativeGroups, NATIVE_INVENTORY as nativeInventory } from './native-contracts.mjs';
export { compileCharacterCatalog, validatePerformance } from './catalog-compiler.mjs';
export { resolveNativePerformance } from './native-contracts.mjs';

export const NATIVE_GROUPS = deepFreeze(nativeGroups);
export const NATIVE_INVENTORY = deepFreeze(nativeInventory);

export const READING_ACTIONS = Object.freeze(['sit_down', 'take_book_seated', 'read_seated',
  'page_turn_seated', 'read_look_up', 'close_book', 'put_book_seated', 'stand_up_from_desk']);

export const CHARACTER_CATALOG = deepFreeze(compileCharacterCatalog({conversation:MODEL_ACTIONS,
  nativeGroups:NATIVE_GROUPS,activities:ACTIVITY_LIBRARY,nativeInventory:NATIVE_INVENTORY}));
for(const row of CHARACTER_CATALOG.actions)assertMotionAllowed(row);
export const CHARACTER_ACTIONS = deepFreeze(Object.fromEntries(CHARACTER_CATALOG.actions.map(row=>[row.id,row])));
export const CATALOG_HASH = CHARACTER_CATALOG.hash;
export const ACTION_ANCHORS = Object.freeze(['immediate', 'prepare', 'voice', 'segment_end']);

export function validateCharacterCommands(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['operation', 'actions', 'goal', 'review'].includes(key))
      || !['keep', 'append', 'replace', 'clear'].includes(value.operation) || !Array.isArray(value.actions))
    throw Error('invalid_command');
  if (['clear','keep'].includes(value.operation) && value.actions.length) throw Error('clear_has_actions');
  if(value.goal!==undefined&&(typeof value.goal!=='string'||value.goal.length>160))throw Error('invalid_goal');
  if(value.review!==undefined&&!['on_finish','on_failure','wait'].includes(value.review))throw Error('invalid_review');
  return { ...value, actions: value.actions.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some(key => !['action', 'anchor', 'delay_ms', 'late', 'performance', 'activity_token'].includes(key))
        || typeof row.action!=='string' || typeof row.anchor!=='string' || !Object.hasOwn(CHARACTER_ACTIONS, row.action) || !ACTION_ANCHORS.includes(row.anchor)
        || !Number.isSafeInteger(row.delay_ms===undefined?0:row.delay_ms) || (row.delay_ms===undefined?0:row.delay_ms) < 0
        || !['skip','start_if_speaking','reconsider'].includes(row.late===undefined?'start_if_speaking':row.late)) throw Error('invalid_action');
    const definition=CHARACTER_ACTIONS[row.action];
    if(definition.channel==='control'?(typeof row.activity_token!=='string'||!row.activity_token.length||row.activity_token.length>160):row.activity_token!==undefined)throw Error('invalid_activity_token');
    if(definition.channel==='control'&&value.operation!=='append')throw Error('control_requires_append');
    const performance=validatePerformance(row.performance,definition);
    return { ...row,delay_ms:row.delay_ms??0,...(performance===undefined?{}:{performance}) };
  }) };
}
