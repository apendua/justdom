import { placeAndScale } from "./place.js";
import {
  createRectUniforms,
  writeClipUniforms,
  writeGradientUniforms,
  writeImageUniforms,
  writeRectUniforms,
} from "./sdfRect.js";

/**
 * @import * as THREE from 'three';
 * @import VisualProperties from './VisualProperties.js';
 * @import {ContentImage} from './image.js';
 * @import {RampSlot} from './gradient.js';
 * @import {ClipBox} from './clip.js';
 */

/**
 * The one writer of what the panel's batch copies out of a box's quad: its
 * uniforms, and the size, order and visibility of its mesh. Each write
 * compares before it writes, and calls `mark` when it changed anything, so a
 * box cannot change what the batch draws without telling it, and an effect
 * that runs again with the same values tells it nothing.
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

  /** @type {() => void} */
  #mark;

  /**
   * @param {THREE.Mesh} mesh The quad the numbers are drawn on.
   * @param {() => void} mark Tells whatever copies the numbers that they
   *   changed.
   */
  constructor(mesh, mark) {
    this.#mesh = mesh;
    this.#mark = mark;
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
      this.#mark();
    }
  }

  /**
   * @param {ClipBox} box
   */
  clip(box) {
    if (writeClipUniforms(this.uniforms, box)) {
      this.#mark();
    }
  }

  /**
   * @param {ContentImage | null} image
   */
  image(image) {
    if (writeImageUniforms(this.uniforms, image)) {
      this.#mark();
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
      position.z === 0 &&
      scale.x === scaleX &&
      scale.y === scaleY &&
      scale.z === 1
    ) {
      return;
    }
    placeAndScale(mesh, x, y, 0, scaleX, scaleY, 1);
    this.#mark();
  }

  /**
   * @param {number} order
   */
  order(order) {
    if (this.#mesh.renderOrder !== order) {
      this.#mesh.renderOrder = order;
      this.#mark();
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
      this.#mark();
    }
  }
}
