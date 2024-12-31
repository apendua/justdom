/**
 * @typedef {(v: Vector) => number[]} VectorToArray
 */

/**
 * @typedef {(a: number[]) => Vector} ArrayToVector
 */

/**
 * @typedef {(
 *   | "xyz"
 *   | "xzy"
 *   | "yxz"
 *   | "yzx"
 *   | "zxy"
 *   | "zyx"
 * )} OrderOfCoordinates
 */

/**
 * @typedef {Object} VectorLike
 * @property {number} x
 * @property {number} y
 * @property {number} [z]
 */

/**
 * @param {number} i
 * @param {VectorToArray} toArray
 * @returns {(v: Vector) => number}
 */
function getAtIndex(i, toArray) {
  return (v) => toArray(v)[i];
}

/**
 * @param {number} i
 * @param {ArrayToVector} toVector
 * @returns {(value: number) => Vector}
 */
function setAtIndex(i, toVector) {
  return (value) => {
    const a = [0, 0, 0];
    a[i] = value;
    return toVector(a);
  };
}

export default class Vector {
  /**
   * @public
   * @readonly
   */
  x;

  /**
   * @public
   * @readonly
   */
  y;

  /**
   * @public
   * @readonly
   */
  z;

  /**
   * @public
   * @static
   * @readonly
   * @default "xyz"
   */
  static XYZ = "xyz";

  /**
   * @public
   * @static
   * @readonly
   * @default "xzy"
   */
  static XZY = "xzy";

  /**
   * @public
   * @static
   * @readonly
   * @default "yxz"
   */
  static YXZ = "yxz";

  /**
   * @public
   * @static
   * @readonly
   * @default "yzx"
   */
  static YZX = "yzx";

  /**
   * @public
   * @static
   * @readonly
   * @default "zxy"
   */
  static ZXY = "zxy";

  /**
   * @public
   * @static
   * @readonly
   * @default "zyx"
   */
  static ZYX = "zyx";

  /**
   * @public
   * @param {number} [x=0]
   * @param {number} [y=0]
   * @param {number} [z=0]
   */
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  /**
   * @public
   * @returns {number}
   */
  get min() {
    Object.defineProperty(this, "min", {
      value: Math.min(this.x, this.y, this.z),
    });
    return this.min;
  }

  /**
   * @public
   * @returns {OrderOfCoordinates}
   */
  get order() {
    Object.defineProperty(this, "order", {
      value: Vector.getOrder(this.x, this.y, this.z),
    });
    return this.order;
  }

  /**
   * @public
   * @returns {number}
   */
  get length2() {
    Object.defineProperty(this, "length2", {
      value: this.x * this.x + this.y * this.y + this.z * this.z,
    });
    return this.length2;
  }

  /**
   * @public
   * @returns {number}
   */
  get length() {
    Object.defineProperty(this, "length", {
      value: Math.sqrt(this.length2),
    });
    return this.length;
  }

  /**
   * @public
   * @param {VectorLike} vector
   * @returns {boolean}
   */
  isEqual({ x, y, z = 0 }) {
    return this.x === x && this.y === y && this.z === z;
  }

  /**
   * @public
   * @param {VectorLike} vector
   * @returns {Vector}
   */
  add({ x, y, z = 0 }) {
    return new Vector(this.x + x, this.y + y, this.z + z);
  }

  /**
   * @public
   * @param {VectorLike} vector
   * @returns {Vector}
   */
  sub({ x, y, z = 0 }) {
    return new Vector(this.x - x, this.y - y, this.z - z);
  }

  /**
   * @public
   * @param {number} a
   * @returns {Vector}
   */
  mul(a) {
    return new Vector(this.x * a, this.y * a, this.z * a);
  }

  /**
   * @public
   * @param {number} a
   * @returns {Vector}
   */
  div(a) {
    return new Vector(this.x / a, this.y / a, this.z / a);
  }

  /**
   * @public
   * @returns {Vector}
   */
  floor() {
    return new Vector(
      Math.floor(this.x),
      Math.floor(this.y),
      Math.floor(this.z),
    );
  }

  /**
   * @public
   * @param {VectorLike} vector
   * @returns {number}
   */
  dot({ x, y, z = 0 }) {
    return this.x * x + this.y * y + this.z * z;
  }

  /**
   * @public
   * @param {VectorLike} vector
   * @returns {Vector}
   */
  cross({ x, y, z = 0 }) {
    return new Vector(
      this.y * z - this.z * y,
      this.z * x - this.x * z,
      this.x * y - this.y * x,
    );
  }

  /**
   * @public
   * @returns {string}
   */
  toString() {
    return `[${this.x.toString()},${this.y.toString()},${this.z.toString()}]`;
  }

  /**
   * @public
   * @param {number} digits
   * @returns {string}
   */
  toFixed(digits) {
    return `[${this.x.toFixed(digits)},${this.y.toFixed(digits)},${this.z.toFixed(digits)}]`;
  }

  /**
   * @public
   * @static
   * @returns {Vector}
   */
  static zero() {
    return new this(0, 0, 0);
  }

  /**
   * @public
   * @static
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {OrderOfCoordinates}
   */
  static getOrder(x, y, z) {
    if (x <= y) {
      if (y <= z) {
        return Vector.XYZ;
      }
      if (x <= z) {
        return Vector.XZY;
      }
      return Vector.ZXY; // z < x <= y
    }
    if (x <= z) {
      // y < x
      return Vector.YXZ;
    }
    if (y <= z) {
      // z < x
      return Vector.YZX;
    }
    return Vector.ZYX; // z < y < x
  }

  /**
   * @public
   * @static
   * @param {number} index
   * @param {OrderOfCoordinates} [order=Vector.XYZ]
   * @returns {(v: Vector) => number}
   */
  static getProjection(index, order = Vector.XYZ) {
    switch (order) {
      case Vector.XYZ:
        return getAtIndex(index, ({ x, y, z }) => [x, y, z]);
      case Vector.XZY:
        return getAtIndex(index, ({ x, y, z }) => [x, z, y]);
      case Vector.YXZ:
        return getAtIndex(index, ({ x, y, z }) => [y, x, z]);
      case Vector.YZX:
        return getAtIndex(index, ({ x, y, z }) => [y, z, x]);
      case Vector.ZXY:
        return getAtIndex(index, ({ x, y, z }) => [z, x, y]);
      case Vector.ZYX:
        return getAtIndex(index, ({ x, y, z }) => [z, y, x]);
      default:
        return () => 0;
    }
  }

  /**
   * @public
   * @static
   * @param {number} index
   * @param {OrderOfCoordinates} [order=Vector.XYZ]
   * @returns {(value: number) => Vector}
   */
  static getEmbedding(index, order = Vector.XYZ) {
    switch (order) {
      case Vector.XYZ:
        return setAtIndex(index, ([x, y, z]) => new Vector(x, y, z));
      case Vector.XZY:
        return setAtIndex(index, ([x, z, y]) => new Vector(x, y, z));
      case Vector.YXZ:
        return setAtIndex(index, ([y, x, z]) => new Vector(x, y, z));
      case Vector.YZX:
        return setAtIndex(index, ([y, z, x]) => new Vector(x, y, z));
      case Vector.ZXY:
        return setAtIndex(index, ([z, x, y]) => new Vector(x, y, z));
      case Vector.ZYX:
        return setAtIndex(index, ([z, y, x]) => new Vector(x, y, z));
      default:
        return () => Vector.zero();
    }
  }
}
