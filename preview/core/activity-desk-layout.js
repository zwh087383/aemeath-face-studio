import { add, sub, len, qrotate, qmul, qconj, qeuler } from './motion-math.js';

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
/** Real tabletop zones. No object is hidden or moved when another task starts.
 * The closed laptop has its own zone and a real hinge sequence when typing. */
export const PARTITIONED_DESK = freeze({
  id: 'partitioned', paperCenter: [-3.2, 8.935, 2.9], laptopCenter: [.5, 8.94, 3.2],
  setupProps: {
    table: true,
    paper: { visible: true, attachment: 'table', position: [-3.2, 8.935, 2.9] },
    laptop: { visible: true, attachment: 'table', position: [.5, 8.94, 3.2], openness: 0 },
    book: { visible: true, attachment: 'table', position: [0, 9.184839916, 6.6], rotation: [-Math.PI / 2, Math.PI / 2, 0], openness: 0 },
    mug: { visible: true, attachment: 'table', position: [-3.5, 8.9, 5.3] },
    pencil: { visible: true, attachment: 'table', position: [-1.8, 8.961, 4.3], rotation: [0, 0, Math.PI / 2] },
  },
  placementTargets: {
    book: { position: [0, 9.184839916, 6.6], quaternion: qmul(qeuler(0, Math.PI / 2, 0), qeuler(0, 0, -Math.PI / 2)) },
    mug: { position: [-3.5, 8.9, 5.3], quaternion: [0, 0, 0, 1] },
    pencil: { position: [-1.8, 8.961, 4.3], quaternion: qeuler(0, 0, Math.PI / 2) },
  },
});

export const deskLayout = context => context?.deskLayout === PARTITIONED_DESK.id ? PARTITIONED_DESK : null;

/** Convert a fixed table-layout point using the actual rendered table frame.
 * A chair rebase must not silently move this tabletop or any stored prop. */
export function deskWorldFrame(context, position, quaternion = [0, 0, 0, 1]) {
  const physical = context?.sceneProps?.table?.worldTransform ?? context?.initialProps?.table?.worldTransform;
  if (physical) return { position: add(physical.position, qrotate(physical.quaternion, sub(position, [0, 0, 4.3]))),
    quaternion: qmul(physical.quaternion, quaternion), space: 'world' };
  return { position: [...position], quaternion: [...quaternion], space: 'activity' };
}

export function deskPropState(context, id, overrides = {}) {
  const raw = PARTITIONED_DESK.setupProps[id], state = raw === true ? { visible: true, attachment: 'floor' } : structuredClone(raw), actual = context?.sceneProps?.[id] ?? context?.initialProps?.[id];
  return { ...state, ...(actual?.worldTransform ? { worldTransform: structuredClone(actual.worldTransform) } : {}), ...overrides };
}

/** A fixed multi-object recipe cannot silently reorganize an existing desk.
 * Actual rendered transforms are authoritative; unsupported existing layouts
 * are rejected atomically so no hand starts moving toward an invented zone. */
export function partitionedDeskConflict(sceneProps = {}, heldProps = {}) {
  const table = sceneProps.table?.worldTransform;
  if (!table) return null; // Empty scenes receive the explicit recipe setup.
  for (const [id, desired] of Object.entries(PARTITIONED_DESK.setupProps)) {
    if (id === 'table' || ['left', 'right', 'both'].includes(heldProps[id]?.attachment)) continue;
    const actual = sceneProps[id]; if (!actual?.visible || !actual.worldTransform) continue;
    const position = qrotate(qconj(table.quaternion), sub(actual.worldTransform.position, table.position));
    const expected = sub(desired.position, [0, 0, 4.3]), error = len(sub(position, expected));
    if (error > .08) return { id, reason: 'existing-desk-object-outside-supported-zone', positionError: error, actual: actual.worldTransform.position };
    const targetQuaternion = id === 'book' ? PARTITIONED_DESK.placementTargets.book.quaternion
      : id === 'pencil' ? PARTITIONED_DESK.placementTargets.pencil.quaternion : [0, 0, 0, 1];
    const relative = qmul(qconj(table.quaternion), actual.worldTransform.quaternion), dot = Math.abs(relative.reduce((n, value, i) => n + value * targetQuaternion[i], 0));
    if (2 * Math.acos(Math.max(0, Math.min(1, dot))) > .09) return { id, reason: 'existing-desk-object-orientation-not-supported' };
    if (['book', 'laptop'].includes(id) && (actual.openness ?? 1) > .05) return { id, reason: 'close-existing-object-before-partitioned-desk' };
  }
  return null;
}
