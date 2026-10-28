import * as THREE from "three";

/*
 * What the panel's batches share about drawing instances: the matrices a
 * walk of the panel accumulates down the tree with, how a bucket, a text
 * array or a draw grows, and how its mesh goes (`boxBatch.js`,
 * `textBatch.js`, `paintBatch.js`).
 */

/**
 * Matrices to accumulate down the tree with, one per level, grown as the tree
 * turns out to be deep. A rebuild is the hottest thing here and allocating a
 * matrix per node would be most of it. One stack for every batch: a walk
 * runs to its end before the next starts.
 *
 * @type {THREE.Matrix4[]}
 */
const matrixStack = [new THREE.Matrix4()];

/**
 * @param {number} depth
 * @returns {THREE.Matrix4}
 */
export function stackAt(depth) {
  while (matrixStack.length <= depth) {
    matrixStack.push(new THREE.Matrix4());
  }
  return matrixStack[depth];
}

/**
 * The capacity a bucket, a text array or a draw grows to for `needed`
 * instances or layers: double what it had, from `minimum`, until they fit.
 *
 * @param {number} capacity What it has now, 0 for none.
 * @param {number} needed
 * @param {number} minimum
 * @returns {number}
 */
export function grownCapacity(capacity, needed, minimum) {
  let grown = Math.max(minimum, capacity);
  while (grown < needed) {
    grown *= 2;
  }
  return grown;
}

/**
 * Take an instanced mesh out of the panel and free what it holds on the
 * device, but not its material, which a bucket that grows keeps.
 *
 * An instanced mesh has one buffer that its geometry does not own.
 * `instanceMatrix` is not a geometry attribute — the renderer uploads it
 * separately and frees it only when the mesh says it is going, which is
 * what `dispose` on the mesh dispatches. Without it the buffer is left
 * allocated on the device with nothing referring to it: the renderer's own
 * record of it is weakly keyed, so collecting the attribute drops the key
 * and the `deleteBuffer` that would have followed it. That is once per
 * growth — a bucket is rebuilt at double capacity every time it fills — and
 * once more per panel closed.
 *
 * @param {THREE.InstancedMesh} mesh
 * @returns {void}
 */
export function disposeInstancedMesh(mesh) {
  mesh.removeFromParent();
  mesh.geometry.dispose();
  mesh.dispose();
}
