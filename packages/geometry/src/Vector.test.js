import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Vector from "./Vector.js";

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {Vector}
 */
function V(x, y, z) {
  return new Vector(x, y, z);
}
describe("Test Vector", () => {
  /** @type {Vector} */
  let v;
  /** @type {Vector} */
  let u;
  /** @type {Vector} */
  let v1;
  /** @type {Vector} */
  let v2;
  /** @type {Vector} */
  let v3;
  /** @type {Vector} */
  let v4;
  /** @type {Vector} */
  let v5;
  /** @type {Vector} */
  let v6;
  describe("Vector.toString", () => {
    beforeEach(() => {
      v = V(1.21, 3.41, 5.61);
    });
    test("should properly serialize a vector", () => {
      assert.strictEqual(v.toString(), "[1.21,3.41,5.61]");
    });
  });
  describe("Vector.toFixed", () => {
    beforeEach(() => {
      v = V(1.21, 3.41, 5.61);
    });
    test("should properly serialize a vector", () => {
      assert.strictEqual(v.toFixed(1), "[1.2,3.4,5.6]");
    });
  });
  describe("Vector.floor", () => {
    beforeEach(() => {
      v = V(1.21, 3.41, 5.61);
    });
    test('should apply "floor" to all coordinates', () => {
      assert.strictEqual(v.floor().isEqual(V(1, 3, 5)), true);
    });
  });
  describe("Vector.min", () => {
    beforeEach(() => {
      v1 = V(1, 2, 3);
      v2 = V(3, 1, 2);
      v3 = V(2, 3, 1);
    });
    test("should find that x is the minimal coordinate", () => {
      assert.strictEqual(v1.min, 1);
    });
    test("should find that y is the minimal coordinate", () => {
      assert.strictEqual(v2.min, 1);
    });
    test("should find that z is the minimal coordinate", () => {
      assert.strictEqual(v3.min, 1);
    });
  });
  describe("Vector.order", () => {
    beforeEach(() => {
      v1 = V(1, 2, 3);
      v2 = V(1, 3, 2);
      v3 = V(2, 1, 3);
      v4 = V(2, 3, 1);
      v5 = V(3, 1, 2);
      v6 = V(3, 2, 1);
    });
    test("should find XYZ ordering", () => {
      assert.strictEqual(v1.order, Vector.XYZ);
    });
    test("should find XZY ordering", () => {
      assert.strictEqual(v2.order, Vector.XZY);
    });
    test("should find YXZ ordering", () => {
      assert.strictEqual(v3.order, Vector.YXZ);
    });
    test("should find ZXY ordering", () => {
      assert.strictEqual(v4.order, Vector.ZXY);
    });
    test("should find YZX ordering", () => {
      assert.strictEqual(v5.order, Vector.YZX);
    });
    test("should find ZYX ordering", () => {
      assert.strictEqual(v6.order, Vector.ZYX);
    });
  });
  describe("Vector.add", () => {
    beforeEach(() => {
      v = V(1, 0, 1);
      u = V(1, 1, 0);
    });
    test("should add two vectors", () => {
      assert.strictEqual(v.add(u).toString(), "[2,1,1]");
    });
    test('should add an "inline" to a vector', () => {
      assert.strictEqual(v.add(V(1, 1, 0)).toString(), "[2,1,1]");
    });
  });
  describe("Vector.sub", () => {
    beforeEach(() => {
      v = V(1, 0, 1);
      u = V(1, 1, 0);
    });
    test("should subtract two vectors", () => {
      assert.strictEqual(v.sub(u).toString(), "[0,-1,1]");
    });
    test('should subtract an "inline" from a vector', () => {
      assert.strictEqual(v.sub(V(1, 1, 0)).toString(), "[0,-1,1]");
    });
  });
  describe("Vector.mul", () => {
    beforeEach(() => {
      v = V(1, 1, 1);
    });
    test("should multiply vector by scalar", () => {
      assert.strictEqual(v.mul(2).toString(), "[2,2,2]");
    });
  });
  describe("Vector.div", () => {
    beforeEach(() => {
      v = V(2, 2, 2);
    });
    test("should divide vector by scalar", () => {
      assert.strictEqual(v.div(2).toString(), "[1,1,1]");
    });
  });
  describe("Vector.dot", () => {
    beforeEach(() => {
      v = V(1, -1, 2);
    });
    test("should compute dot product of two vectors", () => {
      assert.strictEqual(v.dot(v), 6);
    });
    test('should compute dot product of vector and "inline"', () => {
      assert.strictEqual(v.dot(V(1, 1, 1)), 2);
    });
  });
  describe("Vector.length", () => {
    beforeEach(() => {
      v = V(3, 4, 0);
    });
    test("should compute vector length", () => {
      assert.strictEqual(v.length, 5);
    });
  });
  describe("Vector.length2", () => {
    beforeEach(() => {
      v = V(1, 2, 3);
    });
    test("should compute length squared", () => {
      assert.strictEqual(v.length2, 14);
    });
  });
  describe("Vector.cross", () => {
    beforeEach(() => {
      v = V(1, 0, 1);
      u = V(1, 1, 1);
    });
    test("should compute cross product of two vectors", () => {
      assert.strictEqual(v.cross(u).toString(), "[-1,0,1]");
    });
    test("should compute cross product of two vectors (bis)", () => {
      assert.strictEqual(u.cross(v).toString(), "[1,0,-1]");
    });
    test('should compute cross product of vector and "inline"', () => {
      assert.strictEqual(v.cross(V(1, 1, 1)).toString(), "[-1,0,1]");
    });
  });
});
