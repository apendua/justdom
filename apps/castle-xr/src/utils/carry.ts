/**
 * Carrying something about the room with a hand, without letting it tip over.
 *
 * A hand that grabs an object and simply hands its own pose to it — which is
 * what parenting the object to the controller does — passes on the wrist's roll
 * and pitch as well as where the hand has got to. That is right for a brick,
 * which is being aimed; it is wrong for a board, which has a floor and things
 * standing on it. So a carry keeps only what a level thing can have: where it
 * is, and which way round it faces.
 *
 * The point the ray landed on when the hand closed — the grab point — is the
 * reference for everything that follows. It stays pinned to the ray, the same
 * distance out along it, and the board turns *about it* rather than about the
 * hand or its own centre. A board grabbed by its far corner is steered by that
 * corner, and the corner never slides out from under the cursor: tipping the
 * wrist moves the board where the ray now points, while the board itself stays
 * level throughout.
 */
import * as THREE from "three";
import { setWorldMatrix } from "@apendua/freedom";
import { upAxis } from "./rotations.js";

/** A pose with no tilt in it: somewhere to stand, and which way round to face. */
export interface LevelPose {
  position: THREE.Vector3;
  yaw: number;
}

/** What has to be remembered from the moment a thing was taken hold of. */
export interface Carry {
  handYaw: number;
  /** How far out along the ray the grab point was when the hand closed. */
  distance: number;
  /** From the grab point to where the carried thing stood, at that moment. */
  offset: THREE.Vector3;
  /** Which way round the carried thing faced when the hand closed on it. */
  yaw: number;
}

/**
 * How far a rotation turns about the up axis, with the tipping over left out:
 * the twist of the rotation about the vertical, which for a quaternion is
 * simply the part of it that lies along that axis.
 *
 * Asked of the direction the hand points instead, this would fall apart in the
 * one pose a board on a table is always reached for — a hand aimed at the floor
 * points nowhere in particular, and the yaw of a vertical ray is anybody's
 * guess. The twist has no such blind spot: a hand pointing straight down still
 * says which way round it is held.
 *
 * Tip a hand over about any level axis and this does not budge, which is the
 * property the carry rests on. A wrist motion that does turn about the vertical
 * — and pitching then rolling is partly that, however it feels — turns the
 * board with it, because that is a turn the player made.
 */
export function yawOf(quaternion: THREE.Quaternion): number {
  const angle = 2 * Math.atan2(quaternion.y, quaternion.w);
  // A quaternion says the same thing twice over, so that spans two turns.
  // Brought back to one, to keep the numbers something a person can read.
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Reads a matrix as the nearest level pose, dropping whatever tilt it had. */
export function levelPose(matrix: THREE.Matrix4): LevelPose {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, yaw: yawOf(quaternion) };
}

/** The hand as a pointing device: where it is, and where it is aiming. */
function rayOf(hand: THREE.Matrix4) {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  hand.decompose(position, quaternion, scale);
  // A target ray space points down its own -z; the same convention
  // three.js's Raycaster.setFromXRController casts along.
  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  return { position, quaternion, direction };
}

/**
 * Takes hold: the hand, the point its ray landed on, and where the carried
 * thing stood, all as they are at this moment.
 */
export function beginCarry(hand: THREE.Matrix4, grabPoint: THREE.Vector3, pose: LevelPose): Carry {
  const ray = rayOf(hand);
  return {
    handYaw: yawOf(ray.quaternion),
    distance: grabPoint.clone().sub(ray.position).length(),
    offset: pose.position.clone().sub(grabPoint),
    yaw: pose.yaw,
  };
}

/**
 * Where the carried thing belongs now the hand has moved on. The grab point is
 * put back on the ray, as far out as it was taken hold of, and the thing hangs
 * off it by the offset it was grabbed with — turned about the grab point as the
 * hand turns about the vertical, so a twist of the wrist pivots the board on
 * the spot the cursor is holding rather than sweeping it sideways. The wrist's
 * roll and pitch never tilt it: they only steer where the ray, and with it the
 * grab point, goes.
 */
export function carriedPose(carry: Carry, hand: THREE.Matrix4): LevelPose {
  const ray = rayOf(hand);
  const turned = yawOf(ray.quaternion) - carry.handYaw;
  const grabPoint = ray.position.clone().addScaledVector(ray.direction, carry.distance);
  const offset = carry.offset.clone().applyAxisAngle(upAxis, turned);
  return {
    position: grabPoint.add(offset),
    yaw: carry.yaw + turned,
  };
}

/**
 * Puts an object at a pose given in world coordinates, leaving its size alone —
 * the boards being carried here are scaled down to the room, and a carry has no
 * business changing how big anything is.
 */
export function applyLevelPose(object: THREE.Object3D, pose: LevelPose): void {
  object.updateWorldMatrix(true, false);
  const scale = new THREE.Vector3();
  object.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  setWorldMatrix(
    object,
    new THREE.Matrix4().compose(
      pose.position,
      new THREE.Quaternion().setFromAxisAngle(upAxis, pose.yaw),
      scale,
    ),
  );
}
