import Vec3 from "./Vec3.js";
import Vec2 from "./Vec2.js";

/**
 * @import Complex from "./Complex.js"
 */

/**
 * The tolerance used for geometric predicates (incidence, equality). The
 * representations are normalized, so this is a relative tolerance.
 */
export const GEOMETRIC_EPSILON = 1e-6;

/**
 * A point on the complex projective plane, represented by normalized
 * homogeneous coordinates (x : y : z).
 */
export default class Point {
  /**
   * @public
   * @readonly
   * @type {Vec3}
   */
  repr;

  /**
   * @param {Vec3} repr
   */
  constructor(repr) {
    this.repr = repr.normalize();
  }

  /**
   * @param {number | Complex} x
   * @param {number | Complex} y
   * @param {number | Complex} [z]
   * @returns {Point}
   */
  static of(x, y, z = 1) {
    return new Point(new Vec3(x, y, z));
  }

  /**
   * @param {Vec2} v
   * @returns {Point}
   */
  static atInfinity(v) {
    return new Point(new Vec3(v.x, v.y, 0));
  }

  /**
   * @returns {boolean}
   */
  isAtInfinity() {
    return this.repr.z.abs() <= GEOMETRIC_EPSILON;
  }

  /**
   * @returns {boolean}
   */
  isFinite() {
    return !this.isAtInfinity();
  }

  /**
   * Affine coordinates (z scaled to 1). Throws for points at infinity.
   *
   * @returns {{ x: Complex, y: Complex }}
   */
  affine() {
    if (this.isAtInfinity()) {
      throw new Error("Point at infinity has no affine coordinates.");
    }
    return {
      x: this.repr.x.div(this.repr.z),
      y: this.repr.y.div(this.repr.z),
    };
  }

  /**
   * The x coordinate; only meaningful for finite points.
   *
   * @returns {Complex}
   */
  get x() {
    return this.affine().x;
  }

  /**
   * The y coordinate; only meaningful for finite points.
   *
   * @returns {Complex}
   */
  get y() {
    return this.affine().y;
  }

  /**
   * Whether the point has real coordinates — for a finite point real affine
   * coordinates, for a point at infinity a real direction.
   *
   * @returns {boolean}
   */
  isReal() {
    if (this.isAtInfinity()) {
      // Normalize the phase so that e.g. (i : i : 0) counts as real.
      const { x, y } = this.repr;
      const pivot = x.abs() >= y.abs() ? x : y;
      if (pivot.abs() === 0) {
        return false;
      }
      return x.div(pivot).isReal() && y.div(pivot).isReal();
    }
    const { x, y } = this.affine();
    return x.isReal() && y.isReal();
  }

  /**
   * @param {Point} other
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  equals(other, epsilon = GEOMETRIC_EPSILON) {
    return this.repr.isParallel(other.repr, epsilon);
  }

  /**
   * The vector from this point to the other; both points must be finite.
   *
   * @param {Point} other
   * @returns {Vec2}
   */
  vectorTo(other) {
    const a = this.affine();
    const b = other.affine();
    return new Vec2(b.x.sub(a.x), b.y.sub(a.y));
  }

  /**
   * @param {Vec2} v
   * @returns {Point}
   */
  translate(v) {
    if (this.isAtInfinity()) {
      // Translation is the identity at infinity.
      return this;
    }
    const { x, y } = this.affine();
    return Point.of(x.add(v.x), y.add(v.y));
  }

  /**
   * The affine combination (1-t)*this + t*other of two finite points.
   *
   * @param {Point} other
   * @param {number} t
   * @returns {Point}
   */
  combine(other, t) {
    const a = this.affine();
    const b = other.affine();
    return Point.of(
      a.x.mulByReal(1 - t).add(b.x.mulByReal(t)),
      a.y.mulByReal(1 - t).add(b.y.mulByReal(t)),
    );
  }

  /**
   * The Euclidean distance between two finite real points.
   *
   * @param {Point} other
   * @returns {number}
   */
  distTo(other) {
    return this.vectorTo(other).length();
  }

  /**
   * Rotates the point around the origin by the given angle (radians).
   *
   * @param {number} angle
   * @returns {Point}
   */
  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const { x, y, z } = this.repr;
    return new Point(
      new Vec3(x.mulByReal(cos).sub(y.mulByReal(sin)), x.mulByReal(sin).add(y.mulByReal(cos)), z),
    );
  }

  /**
   * @returns {string}
   */
  toString() {
    return this.repr.toString();
  }
}
