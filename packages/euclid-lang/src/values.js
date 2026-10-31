import { Point, Line, Circle, Vec2 } from "@apendua/euclid-core";

/**
 * A coordinate selector — the values bound to `x` and `y`. Applied to points
 * and vectors through the `.` operator, e.g. `A.x`.
 */
export class CoordSelector {
  /**
   * @param {"x" | "y"} name
   */
  constructor(name) {
    /**
     * @public
     * @readonly
     */
    this.name = name;
  }

  /**
   * Extracts the coordinate as a plain number. A non-real coordinate has no
   * meaningful value, so it maps to NaN — comparisons on it are then false,
   * which makes predicates in `pick` reject non-real candidates.
   *
   * @param {Point | Vec2} target
   * @returns {number}
   */
  apply(target) {
    const coord = target instanceof Point ? target.affine()[this.name] : target[this.name];
    return coord.isReal() ? coord.re : NaN;
  }
}

/**
 * A rotation — the value of `rot(angle)`. Applied to points, lines and
 * vectors through the `.` operator, e.g. `line(A,B).rot(90)`.
 */
export class Rotation {
  /**
   * @param {number} degrees
   */
  constructor(degrees) {
    /**
     * @public
     * @readonly
     */
    this.degrees = degrees;
  }

  get radians() {
    return (Math.PI * this.degrees) / 180;
  }
}

/**
 * A builtin function such as `point`, `line` or `circle`.
 */
export class Builtin {
  /**
   * @param {string} name
   * @param {(args: Value[]) => Value} apply
   */
  constructor(name, apply) {
    /**
     * @public
     * @readonly
     */
    this.name = name;

    /**
     * @public
     * @readonly
     */
    this.apply = apply;
  }
}

/**
 * @typedef {(
 *   | number
 *   | boolean
 *   | string
 *   | Point
 *   | Line
 *   | Circle
 *   | Vec2
 *   | CoordSelector
 *   | Rotation
 *   | Builtin
 * )} ScalarValue
 */

/**
 * A runtime value of the language. Arrays hold scalars — the language has
 * no syntax that produces nested arrays.
 *
 * @typedef {ScalarValue | ScalarValue[]} Value
 */

/**
 * @param {Value} value
 * @returns {value is Point | Line | Circle}
 */
export function isRenderable(value) {
  return value instanceof Point || value instanceof Line || value instanceof Circle;
}

/**
 * @param {Value} value
 * @returns {string}
 */
export function typeName(value) {
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (value instanceof Point) {
    return "point";
  }
  if (value instanceof Line) {
    return "line";
  }
  if (value instanceof Circle) {
    return "circle";
  }
  if (value instanceof Vec2) {
    return "vector";
  }
  if (value instanceof CoordSelector) {
    return "coordinate";
  }
  if (value instanceof Rotation) {
    return "rotation";
  }
  if (value instanceof Builtin) {
    return "function";
  }
  return "unknown";
}

/**
 * @param {Value} value
 * @returns {string}
 */
export function toDisplayString(value) {
  if (typeof value === "number") {
    return `${Math.round(value * 1e6) / 1e6}`;
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return `${value}`;
  }
  if (Array.isArray(value)) {
    return `{${value.map(toDisplayString).join(", ")}}`;
  }
  if (value instanceof Point) {
    if (value.isAtInfinity()) {
      return `point at infinity ${value.repr.toString()}`;
    }
    if (value.isReal()) {
      const { x, y } = value.affine();
      const round = (/** @type {number} */ n) => Math.round(n * 1e6) / 1e6;
      return `(${round(x.re)}, ${round(y.re)})`;
    }
    return `complex point ${value.repr.toString()}`;
  }
  return `[${typeName(value)}] ${String(value)}`;
}
