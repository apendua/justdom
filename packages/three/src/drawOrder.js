/**
 * Where what goes over everything draws: the cursor and a drag's ghost.
 * Panels draw at `elevation * ELEVATION_BAND + level`, or in paint order at
 * a layer's band plus its level (see `getRenderBand` in elevation.js), and
 * a draggable panel's strips at `HANDLE_RENDER_ORDER`, past them; this is
 * past both, with a margin for a scene that orders something of its own.
 */
export const OVERLAY_RENDER_ORDER = 1e9;

/**
 * How far past its own `renderOrder` each mesh of a panel drawn in paint
 * order draws, for the hit test (`getObjectDrawOrder`).
 *
 * @type {WeakMap<import('three').Object3D, number>}
 */
const drawnAfter = new WeakMap();

/**
 * Say that a mesh is drawn by a panel in paint order, so a ray that meets
 * it and something level with it picks the one drawn on top: such a panel
 * draws its content level, and only the order it draws in says which is on
 * top. `after` is how far past its own `renderOrder` it draws:
 * `BOX_BUCKET_BIAS` for a batched box, whose bucket draws half a level after
 * the text of its order, and 0 for anything that draws itself.
 *
 * @param {import('three').Object3D} object
 * @param {number} [after]
 * @returns {void}
 */
export function registerDrawOrder(object, after = 0) {
  drawnAfter.set(object, after);
}

/**
 * The order `object` is drawn at, if a panel in paint order draws it: its
 * `renderOrder`, and for a batched box the half level its bucket draws later.
 * Minus infinity for any other object, which every registered one is drawn
 * over where the two are level.
 *
 * @param {import('three').Object3D} object
 * @returns {number}
 */
export function getObjectDrawOrder(object) {
  const after = drawnAfter.get(object);
  return after === undefined ? -Infinity : object.renderOrder + after;
}
