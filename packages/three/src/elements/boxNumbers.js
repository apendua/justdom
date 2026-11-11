import { placeAndScale } from "./place.js";
import {
  createRectUniforms,
  writeClipUniforms,
  writeGradientUniforms,
  writeImageUniforms,
  writeRectUniforms,
} from "./paint/sdfRect.js";

/**
 * @import * as THREE from 'three';
 * @import VisualProperties from './VisualProperties.js';
 * @import {ContentImage} from './controls/image.js';
 * @import {RampSlot} from './paint/gradient.js';
 * @import {ClipBox} from './clip.js';
 * @import {BoxBatch} from './paint/boxBatch.js';
 */

/**
 * The one writer of what the panel's batch copies out of a box's quad: its
 * uniforms, and the size, order and visibility of its mesh. Each write
 * compares before it writes, and tells the batch only when it changed
 * anything, so a box cannot change what the batch draws without telling it,
 * and an effect that runs again with the same values tells it nothing.
 *
 * Which kind of change it tells the batch is decided here
 * (`paintBatch.js`'s header): a change to the numbers alone is `changed`,
 * which writes the box's instances again where they are, and a change to
 * the mesh's place, order or visibility is `invalidate`, a rebuild. Both go
 * to the panel's batch, even for a box that draws itself: the batch's walk
 * still reads its visibility and its order, and `changed` passes over a
 * mesh the batch does not draw.
 *
 * What it does not cover is written elsewhere and told the batch there: the
 * matrix of the box's object, which the motion step and the place effect in
 * `div.js` write, and the visibility of that object.
 */
export class BoxNumbers {
  /**
   * The numbers a shader wants, which the batch copies into its instance
   * buffers and a box that draws itself binds to its own material
   * (`createRectUniforms`). Written only through the methods below.
   *
   * @readonly
   */
  uniforms = createRectUniforms();

  /** @type {THREE.Mesh} */
  #mesh;

  /** @type {BoxBatch | null} */
  #batch;

  /**
   * @param {THREE.Mesh} mesh The quad the numbers are drawn on.
   * @param {BoxBatch | null} batch The panel's, whether or not it draws the
   *   quad now; none outside a panel drawn in paint order.
   */
  constructor(mesh, batch) {
    this.#mesh = mesh;
    this.#batch = batch;
  }

  /** The numbers changed, and nothing else. */
  #changed() {
    this.#batch?.changed(this.#mesh);
  }

  /** The mesh's place, order or visibility changed. */
  #moved() {
    this.#batch?.invalidate();
  }

  /**
   * The box's own paint: its size, corners, border, colours, outline,
   * shadows and gradient (`writeRectUniforms`, `writeGradientUniforms`).
   *
   * @param {VisualProperties} properties
   * @param {RampSlot} slot
   */
  paint(properties, slot) {
    const rect = writeRectUniforms(this.uniforms, properties);
    if (writeGradientUniforms(this.uniforms, properties, slot) || rect) {
      this.#changed();
    }
  }

  /**
   * @param {ClipBox} box
   */
  clip(box) {
    if (writeClipUniforms(this.uniforms, box)) {
      this.#changed();
    }
  }

  /**
   * @param {ContentImage | null} image
   */
  image(image) {
    if (writeImageUniforms(this.uniforms, image)) {
      this.#changed();
    }
  }

  /**
   * Where the quad stands in its object and how big it is. A quad scaled to
   * nothing has no surface to draw or hit, and a zero scale is not
   * invertible, so an empty box is drawn very small instead, as the blocker
   * is.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   */
  place(x, y, width, height) {
    const mesh = this.#mesh;
    const scaleX = Math.max(width, 1e-6);
    const scaleY = Math.max(height, 1e-6);
    const { position, scale } = mesh;
    if (
      !mesh.matrixAutoUpdate &&
      position.x === x &&
      position.y === y &&
      scale.x === scaleX &&
      scale.y === scaleY
    ) {
      return;
    }
    placeAndScale(mesh, x, y, 0, scaleX, scaleY, 1);
    this.#moved();
  }

  /**
   * @param {number} order
   */
  order(order) {
    if (this.#mesh.renderOrder !== order) {
      this.#mesh.renderOrder = order;
      this.#moved();
    }
  }

  /**
   * Whether the quad is drawn. The draw, the batch's walk and the raycast
   * all follow this flag.
   *
   * @param {boolean} visible
   */
  show(visible) {
    if (this.#mesh.visible !== visible) {
      this.#mesh.visible = visible;
      this.#moved();
    }
  }
}
