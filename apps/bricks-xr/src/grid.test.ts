import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { cellKey, onBoard, snapToCell } from "./grid.js";

const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe("snapToCell", () => {
  it("puts a brick in the middle of the nearest cell", () => {
    expect(snapToCell(at(0.2, 1.4, -2.7)).toArray()).toEqual([0.5, 1.5, -2.5]);
  });

  it("leaves a brick that is already in a cell alone", () => {
    const once = snapToCell(at(3.1, 0.4, -1.9));
    expect(snapToCell(once).toArray()).toEqual(once.toArray());
  });

  it("rests a brick aimed at the floor on top of it", () => {
    expect(snapToCell(at(0, -4, 0)).y).toBe(0.5);
  });

  it("stacks cell on cell", () => {
    expect(snapToCell(at(0, 1.2, 0)).y).toBe(1.5);
  });
});

describe("cellKey", () => {
  it("names the cell, not the point", () => {
    expect(cellKey(at(0.2, 0.6, 0.9))).toBe(cellKey(at(0.8, 0.4, 0.1)));
    expect(cellKey(at(0.5, 0.5, 0.5))).not.toBe(cellKey(at(1.5, 0.5, 0.5)));
  });
});

describe("onBoard", () => {
  it("knows the board from what is off it", () => {
    expect(onBoard(at(0.5, 0.5, 0.5))).toBe(true);
    expect(onBoard(at(12, 0.5, 0))).toBe(false);
  });
});
