/**
 * The half grid, and what it takes to keep bricks on it.
 *
 * A brick's *position* is the centre of the box it fills, but what has to line
 * up when two bricks meet is their faces, not their centres. So the grid is
 * applied to the corner: the lowest corner of the box lands on a multiple of
 * half a cell, and the centre follows from the brick's own size. Every brick in
 * the catalogue has sides that are whole multiples of half a cell, so any two of
 * them placed this way sit flush — a plate on a cube, a pillar beside a block.
 */
import * as THREE from "three";

export type Size = readonly [number, number, number];

/** Half a cell: the finest step a brick can be moved by. */
export const GRID = 0.5;

/**
 * The extent of a brick's axis aligned box once it has been turned. Rotations
 * are always one of the 24 orientations of a cube, so this is a permutation of
 * the brick's own size, up to floating point noise.
 */
export function rotatedSize(size: Size, quaternion: THREE.Quaternion): THREE.Vector3 {
  const [x, y, z] = size;
  const axes = [
    new THREE.Vector3(x, 0, 0).applyQuaternion(quaternion),
    new THREE.Vector3(0, y, 0).applyQuaternion(quaternion),
    new THREE.Vector3(0, 0, z).applyQuaternion(quaternion),
  ];
  const extent = new THREE.Vector3();
  for (const axis of axes) {
    extent.x += Math.abs(axis.x);
    extent.y += Math.abs(axis.y);
    extent.z += Math.abs(axis.z);
  }
  return extent;
}

function snapAxis(value: number, extent: number): number {
  const half = extent / 2;
  return Math.round((value - half) / GRID) * GRID + half;
}

/**
 * The nearest position on the half grid for a brick of the given extent. The
 * extent is the one the brick has *after* it has been turned.
 *
 * Nothing is ever built below the floor: a brick aimed at it, or a little into
 * it, comes to rest on top of it instead of sinking half way through.
 */
export function snapToGrid(
  position: THREE.Vector3,
  extent: THREE.Vector3,
  floor = 0,
): THREE.Vector3 {
  return new THREE.Vector3(
    snapAxis(position.x, extent.x),
    Math.max(snapAxis(position.y, extent.y), floor + extent.y / 2),
    snapAxis(position.z, extent.z),
  );
}

/** The box a brick fills, given where its centre is and how big it is. */
export function brickBox(position: THREE.Vector3, extent: THREE.Vector3): THREE.Box3 {
  const half = extent.clone().multiplyScalar(0.5);
  return new THREE.Box3(position.clone().sub(half), position.clone().add(half));
}

/**
 * Whether two bricks would occupy the same space. Bricks that merely touch —
 * which is the whole point of a grid — do not overlap, so the comparison is
 * made a hair inside each box.
 */
export function boxesOverlap(a: THREE.Box3, b: THREE.Box3, tolerance = 1e-3): boolean {
  return (
    a.min.x < b.max.x - tolerance &&
    a.max.x > b.min.x + tolerance &&
    a.min.y < b.max.y - tolerance &&
    a.max.y > b.min.y + tolerance &&
    a.min.z < b.max.z - tolerance &&
    a.max.z > b.min.z + tolerance
  );
}

/**
 * How far down a brick reaches. A brick is on the ground when this is zero,
 * whatever way up it has ended.
 */
export function lowestPoint(centreY: number, extentY: number): number {
  return centreY - extentY / 2;
}
