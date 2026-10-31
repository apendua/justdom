import { createProperty } from "justdom-signal";

/**
 * @import {Object3D} from 'three';
 * @import * as THREE from 'three';
 */

/**
 * A panel's boxes, as the panel's one batch draws them (`paintBatch.js`).
 *
 * A box costs almost nothing to describe — a size, four radii, four border
 * widths, two colours, a clip window and perhaps a gradient — and almost
 * nothing to draw, since every one of them is the same unit quad and the
 * same distance field. What it costs is being asked for: a draw call apiece,
 * each one binding a material, uploading its uniforms and issuing its own
 * command. On a panel of a few hundred elements that submission is the
 * frame. So the description moves from uniforms to per-instance attributes,
 * and the one batch draws the boxes as instances among the panel's runs, in
 * the order the page paints them.
 *
 * This batch is what it takes them from: the boxes that have given up
 * drawing themselves, each with the numbers it is drawn from. It draws
 * nothing of its own.
 *
 * A picture is not batched. An `<img>` binds a texture, and a texture is
 * per-draw. Those boxes keep drawing themselves, which costs a call each and
 * is what an atlas would one day fix.
 *
 * Nothing else about a box changes. Its mesh stays where it was, so the ray
 * still finds it, `clipRaycast` still trims its hits and `visible` still
 * prunes it and its subtree; only `material.visible` goes false, which is the
 * one flag three consults before putting a mesh in the render list and the
 * one it does not consult when raycasting. The material stays as the thing
 * that holds the element's numbers — `div` writes them exactly as it did, and
 * the one batch reads them back out.
 */

/**
 * The batch a portal's boxes belong to. Set by `createPortal` on the context
 * it builds its elements with, so each portal batches its own and a panel
 * built without one — a test standing in for a portal — simply draws its
 * boxes one at a time.
 */
export const BoxBatchContext = createProperty(
  /**
   * @returns {BoxBatch | null}
   */
  () => null,
);

/**
 * How far behind its integer a batched box draws, so that text of the same
 * `renderOrder` draws first and the box composites over it.
 *
 * The scheme makes that collision structural rather than unlucky. An
 * element's box carries its layer's base plus its draw level from
 * elevation.js, and its text carries `getContentRenderOrder`, which is one
 * level more. That is the same integer as the box of anything nested one
 * level inside it, and the text is the one that goes first. The one batch
 * lays a box at `renderOrder + BOX_BUCKET_BIAS` (`#walk` in `paintBatch.js`),
 * and half a step keeps it strictly between its own integer and the next
 * one: text at R, boxes at R + 0.5, text at R + 1, so the levels never
 * interleave.
 *
 * A panel puts every origin level with the container's, so three cannot
 * order by distance what draws itself, and two more rungs order it.
 * Everything a panel draws within one integer level R, in the order it
 * draws, is this table. A new rung goes into it, under 1, and into the test
 * that holds the constants to it (`boxBatch.test.js`).
 *
 *   R            the level's text, and a run that draws itself
 *   [R, R + 1/2) an `<svg>`'s content, shared out by `paintSlot`
 *   R + 1/8      a field's caret, over the glyphs (`CARET_ORDER_BIAS`)
 *   R + 1/4      a picture's box, which draws itself (`UNBATCHED_BOX_BIAS`)
 *   R + 1/2      a batched box (`BOX_BUCKET_BIAS`)
 *   R + 1        the next level's text
 *
 * The `<svg>` range spans the caret's and the picture's rungs, which is
 * safe because none of the three shares an element: an `<svg>` has no
 * caret and is no `<img>`.
 *
 * A run of text whose colours are baked in draws itself at R and sorts
 * against the one batch's draw of R on its own origin, which a panel puts
 * level with the container's, so of two texts of one order that overlap
 * either may draw first.
 */
export const BOX_BUCKET_BIAS = 0.5;

/**
 * How far behind its integer a box that draws itself, an `<img>`'s, draws.
 * Its place in the level is in the table at `BOX_BUCKET_BIAS`. Its origin is
 * no help, since a panel puts it level with the container's, and which of it
 * and the text three draws first would then turn on the angle the panel is
 * seen at.
 */
export const UNBATCHED_BOX_BIAS = BOX_BUCKET_BIAS / 2;

/**
 * Write a box's numbers into the arrays of an instance, as the one batch's
 * shader wants them (`vertexShader` in `paintBatch.js`).
 *
 * @param {Record<string, Float32Array>} data
 * @param {number} index
 * @param {Record<string, THREE.IUniform>} uniforms The box's numbers.
 * @returns {void}
 */
