import * as THREE from "three";
import { placeAndScale } from "./place.js";
import { keepProgram } from "./programKeeper.js";

/**
 * @import {XREventMap} from '../core.js';
 * @import {ProgramKind} from './programKeeper.js';
 */

/**
 * Blockers differ from one another only by transform, and neither a unit plane
 * nor a material that writes nothing carries per-instance state — so both are
 * made once and shared, and there is nothing to dispose when a portal or an
 * overlay goes away. A depth quad (`createDepthQuad` below) shares the plane
 * but not the material: each has its own, which the portal disposes.
 */
const geometry = new THREE.PlaneGeometry(1, 1);

const material = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
  // Out of the draw altogether. A plane that writes neither colour nor depth
  // changes no pixel, so drawing it was a draw call per blocker per eye for
  // nothing. Three leaves a mesh out of its render list when its material is
  // not visible, and a ray still meets it, since the hit test reads the
  // mesh's own `visible` (`intersectVisible`); a batched box is kept out of
  // the draw the same way (`batchedBoxMaterial`).
  visible: false,
  // Two-sided, and not as a nicety. A portal flips its container half a turn
  // about x to put the CSS y axis the right way round, which turns every
  // plane in it away from the viewer — and a one-sided mesh is not raycast
  // from behind, so a blocker facing backwards stops nothing at all. The
  // boxes themselves are two-sided for the same reason.
  side: THREE.DoubleSide,
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

/** @returns {THREE.MeshBasicMaterial} */
function depthQuadMaterial() {
  return new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    // In the transparent list, which three draws after the opaque one, so
    // that `renderOrder` can put it after the panel's content: every panel
    // material is transparent.
    transparent: true,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
}

/** @type {ProgramKind<THREE.MeshBasicMaterial>} */
const DEPTH_QUAD_PROGRAM = { name: "freedom-depth-quad", create: depthQuadMaterial };

/**
 * A plane that draws no colour and writes depth: what a panel hides what is
 * drawn after it with, since nothing else in it writes depth. Stretched over
 * the root by `coverBox`, and no ray target.
 *
 * Each panel's quad has a material of its own, which the panel disposes. A
 * shared one is one that code changing a material it finds under its own
 * panel changes for every panel: the frame meter's readout turning its
 * depth test off turned off every panel's, and the panels stopped hiding
 * what passes behind them. Its program outlives it (`programKeeper.js`), as
 * a box's does.
 *
 * @returns {THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>}
 */
export function createDepthQuad() {
  return new THREE.Mesh(geometry, keepProgram(depthQuadMaterial(), DEPTH_QUAD_PROGRAM));
}

/**
 * Whether an object is a blocker, a panel's background or an overlay's.
 *
 * @param {THREE.Object3D} object
 * @returns {boolean}
 */
export function isBlocker(object) {
  return object instanceof THREE.Mesh && object.material === material;
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
  // A plane scaled to nothing has no surface to hit, and a zero scale is not
  // invertible; either way an empty box is better described as very small.
  placeAndScale(
    blocker,
    width / 2,
    height / 2,
    z,
    Math.max(width, 1e-6),
    Math.max(height, 1e-6),
    1,
  );
}
