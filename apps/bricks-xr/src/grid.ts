/**
 * The grid, which is the whole of the placement rule.
 *
 * A brick fills one cell, so a cell is either taken or it is not. That lets the
 * name of a cell do double duty: the bricks are held in a map keyed by it, so
 * the key says both where a brick is and whether the space is free.
 */
import * as THREE from "three";

/** One cell across, and one brick fills it. */
export const CELL = 1;
/** The board is this many cells across, centred on the origin. */
export const SIZE = 10;
const EDGE = (SIZE * CELL) / 2;

/**
 * The centre of the cell nearest a point. Bricks sit in the middle of a cell, so
 * centres fall on halves; nothing is built below the floor, so a brick aimed
 * into it comes to rest on top.
 */
export function snapToCell(point: THREE.Vector3): THREE.Vector3 {
  const snap = (value: number) => Math.round(value / CELL - 0.5) * CELL + CELL / 2;
  return new THREE.Vector3(snap(point.x), Math.max(snap(point.y), CELL / 2), snap(point.z));
}

/** A name for the cell a point falls in. Equal names mean the same cell. */
export function cellKey(point: THREE.Vector3): string {
  const { x, y, z } = snapToCell(point);
  return `${x},${y},${z}`;
}

/** Whether a cell is on the board at all. Bricks let go outside are thrown away. */
export function onBoard(point: THREE.Vector3): boolean {
  return Math.abs(point.x) < EDGE && Math.abs(point.z) < EDGE && point.y < EDGE * 2;
}
