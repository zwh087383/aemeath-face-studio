import { MODEL_ACTIONS } from '../model-director/catalog.mjs';
import { ACTIVITY_LIBRARY } from '../../preview/core/activity-library.js';
import { assertMotionAllowed } from '../../preview/core/character-motion-policy.js';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

export const NATIVE_GROUPS = freeze({
  'native:stand01': { groupId: 'native:c38c5010f63da5b2', label: '原生自然站姿 Stand01',
    sourceFamily: 'Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Stand01',
    phases: ['aimisi-stand01'], repeat: 1 },
  'native:thinking01': { groupId: 'native:ac884e85b5aef5d1', label: '原生思考 Thinking01',
    sourceFamily: 'Client/Content/Aki/Sequence/SequenceAnim/DialogAnim/FemaleM/Aimisi/Body/Thinking01',
    phases: ['aimisi-thinking01-start', 'aimisi-thinking01-loop', 'aimisi-thinking01-end'], repeat: 1 },
});

export const READING_ACTIONS = Object.freeze(['sit_down', 'take_book_seated', 'read_seated',
  'page_turn_seated', 'read_look_up', 'close_book', 'put_book_seated', 'stand_up_from_desk']);

const rows = [
  ...Object.entries(MODEL_ACTIONS).map(([id, row]) => ({ ...row, id, executor: 'conversation',
    channel: id === 'action:blink' ? 'face' : row.kind === 'action' ? 'head' : 'body',
    requires: id === 'action:blink' ? {} : { support: 'standing', hands: 'free' },
    note: '既有轨迹、身体幅度、近身肘部与挥手速度保持；没有每轮次数或冷却限制。' })),
  ...Object.entries(NATIVE_GROUPS).map(([id, row]) => ({ ...row, id, executor: 'native', channel: 'body',
    kind: 'native', name: id.slice(7), duration: id === 'native:thinking01' ? 6.0667 : null,
    requires: { support: 'standing', hands: 'free' },
    note: id === 'native:thinking01' ? '原速起势、一圈中段、原速收势；不添加手脸接触微动作。' : '一遍原生自然站姿；保持是有效选择，不代表同意或任务完成。' })),
  ...READING_ACTIONS.map(name => {
    const row = ACTIVITY_LIBRARY[name];
    return { id: `activity:${name}`, executor: 'activity', channel: 'body', kind: 'activity', name,
      label: row.name, duration: row.duration,
      requires: { support: row.initialSupport ?? 'standing', props: row.requires ?? [],
        ...(row.requiresHeld ? { held: row.requiresHeld } : {}),
        ...(row.reading ? { held: 'book' } : {}),
        ...(row.kind === 'take_prop' ? { hands: 'free', existingSource: row.propId } : {}) },
      note: '单项生活动作，由模型选择；实际桌椅、书与握点回执成立才执行，不使用固定连续配方。' };
  }),
];
for (const row of rows) assertMotionAllowed(row);
export const CHARACTER_ACTIONS = freeze(Object.fromEntries(rows.map(row => [row.id, row])));
export const CHARACTER_CATALOG = freeze({ version: 1, experimental: true, actions: rows });
export const ACTION_ANCHORS = Object.freeze(['immediate', 'prepare', 'voice', 'segment_end']);

export function validateCharacterCommands(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['operation', 'actions'].includes(key))
      || !['append', 'replace', 'clear'].includes(value.operation) || !Array.isArray(value.actions))
    throw Error('invalid_command');
  if (value.operation === 'clear' && value.actions.length) throw Error('clear_has_actions');
  return { operation: value.operation, actions: value.actions.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some(key => !['action', 'anchor', 'delay_ms'].includes(key))
        || !Object.hasOwn(CHARACTER_ACTIONS, row.action) || !ACTION_ANCHORS.includes(row.anchor)
        || !Number.isSafeInteger(row.delay_ms) || row.delay_ms < 0) throw Error('invalid_action');
    return { ...row };
  }) };
}
