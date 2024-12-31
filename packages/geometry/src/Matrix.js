import Vector from "./Vector.js";

// TODO: find out if it makes sense to use LUP decomposition?
/**
 * @import { VectorLike } from './Vector.js'
 */
export default class Matrix {
  /**
   * @private
   */
  e0;

  /**
   * @private
   */
  e1;

  /**
   * @private
   */
  e2;

  /**
   * @private
   */
  e3;

  /**
   * @private
   */
  e4;

  /**
   * @private
   */
  e5;

  /**
   * @private
   */
  e6;

  /**
   * @private
   */
  e7;

  /**
   * @private
   */
  e8;

  /**
   * @public
   * @param {number[]} [entries=[]]
   */
  constructor(entries = []) {
    this.e0 = entries[0] ?? 0;
    this.e1 = entries[1] ?? 0;
    this.e2 = entries[2] ?? 0;
    this.e3 = entries[3] ?? 0;
    this.e4 = entries[4] ?? 0;
    this.e5 = entries[5] ?? 0;
    this.e6 = entries[6] ?? 0;
    this.e7 = entries[7] ?? 0;
    this.e8 = entries[8] ?? 0;
  }

  // 0 1 2
  // 3 4 5
  // 6 7 8
  /**
   * @returns {number}
   */
  get det() {
    Object.defineProperty(this, "det", {
      value:
        this.e0 * this.e4 * this.e8 +
        this.e3 * this.e7 * this.e2 +
        this.e6 * this.e1 * this.e5 -
        (this.e0 * this.e7 * this.e5 +
          this.e3 * this.e1 * this.e8 +
          this.e6 * this.e4 * this.e2),
    });
    return this.det;
  }

  /**
   * @static
   * @returns {Matrix}
   */
  static zero() {
    return new Matrix([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }

  /**
   * @static
   * @returns {Matrix}
   */
  static identity() {
    return new Matrix([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  }

  /**
   * @param {Matrix} m
   * @returns {boolean}
   */
  isEqual(m) {
    return (
      this.e0 === m.e0 &&
      this.e1 === m.e1 &&
      this.e2 === m.e2 &&
      this.e3 === m.e3 &&
      this.e4 === m.e4 &&
      this.e5 === m.e5 &&
      this.e6 === m.e6 &&
      this.e7 === m.e7 &&
      this.e8 === m.e8
    );
  }

  /**
   * @param {Matrix} m
   * @returns {Matrix}
   */
  mul(m) {
    return new Matrix([
      this.e0 * m.e0 + this.e1 * m.e3 + this.e2 * m.e6,
      this.e0 * m.e1 + this.e1 * m.e4 + this.e2 * m.e7,
      this.e0 * m.e2 + this.e1 * m.e5 + this.e2 * m.e8,
      this.e3 * m.e0 + this.e4 * m.e3 + this.e5 * m.e6,
      this.e3 * m.e1 + this.e4 * m.e4 + this.e5 * m.e7,
      this.e3 * m.e2 + this.e4 * m.e5 + this.e5 * m.e8,
      this.e6 * m.e0 + this.e7 * m.e3 + this.e8 * m.e6,
      this.e6 * m.e1 + this.e7 * m.e4 + this.e8 * m.e7,
      this.e6 * m.e2 + this.e7 * m.e5 + this.e8 * m.e8,
    ]);
  }

  /**
   * @returns {Matrix}
   */
  inv() {
    const oneOverDet = 1 / this.det;
    // 0 1 2
    // 3 4 5
    // 6 7 8
    return new Matrix([
      (this.e4 * this.e8 - this.e5 * this.e7) * oneOverDet,
      (this.e1 * this.e8 - this.e2 * this.e7) * -oneOverDet,
      (this.e1 * this.e5 - this.e2 * this.e4) * oneOverDet,
      (this.e3 * this.e8 - this.e5 * this.e6) * -oneOverDet,
      (this.e0 * this.e8 - this.e2 * this.e6) * oneOverDet,
      (this.e0 * this.e5 - this.e2 * this.e3) * -oneOverDet,
      (this.e3 * this.e7 - this.e4 * this.e6) * oneOverDet,
      (this.e0 * this.e7 - this.e1 * this.e6) * -oneOverDet,
      (this.e0 * this.e4 - this.e1 * this.e3) * oneOverDet,
    ]);
  }

  /**
   * @param {Matrix} m
   * @returns {Matrix}
   */
  add(m) {
    return new Matrix([
      this.e0 + m.e0,
      this.e1 + m.e1,
      this.e2 + m.e2,
      this.e3 + m.e3,
      this.e4 + m.e4,
      this.e5 + m.e5,
      this.e6 + m.e6,
      this.e7 + m.e7,
      this.e8 + m.e8,
    ]);
  }

  /**
   * @param {Matrix} m
   * @returns {Matrix}
   */
  sub(m) {
    return new Matrix([
      this.e0 - m.e0,
      this.e1 - m.e1,
      this.e2 - m.e2,
      this.e3 - m.e3,
      this.e4 - m.e4,
      this.e5 - m.e5,
      this.e6 - m.e6,
      this.e7 - m.e7,
      this.e8 - m.e8,
    ]);
  }

  /**
   * @param {VectorLike} vector
   * @returns {Vector}
   */
  mulVector({ x, y, z = 0 }) {
    return new Vector(
      this.e0 * x + this.e1 * y + this.e2 * z,
      this.e3 * x + this.e4 * y + this.e5 * z,
      this.e6 * x + this.e7 * y + this.e8 * z,
    );
  }

  /**
   * @param {VectorLike} vector
   * @returns {Vector}
   */
  mulVectorOnTheLeft({ x, y, z = 0 }) {
    return new Vector(
      this.e0 * x + this.e3 * y + this.e6 * z,
      this.e1 * x + this.e4 * y + this.e7 * z,
      this.e2 * x + this.e5 * y + this.e8 * z,
    );
  }

  /**
   * @returns {string}
   */
  toString() {
    return `\
${this.e0.toString()} ${this.e1.toString()} ${this.e2.toString()}
${this.e3.toString()} ${this.e4.toString()} ${this.e5.toString()}
${this.e6.toString()} ${this.e7.toString()} ${this.e8.toString()}`;
  }

  /**
   * @param {number} digits
   * @returns {string}
   */
  toFixed(digits) {
    return `\
${this.e0.toFixed(digits)} ${this.e1.toFixed(digits)} ${this.e2.toFixed(digits)}
${this.e3.toFixed(digits)} ${this.e4.toFixed(digits)} ${this.e5.toFixed(digits)}
${this.e6.toFixed(digits)} ${this.e7.toFixed(digits)} ${this.e8.toFixed(digits)}`;
  }
}
