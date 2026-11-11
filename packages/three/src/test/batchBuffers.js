/**
 * What a panel's paint batch draws, read back for a test: its meshes, its
 * draws in order, and every buffer of them, for comparing a patch with what
 * a rebuild writes. And a watch on what the batch is told.
 */
import * as THREE from "three";
import { isProxy } from "../elements/paint/layerOrder.js";
import { PaintBatch } from "../elements/paint/paintBatch.js";

/**
 * Every mesh the panel draws: visible, with a material that draws, and with
 * instances to draw if it is instanced.
 *
 * @param {THREE.Object3D} panel
 * @returns {THREE.Mesh[]}
 */
export function drawn(panel) {
  /** @type {THREE.Mesh[]} */
  const meshes = [];
  panel.traverseVisible((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }
    const material = /** @type {THREE.Material} */ (object.material);
    if (!material.visible) {
      return;
    }
    if (object instanceof THREE.InstancedMesh && object.count === 0) {
      return;
    }
    meshes.push(object);
  });
  return meshes;
}

/**
 * The panel's draws of boxes and runs (`paintBatch.js`), in the order they
 * draw.
 *
 * @param {THREE.Object3D} panel
 * @returns {THREE.InstancedMesh[]}
 */
export function draws(panel) {
  return drawn(panel)
    .filter((mesh) => mesh instanceof THREE.InstancedMesh && !isProxy(mesh))
    .map((mesh) => /** @type {THREE.InstancedMesh} */ (mesh))
    .sort((a, b) => a.renderOrder - b.renderOrder);
}

/**
 * Every buffer of every draw the panel has, over the instances each draws.
 *
 * @param {THREE.Object3D} panel
 * @returns {number[][]}
 */
export function buffers(panel) {
  return draws(panel).flatMap((draw) => [
    Array.from(draw.instanceMatrix.array.subarray(0, draw.count * 16)),
    ...Object.values(draw.geometry.attributes)
      .filter((attribute) => attribute instanceof THREE.InstancedBufferAttribute)
      .map((attribute) =>
        Array.from(
          /** @type {Float32Array} */ (attribute.array).subarray(
            0,
            draw.count * attribute.itemSize,
          ),
        ),
      ),
  ]);
}

/**
 * Count what the panel's batch is told, and keep the batch, until
 * `restore`.
 */
export function watchBatch() {
  const { invalidate, changed } = PaintBatch.prototype;
  const watched = {
    invalidate: 0,
    changed: 0,
    /** @type {PaintBatch | null} */
    batch: null,
    restore() {
      PaintBatch.prototype.invalidate = invalidate;
      PaintBatch.prototype.changed = changed;
    },
  };
  PaintBatch.prototype.invalidate = function () {
    watched.invalidate += 1;
    watched.batch = this;
    return invalidate.call(this);
  };
  PaintBatch.prototype.changed = function (mesh) {
    watched.changed += 1;
    watched.batch = this;
    return changed.call(this, mesh);
  };
  return watched;
}
