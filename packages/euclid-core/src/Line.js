import Vec3 from "./Vec3.js";
import Vec2 from "./Vec2.js";
import Point, { GEOMETRIC_EPSILON } from "./Point.js";

/**
 * @import Complex from "./Complex.js"
 */

/**
 * A line on the complex projective plane, represented by normalized
 * homogeneous coefficients (a : b : c) of a*x + b*y + c*z = 0.
 */
export default class Line {
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
   * @param {number | Complex} a
   * @param {number | Complex} b
   * @param {number | Complex} c
   * @returns {Line}
   */
  static of(a, b, c) {
    return new Line(new Vec3(a, b, c));
  }

  /**
   * @returns {Line}
   */
  static atInfinity() {
    return Line.of(0, 0, 1);
  }

  /**
   * @param {Point} p
   * @param {Point} q
   * @returns {Line}
   */
  static throughPoints(p, q) {
    return new Line(p.repr.cross(q.repr));
  }

  /**
   * The perpendicular bisector of the segment between two finite points.
   *
   * @param {Point} p
   * @param {Point} q
   * @returns {Line}
   */
  static bisector(p, q) {
    return Line.throughPoints(p, q).perpendicularThrough(p.combine(q, 0.5));
  }

  /**
   * @returns {boolean}
   */
  isAtInfinity() {
    return Math.max(this.repr.x.abs(), this.repr.y.abs()) <= GEOMETRIC_EPSILON;
  }

  /**
   * Whether the line has real coefficients (up to a complex scale).
   *
   * @returns {boolean}
   */
  isReal() {
    const { x, y, z } = this.repr;
    let pivot = x;
    for (const c of [y, z]) {
      if (c.abs() > pivot.abs()) {
        pivot = c;
      }
    }
    if (pivot.abs() === 0) {
      return false;
    }
    return x.div(pivot).isReal() && y.div(pivot).isReal() && z.div(pivot).isReal();
  }

  /**
   * @param {Line} other
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  equals(other, epsilon = GEOMETRIC_EPSILON) {
    return this.repr.isParallel(other.repr, epsilon);
  }

  /**
   * @param {Point} p
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  goesThrough(p, epsilon = GEOMETRIC_EPSILON) {
    return this.repr.dot(p.repr).abs() <= epsilon;
  }

  /**
   * @param {Line} other
   * @returns {Point}
   */
  intersectLine(other) {
    return new Point(this.repr.cross(other.repr));
  }

  /**
   * The point at infinity in the direction of the line.
   *
   * @returns {Point}
   */
  pointAtInfinity() {
    return new Point(new Vec3(this.repr.y.neg(), this.repr.x, 0));
  }

  /**
   * The point at infinity in the direction of the line's normal.
   *
   * @returns {Point}
   */
  dualPointAtInfinity() {
    return new Point(new Vec3(this.repr.x, this.repr.y, 0));
  }

  /**
   * @param {Point} p
   * @returns {Line}
   */
  parallelThrough(p) {
    return Line.throughPoints(this.pointAtInfinity(), p);
  }

  /**
   * @param {Point} p
   * @returns {Line}
   */
  perpendicularThrough(p) {
    return Line.throughPoints(this.dualPointAtInfinity(), p);
  }

  /**
   * Rotates the line around the origin by the given angle (radians).
   *
   * @param {number} angle
   * @returns {Line}
   */
  rotate(angle) {
    // Under rotation R the coefficient pair (a, b) rotates along with the
    // plane while c is unchanged: the image line is (R(a, b), c).
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const { x, y, z } = this.repr;
    return new Line(
      new Vec3(x.mulByReal(cos).sub(y.mulByReal(sin)), x.mulByReal(sin).add(y.mulByReal(cos)), z),
    );
  }

  /**
   * The Euclidean distance from a finite real point to the (real) line.
   *
   * @param {Point} p
   * @returns {number}
   */
  distToPoint(p) {
    const { x, y } = p.affine();
    const a = this.repr.x.re;
    const b = this.repr.y.re;
    const c = this.repr.z.re;
    const n = Math.hypot(a, b);
    if (n === 0) {
      return Infinity;
    }
    return Math.abs(a * x.re + b * y.re + c) / n;
  }

  /**
   * The two endpoints of the visible part of a real line inside a rectangle,
   * or undefined when the line misses it (or is not drawable).
   *
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} bounds
   * @returns {[{ x: number, y: number }, { x: number, y: number }] | undefined}
   */
  clipToRect(bounds) {
    const a = this.repr.x.re;
    const b = this.repr.y.re;
    const c = this.repr.z.re;
    if (Math.hypot(a, b) <= GEOMETRIC_EPSILON) {
      return undefined;
    }
    /** @type {{ x: number, y: number }[]} */
    const hits = [];
    /**
     * @param {number} x
     * @param {number} y
     */
    const push = (x, y) => {
      if (
        x >= bounds.minX - GEOMETRIC_EPSILON &&
        x <= bounds.maxX + GEOMETRIC_EPSILON &&
        y >= bounds.minY - GEOMETRIC_EPSILON &&
        y <= bounds.maxY + GEOMETRIC_EPSILON &&
        !hits.some((h) => Math.hypot(h.x - x, h.y - y) < 1e-9)
      ) {
        hits.push({ x, y });
      }
    };
    if (Math.abs(b) > GEOMETRIC_EPSILON) {
      push(bounds.minX, -(a * bounds.minX + c) / b);
      push(bounds.maxX, -(a * bounds.maxX + c) / b);
    }
    if (Math.abs(a) > GEOMETRIC_EPSILON) {
      push(-(b * bounds.minY + c) / a, bounds.minY);
      push(-(b * bounds.maxY + c) / a, bounds.maxY);
    }
    if (hits.length < 2) {
      return undefined;
    }
    return [hits[0], hits[1]];
  }

  /**
   * The orthogonal projection of a finite real point onto the line.
   *
   * @param {Point} p
   * @returns {Point}
   */
  project(p) {
    return this.intersectLine(this.perpendicularThrough(p));
  }

  /**
   * A real direction vector of the line.
   *
   * @returns {Vec2}
   */
  direction() {
    return new Vec2(this.repr.y.neg(), this.repr.x);
  }

  /**
   * @returns {string}
   */
  toString() {
    return `${this.repr.x}x + ${this.repr.y}y + ${this.repr.z}z = 0`;
  }
}
