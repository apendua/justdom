/**
 * Complex numbers.
 *
 * Coordinates on the projective plane are kept complex so that constructions
 * remain well defined even when an intersection is not real (e.g. a line
 * missing a circle). Realness is then just a predicate that filters what
 * eventually gets rendered.
 */

export const EPSILON = 1e-9;

export default class Complex {
  /**
   * @public
   * @readonly
   * @type {number}
   */
  re;

  /**
   * @public
   * @readonly
   * @type {number}
   */
  im;

  /**
   * @param {number} re
   * @param {number} [im]
   */
  constructor(re, im = 0) {
    this.re = re;
    this.im = im;
  }

  /**
   * @param {number | Complex} value
   * @returns {Complex}
   */
  static from(value) {
    if (value instanceof Complex) {
      return value;
    }
    return new Complex(value);
  }

  /**
   * @param {number} abs
   * @param {number} phi
   * @returns {Complex}
   */
  static fromPolar(abs, phi) {
    return new Complex(abs * Math.cos(phi), abs * Math.sin(phi));
  }

  static get zero() {
    return ZERO;
  }

  static get one() {
    return ONE;
  }

  static get i() {
    return I;
  }

  /**
   * Solves a*x^2 + b*x + c = 0 over complex numbers. Returns 0, 1 or 2 roots;
   * a double root is reported once.
   *
   * @param {Complex} a
   * @param {Complex} b
   * @param {Complex} c
   * @param {number} [epsilon]
   * @returns {Complex[]}
   */
  static solveQuadratic(a, b, c, epsilon = EPSILON) {
    const scale = Math.max(a.abs(), b.abs(), c.abs());
    if (scale < epsilon) {
      return [];
    }
    if (a.abs() < epsilon * scale) {
      if (b.abs() < epsilon * scale) {
        return [];
      }
      return [c.div(b).neg()];
    }
    const delta = b.mul(b).sub(a.mul(c).mulByReal(4));
    if (delta.abs() < epsilon * scale * scale) {
      return [b.div(a).mulByReal(-0.5)];
    }
    const [root] = delta.sqrt();
    return [b.sub(root).div(a).mulByReal(-0.5), b.add(root).div(a).mulByReal(-0.5)];
  }

  /**
   * @returns {number}
   */
  abs2() {
    return this.re * this.re + this.im * this.im;
  }

  /**
   * @returns {number}
   */
  abs() {
    return Math.hypot(this.re, this.im);
  }

  /**
   * The argument of the number, in radians.
   *
   * @returns {number}
   */
  phi() {
    return Math.atan2(this.im, this.re);
  }

  /**
   * @param {number | Complex} other
   * @returns {Complex}
   */
  add(other) {
    const z = Complex.from(other);
    return new Complex(this.re + z.re, this.im + z.im);
  }

  /**
   * @param {number | Complex} other
   * @returns {Complex}
   */
  sub(other) {
    const z = Complex.from(other);
    return new Complex(this.re - z.re, this.im - z.im);
  }

  /**
   * @param {number | Complex} other
   * @returns {Complex}
   */
  mul(other) {
    if (typeof other === "number") {
      return this.mulByReal(other);
    }
    return new Complex(
      this.re * other.re - this.im * other.im,
      this.re * other.im + this.im * other.re,
    );
  }

  /**
   * @param {number} k
   * @returns {Complex}
   */
  mulByReal(k) {
    return new Complex(this.re * k, this.im * k);
  }

  /**
   * @param {number | Complex} other
   * @returns {Complex}
   */
  div(other) {
    if (typeof other === "number") {
      return this.mulByReal(1 / other);
    }
    const oneOverAbs2 = 1 / other.abs2();
    return this.mul(other.conj()).mulByReal(oneOverAbs2);
  }

  /**
   * @returns {Complex}
   */
  neg() {
    return new Complex(-this.re, -this.im);
  }

  /**
   * @returns {Complex}
   */
  conj() {
    return new Complex(this.re, -this.im);
  }

  /**
   * @returns {Complex}
   */
  inv() {
    const oneOverAbs2 = 1 / this.abs2();
    return new Complex(this.re * oneOverAbs2, -this.im * oneOverAbs2);
  }

  /**
   * Both square roots, the one with a non-negative real part first.
   *
   * @returns {[Complex, Complex]}
   */
  sqrt() {
    const root = Complex.fromPolar(Math.sqrt(this.abs()), this.phi() / 2);
    if (root.re < 0) {
      return [root.neg(), root];
    }
    return [root, root.neg()];
  }

  /**
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  isZero(epsilon = EPSILON) {
    return this.abs2() <= epsilon * epsilon;
  }

  /**
   * A number is considered real when its imaginary part is negligible
   * compared to its magnitude.
   *
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  isReal(epsilon = 1e-6) {
    return Math.abs(this.im) <= epsilon * Math.max(1, Math.abs(this.re));
  }

  /**
   * @returns {boolean}
   */
  isFinite() {
    return Number.isFinite(this.re) && Number.isFinite(this.im);
  }

  /**
   * @param {number | Complex} other
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  equals(other, epsilon = EPSILON) {
    return this.sub(other).abs2() <= epsilon * epsilon;
  }

  /**
   * @returns {string}
   */
  toString() {
    if (this.im === 0) {
      return `${this.re}`;
    }
    if (this.re === 0) {
      return `${this.im}i`;
    }
    return this.im > 0 ? `${this.re}+${this.im}i` : `${this.re}${this.im}i`;
  }
}

const ZERO = new Complex(0);
const ONE = new Complex(1);
const I = new Complex(0, 1);
