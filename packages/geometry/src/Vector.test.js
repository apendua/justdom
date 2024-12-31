/* eslint-env jest */
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
      expect(v.toString()).toBe("[1.21,3.41,5.61]");
    });
  });
  describe("Vector.toFixed", () => {
    beforeEach(() => {
      v = V(1.21, 3.41, 5.61);
    });
    test("should properly serialize a vector", () => {
      expect(v.toFixed(1)).toBe("[1.2,3.4,5.6]");
    });
  });
  describe("Vector.floor", () => {
    beforeEach(() => {
      v = V(1.21, 3.41, 5.61);
    });
    test('should apply "floor" to all coordinates', () => {
      expect(v.floor().isEqual(V(1, 3, 5))).toBe(true);
    });
  });
  describe("Vector.min", () => {
    beforeEach(() => {
      v1 = V(1, 2, 3);
      v2 = V(3, 1, 2);
      v3 = V(2, 3, 1);
    });
    test("should find that x is the minimal coordinate", () => {
      expect(v1.min).toBe(1);
    });
    test("should find that y is the minimal coordinate", () => {
      expect(v2.min).toBe(1);
    });
    test("should find that z is the minimal coordinate", () => {
      expect(v3.min).toBe(1);
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
      expect(v1.order).toBe(Vector.XYZ);
    });
    test("should find XZY ordering", () => {
      expect(v2.order).toBe(Vector.XZY);
    });
    test("should find YXZ ordering", () => {
      expect(v3.order).toBe(Vector.YXZ);
    });
    test("should find ZXY ordering", () => {
      expect(v4.order).toBe(Vector.ZXY);
    });
    test("should find YZX ordering", () => {
      expect(v5.order).toBe(Vector.YZX);
    });
    test("should find ZYX ordering", () => {
      expect(v6.order).toBe(Vector.ZYX);
    });
  });
  describe("Vector.add", () => {
    beforeEach(() => {
      v = V(1, 0, 1);
      u = V(1, 1, 0);
    });
    test("should add two vectors", () => {
      expect(v.add(u).toString()).toBe("[2,1,1]");
    });
    test('should add an "inline" to a vector', () => {
      expect(v.add(V(1, 1, 0)).toString()).toBe("[2,1,1]");
    });
  });
  describe("Vector.sub", () => {
    beforeEach(() => {
      v = V(1, 0, 1);
      u = V(1, 1, 0);
    });
    test("should subtract two vectors", () => {
      expect(v.sub(u).toString()).toBe("[0,-1,1]");
    });
    test('should subtract an "inline" from a vector', () => {
      expect(v.sub(V(1, 1, 0)).toString()).toBe("[0,-1,1]");
    });
  });
  describe("Vector.mul", () => {
    beforeEach(() => {
      v = V(1, 1, 1);
    });
    test("should multiply vector by scalar", () => {
      expect(v.mul(2).toString()).toBe("[2,2,2]");
    });
  });
  describe("Vector.div", () => {
    beforeEach(() => {
      v = V(2, 2, 2);
    });
    test("should divide vector by scalar", () => {
      expect(v.div(2).toString()).toBe("[1,1,1]");
    });
  });
  describe("Vector.dot", () => {
    beforeEach(() => {
      v = V(1, -1, 2);
    });
    test("should compute dot product of two vectors", () => {
      expect(v.dot(v)).toBe(6);
    });
    test('should compute dot product of vector and "inline"', () => {
      expect(v.dot(V(1, 1, 1))).toBe(2);
    });
  });
  describe("Vector.length", () => {
    beforeEach(() => {
      v = V(3, 4, 0);
    });
    test("should compute vector length", () => {
      expect(v.length).toBe(5);
    });
  });
  describe("Vector.length2", () => {
    beforeEach(() => {
      v = V(1, 2, 3);
    });
    test("should compute length squared", () => {
      expect(v.length2).toBe(14);
    });
  });
  describe("Vector.cross", () => {
    beforeEach(() => {
      v = V(1, 0, 1);
      u = V(1, 1, 1);
    });
    test("should compute cross product of two vectors", () => {
      expect(v.cross(u).toString()).toBe("[-1,0,1]");
    });
    test("should compute cross product of two vectors (bis)", () => {
      expect(u.cross(v).toString()).toBe("[1,0,-1]");
    });
    test('should compute cross product of vector and "inline"', () => {
      expect(v.cross(V(1, 1, 1)).toString()).toBe("[-1,0,1]");
    });
  });
});
