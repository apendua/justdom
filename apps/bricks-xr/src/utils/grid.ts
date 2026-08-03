/**
 * The grid, which in this game is the whole of the placement rule.
 *
 * A brick is a unit cube and lives in one cell, so a cell is either empty or it
 * is not. That makes the key of a cell — the string here — do double duty: it is
 * both where a brick is and whether the space is taken, which is why the bricks
 * are held in a map keyed by it rather than in a list.
 */
import * as THREE from "three";

/** One cell across, and one brick fills it. */
export const CELL = 1;

/**
 * The centre of the cell nearest a point. Bricks sit in the middle of a cell, so
 * the centres fall on halves; nothing is ever placed below the floor, so a brick
 * aimed into it comes to rest on top of it.
 */
export function snapToCell(position: THREE.Vector3): THREE.Vector3 {
  const snap = (value: number) => Math.round(value / CELL - 0.5) * CELL + CELL / 2;
  return new THREE.Vector3(
    snap(position.x),
    Math.max(snap(position.y), CELL / 2),
    snap(position.z),
  );
}

/** A name for the cell a point falls in. Equal names mean the same cell. */
export function cellKey(position: THREE.Vector3): string {
  const centre = snapToCell(position);
  return `${centre.x},${centre.y},${centre.z}`;
}
