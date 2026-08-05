import Complex from "./Complex.js";

/**
 * A free vector on the (complex) affine plane — the result of subtracting two
 * points. Unlike {@link Vec3} it is not homogeneous: (1, 2) and (2, 4) are
 * different vectors.
 */
export default class Vec2 {
  /**
   * @public
   * @readonly
   * @type {Complex}
   */
  x;

  /**
   * @public
   * @readonly
   * @type {Complex}
   */
  y;

  /**
   * @param {number | Complex} x
   * @param {number | Complex} y
   */
  constructor(x, y) {
    this.x = Complex.from(x);
    this.y = Complex.from(y);
  }

  /**
   * @param {Vec2} other
   * @returns {Vec2}
   */
  add(other) {
    return new Vec2(this.x.add(other.x), this.y.add(other.y));
  }

  /**
   * @param {Vec2} other
   * @returns {Vec2}
   */
  sub(other) {
    return new Vec2(this.x.sub(other.x), this.y.sub(other.y));
  }

  /**
   * @param {number | Complex} k
   * @returns {Vec2}
   */
  mul(k) {
    return new Vec2(this.x.mul(k), this.y.mul(k));
  }

  /**
   * @param {number | Complex} k
   * @returns {Vec2}
   */
  div(k) {
    if (typeof k === "number") {
      return this.mul(1 / k);
    }
    return this.mul(k.inv());
  }

  /**
   * @returns {Vec2}
   */
  neg() {
    return new Vec2(this.x.neg(), this.y.neg());
  }

  /**
   * The dot product of two vectors.
   *
   * @param {Vec2} other
   * @returns {Complex}
   */
  dot(other) {
    return this.x.mul(other.x).add(this.y.mul(other.y));
  }

  /**
   * Rotates the vector by the given angle (radians, counterclockwise).
   *
   * @param {number} angle
   * @returns {Vec2}
   */
  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vec2(
      this.x.mulByReal(cos).sub(this.y.mulByReal(sin)),
      this.x.mulByReal(sin).add(this.y.mulByReal(cos)),
    );
  }

  /**
   * The Euclidean length; only meaningful for real vectors, where it matches
   * the usual notion.
   *
   * @returns {number}
   */
  length() {
    return this.x.mul(this.x).add(this.y.mul(this.y)).sqrt()[0].abs();
  }

  /**
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  isReal(epsilon = 1e-6) {
    return this.x.isReal(epsilon) && this.y.isReal(epsilon);
  }

  /**
   * @param {Vec2} other
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  equals(other, epsilon = 1e-9) {
    return this.x.equals(other.x, epsilon) && this.y.equals(other.y, epsilon);
  }

  /**
   * @returns {string}
   */
  toString() {
    return `[${this.x}, ${this.y}]`;
  }
}
