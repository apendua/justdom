import * as THREE from "three";

/**
 * @import {LevelPose} from '../carry.js';
 */

/**
 * Where the keyboard opens when nothing says otherwise: in front of the
 * player, where they are looking when they press a field, rather than
 * wherever the field's panel happens to be. A panel may be tall, or far
 * off, or behind a shoulder by the time its field is pressed; the hands are
 * always where they are.
 *
 * Only the heading is taken from the head, level: a player looking down at
 * a table gets the board in front of them, not under their feet, and a
 * tilt of the head does not tip the board. Once placed it stays where it
 * is in the room — a board that swam with the head would be a board the
 * hand could never catch up with.
 */

/**
 * How far ahead of the eyes the board's top edge is put, in metres: an
 * arm's length, bent, where a phone is held to type on.
 */
export const DEFAULT_REACH = 0.45;

/**
 * How far below the eyes, in metres. The top edge; the board hangs below
 * it, reclined, so its keys are lower still.
 */
export const DEFAULT_DROP = 0.2;

/**
 * Metres per CSS px of the board: a millimetre, which is what the scenes
 * in this repository give their panels, so a board written for a panel is
 * the size its author saw.
 */
export const DEFAULT_KEYBOARD_SCALE = 0.001;

const _eye = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _ahead = new THREE.Vector3();

/**
 * The pose the board opens at, given where the head is.
 *
 * The heading is the direction the head faces with the up and down taken
 * out. Looking straight up or down leaves no heading to take, and then the
 * board goes in front of the room's own forward, -z, which is the one
 * direction a scene is built facing.
 *
 * @param {THREE.Matrix4} head The camera's world matrix.
 * @param {{ reach?: number, drop?: number }} [options]
 * @returns {LevelPose} Where the board's top edge goes, and the yaw that
 *   turns its face, +z, toward the head.
 */
export function viewerPose(head, { reach = DEFAULT_REACH, drop = DEFAULT_DROP } = {}) {
  head.decompose(_eye, _quaternion, _scale);
  _ahead.set(0, 0, -1).applyQuaternion(_quaternion);
  _ahead.y = 0;
  if (_ahead.lengthSq() < 1e-6) {
    _ahead.set(0, 0, -1);
  }
  _ahead.normalize();
  const position = _eye.clone().addScaledVector(_ahead, reach);
  position.y -= drop;
  return { position, yaw: Math.atan2(-_ahead.x, -_ahead.z) };
}

/**
 * How far the player may have walked, in metres, and turned, in radians,
 * since they put the board somewhere, for it to open there again. Further
 * than that and where they put it is somewhere they have left: the board
 * opens in front of them instead.
 */
export const REUSE_DISTANCE = 1;
export const REUSE_TURN = Math.PI / 3;

/**
 * Whether a board the player put down, with their head where it was then,
 * should open there again with their head where it is now.
 *
 * @param {LevelPose} then The head when the board was put down.
 * @param {LevelPose} now The head now.
 * @returns {boolean}
 */
export function shouldReuse(then, now) {
  if (then.position.distanceTo(now.position) > REUSE_DISTANCE) {
    return false;
  }
  const turn = now.yaw - then.yaw;
  return Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) <= REUSE_TURN;
}
