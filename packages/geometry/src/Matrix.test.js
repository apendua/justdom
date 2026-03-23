import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
/* eslint prefer-arrow-callback: "off", no-unused-expressions: "off" */
import Matrix from "./Matrix.js";
import Vector from "./Vector.js";

/**
 * @param {ConstructorParameters<typeof Matrix>} args
 * @returns {Matrix}
 */
function M(...args) {
  return new Matrix(...args);
}

/**
 * @param {ConstructorParameters<typeof Vector>} args
 * @returns {Vector}
 */
function V(...args) {
  return new Vector(...args);
}

describe("Test Matrix", () => {
  /** @type {Matrix} */
  let m;
  /** @type {Matrix} */
  let n;
  /** @type {Vector} */
  let v;
  describe("Matrix.isEqual", () => {
    beforeEach(() => {
      m = M([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      n = M([1, 1, 0, 0, 1, 0, 0, 0, 1]);
    });
    test("should check if matrices are the same", () => {
      assert.strictEqual(m.isEqual(m), true);
    });
    test("should check if matrices are different", () => {
      assert.strictEqual(n.isEqual(m), false);
    });
  });
  describe("Matrix.zero", () => {
    beforeEach(() => {
      m = M([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    });
    test("should check if matrix is equal to zero matrix", () => {
      assert.strictEqual(m.isEqual(Matrix.zero()), true);
    });
  });
  describe("Matrix.identity", () => {
    beforeEach(() => {
      m = M([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    });
    test("should equal the identity matrix", () => {
      assert.strictEqual(m.isEqual(Matrix.identity()), true);
    });
  });
  describe("Matrix", () => {
    beforeEach(() => {
      m = M();
    });
    test("should create a zero matrix by default", () => {
      assert.strictEqual(m.isEqual(Matrix.zero()), true);
    });
  });
  describe("Matrix.add", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      n = M([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    });
    test("should add two matrices", () => {
      assert.strictEqual(m.add(n).isEqual(M([8, 8, 8, 8, 8, 8, 8, 8, 8])), true);
    });
  });
  describe("Matrix.sub", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });
    test("matrix subtract the same matrix should equal zero", () => {
      assert.strictEqual(m.sub(m).isEqual(Matrix.zero()), true);
    });
  });
  describe("Matrix.mul", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      n = M([1, 1, 1, -1, -1, -1, 1, 1, 1]);
    });
    test("should not change matrix if multiplied by right identity", () => {
      assert.strictEqual(m.mul(Matrix.identity()).isEqual(m), true);
    });
    test("should not change matrix if multiplied by left identity", () => {
      assert.strictEqual(Matrix.identity().mul(m).isEqual(m), true);
    });
    test("should multiply two matrices", () => {
      assert.strictEqual(m.mul(n).isEqual(M([1, 1, 1, 4, 4, 4, 7, 7, 7])), true);
    });
    test("should multiply two matrices (bis)", () => {
      assert.strictEqual(n.mul(m).isEqual(M([9, 12, 15, -9, -12, -15, 9, 12, 15])), true);
    });
  });
  describe("Matrix.det", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      n = M([1, 0, 0, 1, 2, 0, 1, 1, 3]);
    });
    test("should evaluate determinat of the matrix", () => {
      assert.strictEqual(m.det, 0);
    });
    test("should evaluate determinat of the matrix (bis)", () => {
      assert.strictEqual(n.det, 6);
    });
  });
  describe("Matrix.inv", () => {
    beforeEach(() => {
      m = M([1, 0, 0, 1, 1, 0, 1, 1, 1]);
      n = m.inv();
    });
    test("should invert a matrix", () => {
      assert.strictEqual(m.mul(n).isEqual(Matrix.identity()), true);
    });
  });
  describe("Matrix.mulVector", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      v = V(1, 2, 3);
    });
    test("should multiply matrix by a 2D inline vector", () => {
      assert.strictEqual(m.mulVector({ x: 1, y: 2 }).isEqual({ x: 2, y: 11, z: 20 }), true);
    });
    test("should multiply matrix by a 3D inline vector", () => {
      assert.strictEqual(m.mulVector({ x: 1, y: 2, z: 3 }).isEqual({ x: 8, y: 26, z: 44 }), true);
    });
    test("should multiply matrix by a vector", () => {
      assert.strictEqual(m.mulVector(v).isEqual({ x: 8, y: 26, z: 44 }), true);
    });
  });
  describe("Matrix.mulVectorOnTheLeft", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      v = V(1, 2, 3);
    });
    test("should multiply vector by matrix", () => {
      assert.strictEqual(m.mulVectorOnTheLeft(v).toString(), "[24,30,36]");
    });
  });
});
