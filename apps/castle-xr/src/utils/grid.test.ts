import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { boxesOverlap, brickBox, GRID, rotatedSize, snapToGrid } from "./grid.js";
import { quaternions } from "./rotations.js";
import { allBrickTypes, brickShape } from "../components/types.js";

const QUARTER = Math.PI / 2;

function onHalfGrid(value: number): boolean {
  return Math.abs(value / GRID - Math.round(value / GRID)) < 1e-6;
}

describe("rotatedSize", () => {
  it("leaves an unrotated brick alone", () => {
    const extent = rotatedSize([2, 1, 0.5], new THREE.Quaternion());
    expect(extent.x).toBeCloseTo(2);
    expect(extent.y).toBeCloseTo(1);
    expect(extent.z).toBeCloseTo(0.5);
  });

  it("swaps the axes a quarter turn exchanges", () => {
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), QUARTER);
    const extent = rotatedSize([2, 1, 0.5], yaw);
    expect(extent.x).toBeCloseTo(0.5);
    expect(extent.y).toBeCloseTo(1);
    expect(extent.z).toBeCloseTo(2);
  });

  it("is a permutation of the brick's own sides for every grid orientation", () => {
    for (const type of allBrickTypes) {
      const { size } = brickShape(type);
      for (const quaternion of quaternions) {
        const extent = rotatedSize(size, quaternion);
        expect([extent.x, extent.y, extent.z].map((v) => Math.round(v * 100) / 100).sort()).toEqual(
          [...size].sort(),
        );
      }
    }
  });
});

describe("snapToGrid", () => {
  it("puts the faces of every brick on the half grid", () => {
    for (const type of allBrickTypes) {
      const { size } = brickShape(type);
      for (const quaternion of quaternions) {
        const extent = rotatedSize(size, quaternion);
        const position = snapToGrid(new THREE.Vector3(0.37, 1.11, -2.84), extent);
        const box = brickBox(position, extent);
        for (const corner of [box.min, box.max]) {
          expect(onHalfGrid(corner.x)).toBe(true);
          expect(onHalfGrid(corner.y)).toBe(true);
          expect(onHalfGrid(corner.z)).toBe(true);
        }
      }
    }
  });

  it("does not move a brick that is already on the grid", () => {
    const extent = new THREE.Vector3(2, 0.5, 1);
    const once = snapToGrid(new THREE.Vector3(0.4, 1.2, -1.4), extent);
    const twice = snapToGrid(once, extent);
    expect(twice.toArray()).toEqual(once.toArray());
  });

  it("never lets a brick sink into the floor", () => {
    for (const type of allBrickTypes) {
      const extent = rotatedSize(brickShape(type).size, new THREE.Quaternion());
      const position = snapToGrid(new THREE.Vector3(0, -3, 0), extent);
      expect(brickBox(position, extent).min.y).toBeCloseTo(0);
    }
  });

  it("lets a brick rest exactly on the ground", () => {
    for (const type of allBrickTypes) {
      const extent = rotatedSize(brickShape(type).size, new THREE.Quaternion());
      const position = snapToGrid(new THREE.Vector3(0, 0.01, 0), extent);
      expect(position.y - extent.y / 2).toBeCloseTo(0);
    }
  });

  it("stacks a plate flush on top of a cube", () => {
    const cube = rotatedSize([1, 1, 1], new THREE.Quaternion());
    const plate = rotatedSize([2, 0.5, 1], new THREE.Quaternion());
    const bottom = snapToGrid(new THREE.Vector3(0, 0, 0), cube);
    // Aiming a little above the top of the cube, as a hand would.
    const top = snapToGrid(new THREE.Vector3(0, 1.2, 0), plate);
    expect(brickBox(bottom, cube).max.y).toBeCloseTo(1);
    expect(brickBox(top, plate).min.y).toBeCloseTo(1);
  });
});

describe("boxesOverlap", () => {
  const extent = new THREE.Vector3(1, 1, 1);

  it("does not count bricks that only touch", () => {
    const a = brickBox(new THREE.Vector3(0.5, 0.5, 0.5), extent);
    const b = brickBox(new THREE.Vector3(1.5, 0.5, 0.5), extent);
    expect(boxesOverlap(a, b)).toBe(false);
  });

  it("counts bricks that share space", () => {
    const a = brickBox(new THREE.Vector3(0.5, 0.5, 0.5), extent);
    const b = brickBox(new THREE.Vector3(1, 0.5, 0.5), extent);
    expect(boxesOverlap(a, b)).toBe(true);
  });

  it("counts a brick against itself", () => {
    const a = brickBox(new THREE.Vector3(0.5, 0.5, 0.5), extent);
    expect(boxesOverlap(a, a.clone())).toBe(true);
  });
});
