/* eslint-env jest */
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
      expect(m.isEqual(m)).toBe(true);
    });
    test("should check if matrices are different", () => {
      expect(n.isEqual(m)).toBe(false);
    });
  });
  describe("Matrix.zero", () => {
    beforeEach(() => {
      m = M([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    });
    test("should check if matrix is equal to zero matrix", () => {
      expect(m.isEqual(Matrix.zero())).toBe(true);
    });
  });
  describe("Matrix.identity", () => {
    beforeEach(() => {
      m = M([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    });
    test("should equal the identity matrix", () => {
      expect(m.isEqual(Matrix.identity())).toBe(true);
    });
  });
  describe("Matrix", () => {
    beforeEach(() => {
      m = M();
    });
    test("should create a zero matrix by default", () => {
      expect(m.isEqual(Matrix.zero())).toBe(true);
    });
  });
  describe("Matrix.add", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      n = M([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    });
    test("should add two matrices", () => {
      expect(m.add(n).isEqual(M([8, 8, 8, 8, 8, 8, 8, 8, 8]))).toBe(true);
    });
  });
  describe("Matrix.sub", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });
    test("matrix subtract the same matrix should equal zero", () => {
      expect(m.sub(m).isEqual(Matrix.zero())).toBe(true);
    });
  });
  describe("Matrix.mul", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      n = M([1, 1, 1, -1, -1, -1, 1, 1, 1]);
    });
    test("should not change matrix if multiplied by right identity", () => {
      expect(m.mul(Matrix.identity()).isEqual(m)).toBe(true);
    });
    test("should not change matrix if multiplied by left identity", () => {
      expect(Matrix.identity().mul(m).isEqual(m)).toBe(true);
    });
    test("should multiply two matrices", () => {
      expect(m.mul(n).isEqual(M([1, 1, 1, 4, 4, 4, 7, 7, 7]))).toBe(true);
    });
    test("should multiply two matrices (bis)", () => {
      expect(n.mul(m).isEqual(M([9, 12, 15, -9, -12, -15, 9, 12, 15]))).toBe(
        true,
      );
    });
  });
  describe("Matrix.det", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      n = M([1, 0, 0, 1, 2, 0, 1, 1, 3]);
    });
    test("should evaluate determinat of the matrix", () => {
      expect(m.det).toBe(0);
    });
    test("should evaluate determinat of the matrix (bis)", () => {
      expect(n.det).toBe(6);
    });
  });
  describe("Matrix.inv", () => {
    beforeEach(() => {
      m = M([1, 0, 0, 1, 1, 0, 1, 1, 1]);
      n = m.inv();
    });
    test("should invert a matrix", () => {
      expect(m.mul(n).isEqual(Matrix.identity())).toBe(true);
    });
  });
  describe("Matrix.mulVector", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      v = V(1, 2, 3);
    });
    test("should multiply matrix by a 2D inline vector", () => {
      expect(m.mulVector({ x: 1, y: 2 }).isEqual({ x: 2, y: 11, z: 20 })).toBe(
        true,
      );
    });
    test("should multiply matrix by a 3D inline vector", () => {
      expect(
        m.mulVector({ x: 1, y: 2, z: 3 }).isEqual({ x: 8, y: 26, z: 44 }),
      ).toBe(true);
    });
    test("should multiply matrix by a vector", () => {
      expect(m.mulVector(v).isEqual({ x: 8, y: 26, z: 44 })).toBe(true);
    });
  });
  describe("Matrix.mulVectorOnTheLeft", () => {
    beforeEach(() => {
      m = M([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      v = V(1, 2, 3);
    });
    test("should multiply vector by matrix", () => {
      expect(m.mulVectorOnTheLeft(v).toString()).toBe("[24,30,36]");
    });
  });
});
