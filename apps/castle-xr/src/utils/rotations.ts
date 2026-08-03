import { maxBy, minBy } from "lodash";
import * as THREE from "three";

export const QUARTER_TURN = Math.PI / 2;

const rotations: THREE.Matrix3[] = [
  new THREE.Matrix3(1, 0, 0, 0, 1, 0, 0, 0, 1),
  new THREE.Matrix3(1, 0, 0, 0, -1, 0, 0, 0, -1),
  new THREE.Matrix3(-1, 0, 0, 0, -1, 0, 0, 0, 1),
  new THREE.Matrix3(-1, 0, 0, 0, 1, 0, 0, 0, -1),

  new THREE.Matrix3(1, 0, 0, 0, 0, -1, 0, 1, 0),
  new THREE.Matrix3(1, 0, 0, 0, 0, 1, 0, -1, 0),
  new THREE.Matrix3(-1, 0, 0, 0, 0, 1, 0, 1, 0),

  new THREE.Matrix3(0, -1, 0, 1, 0, 0, 0, 0, 1),
  new THREE.Matrix3(0, 1, 0, -1, 0, 0, 0, 0, 1),
  new THREE.Matrix3(0, 1, 0, 1, 0, 0, 0, 0, -1),

  new THREE.Matrix3(0, 1, 0, 0, 0, 1, 1, 0, 0),
  new THREE.Matrix3(0, -1, 0, 0, 0, -1, 1, 0, 0),
  new THREE.Matrix3(0, 1, 0, 0, 0, -1, -1, 0, 0),
  new THREE.Matrix3(0, -1, 0, 0, 0, 1, -1, 0, 0),

  new THREE.Matrix3(0, 0, 1, 1, 0, 0, 0, 1, 0),
  new THREE.Matrix3(0, 0, -1, -1, 0, 0, 0, 1, 0),
  new THREE.Matrix3(0, 0, 1, -1, 0, 0, 0, -1, 0),
  new THREE.Matrix3(0, 0, -1, 1, 0, 0, 0, -1, 0),

  new THREE.Matrix3(0, 0, -1, 0, 1, 0, 1, 0, 0),
  new THREE.Matrix3(0, 0, 1, 0, -1, 0, 1, 0, 0),
  new THREE.Matrix3(0, 0, 1, 0, 1, 0, -1, 0, 0),

  new THREE.Matrix3(0, -1, 0, -1, 0, 0, 0, 0, -1),
  new THREE.Matrix3(-1, 0, 0, 0, 0, -1, 0, -1, 0),
  new THREE.Matrix3(0, 0, -1, 0, -1, 0, -1, 0, 0),
];

export const quaternions = rotations.map((m) =>
  new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().setFromMatrix3(m)),
);

function distance(a: THREE.Quaternion, b: THREE.Quaternion) {
  const dot = a.dot(b);
  return 1 - dot * dot;
}

export function align(quaternion: THREE.Quaternion): THREE.Quaternion {
  const bestMatch = minBy(quaternions, (q) => distance(q, quaternion));
  if (bestMatch) {
    return new THREE.Quaternion().copy(bestMatch);
  }
  return new THREE.Quaternion();
}

export const upAxis = new THREE.Vector3(0, 1, 0);

/** The four orientations that leave a brick standing the right way up. */
export const uprightQuaternions = quaternions.filter(
  (q) => upAxis.clone().applyQuaternion(q).y > 0.99,
);

/**
 * The nearest orientation that keeps the brick upright. Reaching across a
 * board rolls the wrist further than it feels like it does, and picking from
 * all twenty four orientations turns that into bricks landing upside down.
 * Turning a brick over stays possible — it just has to be asked for, with the
 * thumbstick, rather than happening by itself.
 */
export function alignUpright(quaternion: THREE.Quaternion): THREE.Quaternion {
  const bestMatch = minBy(uprightQuaternions, (q) => distance(q, quaternion));
  if (bestMatch) {
    return new THREE.Quaternion().copy(bestMatch);
  }
  return new THREE.Quaternion();
}

const horizontalAxes = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];

/**
 * The grid axis pointing most closely in the given direction. Used to turn
 * "where the player is looking from" into an axis a brick can be tumbled
 * around, so that pushing the thumbstick forward always tips the brick away
 * from the player, no matter which side of the board they are standing on.
 */
export function snapToHorizontalAxis(direction: THREE.Vector3): THREE.Vector3 {
  const bestMatch = maxBy(horizontalAxes, (axis) => axis.dot(direction));
  return new THREE.Vector3().copy(bestMatch ?? horizontalAxes[0]);
}

/**
 * Rotate around an axis of the board, keeping the result on the grid. Both the
 * input and the output are expected to be one of the 24 aligned orientations,
 * which is what re-aligning the product guarantees.
 */
export function turn(
  quaternion: THREE.Quaternion,
  axis: THREE.Vector3,
  angle: number,
): THREE.Quaternion {
  return align(new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(quaternion));
}
