import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { cellKey, snapToCell } from "./grid.js";

describe("snapToCell", () => {
  it("puts a brick in the middle of the nearest cell", () => {
    expect(snapToCell(new THREE.Vector3(0.2, 1.4, -2.7)).toArray()).toEqual([0.5, 1.5, -2.5]);
  });

  it("does not move a brick that is already in a cell", () => {
    const once = snapToCell(new THREE.Vector3(3.1, 0.4, -1.9));
    expect(snapToCell(once).toArray()).toEqual(once.toArray());
  });

  it("rests a brick aimed at the floor on top of it", () => {
    expect(snapToCell(new THREE.Vector3(0, -4, 0)).y).toBe(0.5);
    expect(snapToCell(new THREE.Vector3(0, 0.1, 0)).y).toBe(0.5);
  });

  it("stacks cell on cell", () => {
    expect(snapToCell(new THREE.Vector3(0, 1.2, 0)).y).toBe(1.5);
  });
});

describe("cellKey", () => {
  it("gives two points in the same cell the same name", () => {
    expect(cellKey(new THREE.Vector3(0.2, 0.6, 0.9))).toBe(
      cellKey(new THREE.Vector3(0.8, 0.4, 0.1)),
    );
  });

  it("gives points in different cells different names", () => {
    expect(cellKey(new THREE.Vector3(0.5, 0.5, 0.5))).not.toBe(
      cellKey(new THREE.Vector3(1.5, 0.5, 0.5)),
    );
  });
});