export function writeBoxInstance(data, index, uniforms) {
  const { uSize, uRadii, uBorder, uFillColor, uBorderColor, uClip, uClipRadii } = uniforms;
  const { uGradient, uGradientGeometry, uGradientTile, uGradientRamp } = uniforms;
  const gradient = uGradient.value;
  const ramp = uGradientRamp.value;
  const size = data.aSize;
  size[index * 4] = uSize.value.x;
  size[index * 4 + 1] = uSize.value.y;
  // Unpacked by the vertex shader; see `vertexShader` in `paintBatch.js`.
  size[index * 4 + 2] =
    gradient.x + 4 * gradient.y + 8 * gradient.z + 16 * gradient.w + 32 * ramp.x;
  // The opacity.
  size[index * 4 + 3] = ramp.y;
  writeVec4(data.aGradientGeometry, index, uGradientGeometry.value);
  writeVec4(data.aGradientTile, index, uGradientTile.value);
  writeVec4(data.aRadii, index, uRadii.value);
  writeVec4(data.aBorder, index, uBorder.value);
  writeVec4(data.aFillColor, index, uFillColor.value);
  writeVec4(data.aBorderColor, index, uBorderColor.value);
  writeVec4(data.aClip, index, uClip.value);
  writeVec4(data.aClipRadii, index, uClipRadii.value);
}

/**
 * @param {Float32Array} array
 * @param {number} index
 * @param {THREE.Vector4} value
 * @returns {void}
 */
function writeVec4(array, index, value) {
  const at = index * 4;
  array[at] = value.x;
  array[at + 1] = value.y;
  array[at + 2] = value.z;
  array[at + 3] = value.w;
}

export class BoxBatch {
  /**
   * The meshes that have given up drawing themselves, and are drawn by the
   * one batch instead.
   *
   * Each box against the numbers it is drawn from, which a batched box keeps
   * to itself rather than on the material it shares with every other one.
   *
   * @type {Map<THREE.Mesh, Record<string, THREE.IUniform>>}
   */
  #members = new Map();

  /**
   * What draws the boxes, with the panel's runs.
   *
   * @type {import('./paintBatch.js').PaintBatch}
   */
  #draw;

  /**
   * The boxes the last walk took, so that a box leaving the batch asks for a
   * rebuild only when the one batch draws it. A box out of the walk is drawn
   * by nothing: the rows that left an open panel wait out of it for their
   * teardowns (`portalTeardown.js`), and each of those removals would
   * otherwise rebuild the batch to find what it already holds.
   *
   * @type {Set<THREE.Mesh>}
   */
  #drawn = new Set();

  /**
   * @param {import('./paintBatch.js').PaintBatch} draw What draws the boxes.
   */
  constructor(draw) {
    this.#draw = draw;
  }

  /**
   * A walk of the panel starts, which takes the boxes it meets (`take`).
   *
   * @returns {void}
   */
  beginWalk() {
    this.#drawn.clear();
  }

  /**
   * If `mesh` is a box this batch has taken in, mark it drawn by the walk
   * under way and hand back the numbers it is drawn from; null for any
   * other mesh.
   *
   * @param {THREE.Mesh} mesh
   * @returns {Record<string, THREE.IUniform> | null}
   */
  take(mesh) {
    const uniforms = this.#members.get(mesh);
    if (!uniforms) {
      return null;
    }
    this.#drawn.add(mesh);
    return uniforms;
  }

  /**
   * Take this box into the batch: it stops drawing itself, and the one batch
   * starts drawing it. Idempotent.
   *
   * @param {THREE.Mesh} mesh
   * @param {Record<string, THREE.IUniform>} uniforms The numbers to draw it
   *   from. Handed in rather than read off `mesh.material`, because a batched
   *   box shares one invisible material with every other batched box on the
   *   page and keeps its numbers to itself.
   * @returns {void}
   */
  add(mesh, uniforms) {
    if (this.#members.has(mesh)) {
      return;
    }
    this.#members.set(mesh, uniforms);
    // Nothing to flip: a batched box wears `batchedBoxMaterial`, which is
    // invisible and shared, so it is already out of the render list without
    // being out of anything else — the ray still finds it, and `visible` still
    // means what it meant. This used to set the flag per mesh, which a shared
    // material cannot have: clearing it on one box's teardown would put every
    // other box on the page back into the draw.
    // A mesh that will not be drawn has no business being tested against the
    // frustum for it. Three asks that question — a bounding-sphere transform
    // per mesh per frame — before it looks at whether the material is visible,
    // so this is the difference between a box that is not drawn and a box that
    // costs nothing. It is safe by the same token: nothing consults the answer.
    // (What remains is three's per-mesh geometry bookkeeping, which only
    // dropping the mesh from the render traversal altogether would avoid.)
    mesh.frustumCulled = false;
    this.invalidate();
  }

  /**
   * @param {THREE.Mesh} mesh
   * @returns {void}
   */
  remove(mesh) {
    if (!this.#members.delete(mesh)) {
      return;
    }
    // No visibility to restore: the material was never this mesh's to hide.
    mesh.frustumCulled = true;
    if (this.#drawn.delete(mesh)) {
      this.invalidate();
    }
  }

  /**
   * Something about the panel that the batch has copied down has changed: a
   * box moved, was restyled, scrolled, appeared or went away. The one batch
   * coalesces it with everything else the panel changed (`invalidate` in
   * `paintBatch.js`).
   *
   * @returns {void}
   */
  invalidate() {
    this.#draw.invalidate();
  }

  /**
   * @returns {void}
   */
  dispose() {
    this.#members.clear();
    this.#drawn.clear();
  }
}
