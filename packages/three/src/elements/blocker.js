import * as THREE from "three";

/**
 * @import {XREventMap} from '../core.js';
 */

/**
 * Blockers differ from one another only by transform, and neither a unit plane
 * nor a material that writes nothing carries per-instance state — so both are
 * made once and shared, and there is nothing to dispose when a portal or an
 * overlay goes away.
 */
const geometry = new THREE.PlaneGeometry(1, 1);

const material = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
});

/**
 * A plane that draws nothing and stops rays.
 *
 * Only elements that ask to be clickable are ray targets, which leaves gaps —
 * the space between two buttons, the padding around a menu — that a ray would
 * otherwise pass straight through, landing on whatever sits behind. Behind a
 * panel that is the scene; behind a dropdown it is the panel's own buttons,
 * a couple of millimetres further away and perfectly clickable. A blocker
 * spanning the surface makes it opaque, and doubles as the single "background"
 * hit target instead of one per box.
 *
 * @returns {THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial, XREventMap>}
 */
export function createBlocker() {
  return new THREE.Mesh(geometry, material);
}

/**
 * Stretch a blocker over a box given in the CSS convention its parent object
 * uses: origin at the top left corner, y running down, sizes in local px.
 *
 * @param {THREE.Object3D} blocker
 * @param {number} width
 * @param {number} height
 * @param {number} z How far behind the box's own content to sit.
 * @returns {void}
 */
export function coverBox(blocker, width, height, z) {
  blocker.position.set(width / 2, height / 2, z);
  // A plane scaled to nothing has no surface to hit, and a zero scale is not
  // invertible; either way an empty box is better described as very small.
  blocker.scale.set(Math.max(width, 1e-6), Math.max(height, 1e-6), 1);
}
