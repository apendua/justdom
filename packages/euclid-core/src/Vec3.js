import Complex, { EPSILON } from "./Complex.js";

/**
 * A 3-vector with complex entries. Used as the homogeneous representation of
 * points and lines on the complex projective plane.
 */
export default class Vec3 {
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
   * @public
   * @readonly
   * @type {Complex}
   */
  z;

  /**
   * @param {number | Complex} x
   * @param {number | Complex} y
   * @param {number | Complex} z
   */
  constructor(x, y, z) {
    this.x = Complex.from(x);
    this.y = Complex.from(y);
    this.z = Complex.from(z);
  }

  /**
   * @param {Vec3} other
   * @returns {Vec3}
   */
  add(other) {
    return new Vec3(this.x.add(other.x), this.y.add(other.y), this.z.add(other.z));
  }

  /**
   * @param {Vec3} other
   * @returns {Vec3}
   */
  sub(other) {
    return new Vec3(this.x.sub(other.x), this.y.sub(other.y), this.z.sub(other.z));
  }

  /**
   * @param {number | Complex} k
   * @returns {Vec3}
   */
  mul(k) {
    return new Vec3(this.x.mul(k), this.y.mul(k), this.z.mul(k));
  }

  /**
   * @param {number | Complex} k
   * @returns {Vec3}
   */
  div(k) {
    if (typeof k === "number") {
      return this.mul(1 / k);
    }
    return this.mul(k.inv());
  }

  /**
   * @param {Vec3} other
   * @returns {Complex}
   */
  dot(other) {
    return this.x.mul(other.x).add(this.y.mul(other.y)).add(this.z.mul(other.z));
  }

  /**
   * @param {Vec3} other
   * @returns {Vec3}
   */
  cross(other) {
    return new Vec3(
      this.y.mul(other.z).sub(this.z.mul(other.y)),
      this.z.mul(other.x).sub(this.x.mul(other.z)),
      this.x.mul(other.y).sub(this.y.mul(other.x)),
    );
  }

  /**
   * @returns {number}
   */
  norm() {
    return Math.sqrt(this.x.abs2() + this.y.abs2() + this.z.abs2());
  }

  /**
   * Scales the vector so that its largest coordinate has magnitude 1. Keeps
   * homogeneous coordinates numerically well behaved without changing the
   * projective object they represent.
   *
   * @returns {Vec3}
   */
  normalize() {
    const max = Math.max(this.x.abs(), this.y.abs(), this.z.abs());
    if (max === 0 || !Number.isFinite(max)) {
      return this;
    }
    return this.mul(1 / max);
  }

  /**
   * Whether both vectors represent the same projective object, i.e. their
   * cross product vanishes.
   *
   * @param {Vec3} other
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  isParallel(other, epsilon = EPSILON) {
    const a = this.normalize();
    const b = other.normalize();
    return a.cross(b).norm() <= epsilon;
  }

  /**
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  isZero(epsilon = EPSILON) {
    return this.norm() <= epsilon;
  }

  /**
   * @returns {boolean}
   */
  isFinite() {
    return this.x.isFinite() && this.y.isFinite() && this.z.isFinite();
  }

  /**
   * @returns {string}
   */
  toString() {
    return `(${this.x}:${this.y}:${this.z})`;
  }
}
