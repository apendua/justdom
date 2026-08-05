import Complex from "./Complex.js";
import Vec3 from "./Vec3.js";
import Line from "./Line.js";
import Point, { GEOMETRIC_EPSILON } from "./Point.js";

/**
 * @import Vec2 from "./Vec2.js"
 */

/**
 * A circle x^2 + y^2 + A*x*z + B*y*z + C*z^2 = 0, represented by the
 * coefficient vector (A, B, C).
 *
 * Note that unlike points and lines the representation is not homogeneous —
 * the quadratic terms are pinned to 1 — so the coefficients are not
 * normalized.
 */
export default class Circle {
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
    this.repr = repr;
  }

  /**
   * @param {Point} center
   * @param {number} radius
   * @returns {Circle}
   */
  static fromCenterAndRadius(center, radius) {
    const { x, y } = center.affine();
    return new Circle(
      new Vec3(
        x.mulByReal(-2),
        y.mulByReal(-2),
        x
          .mul(x)
          .add(y.mul(y))
          .sub(radius * radius),
      ),
    );
  }

  /**
   * @param {Point} center
   * @param {Point} through
   * @returns {Circle}
   */
  static fromCenterAndPoint(center, through) {
    const o = center.affine();
    const p = through.affine();
    // C is chosen so the circle passes through p:
    // p.x^2 + p.y^2 - 2*o.x*p.x - 2*o.y*p.y + C = 0
    return new Circle(
      new Vec3(
        o.x.mulByReal(-2),
        o.y.mulByReal(-2),
        p.x
          .mul(p.x)
          .add(p.y.mul(p.y))
          .sub(o.x.mul(p.x).mulByReal(2))
          .sub(o.y.mul(p.y).mulByReal(2))
          .neg(),
      ),
    );
  }

  /**
   * The circle through three points (that are not collinear).
   *
   * @param {Point} p
   * @param {Point} q
   * @param {Point} r
   * @returns {Circle}
   */
  static throughPoints(p, q, r) {
    const k = Line.bisector(p, q);
    const l = Line.bisector(q, r);
    return Circle.fromCenterAndPoint(k.intersectLine(l), q);
  }

  /**
   * @returns {Point}
   */
  center() {
    return Point.of(this.repr.x.mulByReal(-0.5), this.repr.y.mulByReal(-0.5));
  }

  /**
   * @returns {number}
   */
  radius() {
    const r2 = this.repr.x
      .mulByReal(-0.5)
      .mul(this.repr.x.mulByReal(-0.5))
      .add(this.repr.y.mulByReal(-0.5).mul(this.repr.y.mulByReal(-0.5)))
      .sub(this.repr.z);
    return r2.sqrt()[0].abs();
  }

  /**
   * Whether the circle has real coefficients and a real (non-degenerate)
   * radius.
   *
   * @returns {boolean}
   */
  isReal() {
    return this.repr.x.isReal() && this.repr.y.isReal() && this.repr.z.isReal();
  }

  /**
   * @param {Circle} other
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  equals(other, epsilon = GEOMETRIC_EPSILON) {
    return this.repr.sub(other.repr).norm() <= epsilon * Math.max(1, this.repr.norm());
  }

  /**
   * Evaluates the defining polynomial at a finite point.
   *
   * @param {Point} p
   * @returns {Complex}
   */
  evaluateAt(p) {
    const { x, y } = p.affine();
    return x.mul(x).add(y.mul(y)).add(this.repr.x.mul(x)).add(this.repr.y.mul(y)).add(this.repr.z);
  }

  /**
   * @param {Point} p
   * @param {number} [epsilon]
   * @returns {boolean}
   */
  goesThrough(p, epsilon = GEOMETRIC_EPSILON) {
    // Scale the tolerance by the circle's size so that large circles do not
    // reject points that are relatively as close as for small ones.
    const scale = Math.max(1, this.radius());
    return this.evaluateAt(p).abs() <= epsilon * scale * scale;
  }

  /**
   * Whether a finite real point lies inside the (closed) disk.
   *
   * @param {Point} p
   * @returns {boolean}
   */
  contains(p) {
    return p.distTo(this.center()) <= this.radius() + GEOMETRIC_EPSILON;
  }

  /**
   * The (up to two, possibly complex) intersection points with a line.
   *
   * @param {Line} line
   * @returns {Point[]}
   */
  intersectLine(line) {
    const a = line.repr.x;
    const b = line.repr.y;
    const c = line.repr.z;
    const A = this.repr.x;
    const B = this.repr.y;
    const C = this.repr.z;

    if (line.isAtInfinity()) {
      // Every circle meets the line at infinity at the circular points.
      return [
        new Point(new Vec3(Complex.one, Complex.i, Complex.zero)),
        new Point(new Vec3(Complex.one, Complex.i.neg(), Complex.zero)),
      ];
    }

    if (b.abs() >= a.abs()) {
      // Substitute y = -(a*x + c)/b into the circle equation:
      // (a^2+b^2) x^2 + (2ac - Aab + Bb^2·(-a/b)... — computed via the
      // eliminated slope form y = s*x + t with s = -a/b, t = -c/b:
      // (1+s^2) x^2 + (2st + A + Bs) x + (t^2 + Bt + C) = 0
      const s = a.div(b).neg();
      const t = c.div(b).neg();
      const qa = s.mul(s).add(1);
      const qb = s.mul(t).mulByReal(2).add(A).add(B.mul(s));
      const qc = t.mul(t).add(B.mul(t)).add(C);
      return Complex.solveQuadratic(qa, qb, qc).map((x) => Point.of(x, s.mul(x).add(t)));
    }
    // Symmetric case, x = s*y + t with s = -b/a, t = -c/a:
    // (1+s^2) y^2 + (2st + B + As) y + (t^2 + At + C) = 0
    const s = b.div(a).neg();
    const t = c.div(a).neg();
    const qa = s.mul(s).add(1);
    const qb = s.mul(t).mulByReal(2).add(B).add(A.mul(s));
    const qc = t.mul(t).add(A.mul(t)).add(C);
    return Complex.solveQuadratic(qa, qb, qc).map((y) => Point.of(s.mul(y).add(t), y));
  }

  /**
   * The (up to two, possibly complex) intersection points with another
   * circle, computed through the radical line.
   *
   * @param {Circle} other
   * @returns {Point[]}
   */
  intersectCircle(other) {
    const radical = new Line(this.repr.sub(other.repr));
    return this.intersectLine(radical);
  }

  /**
   * The absolute distance from a finite real point to the circle, used for
   * hit-testing.
   *
   * @param {Point} p
   * @returns {number}
   */
  distToPoint(p) {
    return Math.abs(p.distTo(this.center()) - this.radius());
  }

  /**
   * @returns {string}
   */
  toString() {
    return `x^2 + y^2 + ${this.repr.x}xz + ${this.repr.y}yz + ${this.repr.z}z^2 = 0`;
  }
}
