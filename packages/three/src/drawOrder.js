/**
 * Where what goes over everything draws: the cursor and a drag's ghost.
 * Panels draw at a layer's base plus its level (see `getRenderBand` in
 * elevation.js), and a draggable panel's strips at `HANDLE_RENDER_ORDER`,
 * past them; this is past both, with a margin for a scene that orders
 * something of its own.
 */
export const OVERLAY_RENDER_ORDER = 1e9;

/**
 * How far past its own `renderOrder` each mesh of a panel draws, for the hit
 * test (`getObjectDrawOrder`).
 *
 * @type {WeakMap<import('three').Object3D, number>}
 */
const drawnAfter = new WeakMap();

/**
 * Say that a mesh is drawn by a panel, so a ray that meets it and something
 * level with it picks the one drawn on top: a panel draws its content level,
 * and only the order it draws in says which is on top. `after` is how far past
 * its own `renderOrder` it draws: `BOX_BUCKET_BIAS` for a batched box, which
 * the panel's one batch lays at `renderOrder + BOX_BUCKET_BIAS`, half a level
 * after the text of its order, and 0 for anything that draws itself.
 *
 * @param {import('three').Object3D} object
 * @param {number} [after]
 * @returns {void}
 */
export function registerDrawOrder(object, after = 0) {
  drawnAfter.set(object, after);
}

/**
 * The order `object` is drawn at, if a panel draws it: its
 * `renderOrder`, and for a batched box the half level the batch lays it later.
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

/**
 * Each element's box mesh, while it has one mounted.
 *
 * @type {WeakMap<Element, import('three').Object3D>}
 */
const boxes = new WeakMap();

/**
 * Say which mesh draws an element's box, or that none does any more, so
 * the scan that hit-tests elements (`hitElement` in
 * `elements/input/dragAndDrop.js`) orders the element by the number the
 * cast compares for that mesh.
 *
 * @param {Element} element
 * @param {import('three').Object3D | null} mesh
 * @returns {void}
 */
export function setBoxMesh(element, mesh) {
  if (mesh) {
    boxes.set(element, mesh);
  } else {
    boxes.delete(element);
  }
}

/**
 * The order an element's box is drawn at, as the cast reads it for the box's
 * mesh (`getObjectDrawOrder`), or `undefined` while no box mesh is mounted.
 *
 * @param {Element} element
 * @returns {number | undefined}
 */
export function getBoxDrawOrder(element) {
  const mesh = boxes.get(element);
  return mesh ? getObjectDrawOrder(mesh) : undefined;
}
