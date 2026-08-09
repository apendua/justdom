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
 * The offset from hand to object is kept, and turned with the hand, so the
 * board swings around the hand rather than snapping to it — a board grabbed by
 * its far edge stays gripped by its far edge.
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
  handPosition: THREE.Vector3;
  handYaw: number;
  /** Where the carried thing was when the hand closed on it. */
  pose: LevelPose;
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

/** Takes hold: the hand and the thing carried, as they are at this moment. */
export function beginCarry(hand: THREE.Matrix4, pose: LevelPose): Carry {
  const held = levelPose(hand);
  return {
    handPosition: held.position,
    handYaw: held.yaw,
    pose: { position: pose.position.clone(), yaw: pose.yaw },
  };
}

/**
 * Where the carried thing belongs now the hand has moved on. It travels with
 * the hand and turns with it about the up axis; the wrist's roll and pitch are
 * dropped, which is what keeps the board level however it is being reached for.
 */
export function carriedPose(carry: Carry, hand: THREE.Matrix4): LevelPose {
  const held = levelPose(hand);
  const turned = held.yaw - carry.handYaw;
  const offset = carry.pose.position.clone().sub(carry.handPosition).applyAxisAngle(upAxis, turned);
  return {
    position: held.position.add(offset),
    yaw: carry.pose.yaw + turned,
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
