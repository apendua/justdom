import { Point, Line, Circle, Vec2 } from "@apendua/euclid-core";
import {
  Builtin,
  CoordSelector,
  Rotation,
  isRenderable,
  typeName,
  toDisplayString,
} from "./values.js";

/**
 * @import { ExpressionNode, StatementNode, Span } from "./parser.js"
 * @import { Value } from "./values.js"
 */

/**
 * @typedef {object} Definition
 * @property {string} name
 * @property {Value} value
 * @property {StatementNode} statement The assignment that (last) defined the name.
 * @property {number} order Position of the defining statement.
 */

/**
 * @typedef {object} DrawnItem
 * @property {Value} value
 * @property {Record<string, Value>} options
 * @property {StatementNode} statement
 */

/**
 * @typedef {object} RuntimeErrorInfo
 * @property {string} message
 * @property {number} start
 * @property {number} end
 */

/**
 * @typedef {object} Evaluation
 * @property {Map<string, Definition>} definitions
 * @property {DrawnItem[]} drawn
 * @property {boolean} drawAll
 * @property {{ message: string, statement: StatementNode }[]} printed
 * @property {RuntimeErrorInfo | null} error
 */

class RuntimeError extends Error {
  /**
   * @param {string} message
   * @param {Span} span
   */
  constructor(message, span) {
    super(message);
    this.start = span.start;
    this.end = span.end;
  }
}

/**
 * @param {string} message
 * @param {Span} span
 * @returns {never}
 */
function fail(message, span) {
  throw new RuntimeError(message, span);
}

/**
 * @param {Value[]} args
 * @param {Span} span
 * @returns {Value}
 */
function makePoint(args, span) {
  if (args.length === 2 && typeof args[0] === "number" && typeof args[1] === "number") {
    return Point.of(args[0], args[1]);
  }
  return fail("point() expects two numbers.", span);
}

/**
 * @param {Value[]} args
 * @param {Span} span
 * @returns {Value}
 */
function makeLine(args, span) {
  if (args.length === 2 && args[0] instanceof Point && args[1] instanceof Point) {
    return Line.throughPoints(args[0], args[1]);
  }
  return fail("line() expects two points.", span);
}

/**
 * @param {Value[]} args
 * @param {Span} span
 * @returns {Value}
 */
function makeCircle(args, span) {
  if (args.length === 2 && args[0] instanceof Point) {
    const center = args[0];
    const second = args[1];
    if (second instanceof Vec2) {
      return Circle.fromCenterAndPoint(center, center.translate(second));
    }
    if (second instanceof Point) {
      return Circle.fromCenterAndPoint(center, second);
    }
    if (typeof second === "number") {
      return Circle.fromCenterAndRadius(center, second);
    }
  }
  if (
    args.length === 3 &&
    args[0] instanceof Point &&
    args[1] instanceof Point &&
    args[2] instanceof Point
  ) {
    return Circle.throughPoints(args[0], args[1], args[2]);
  }
  return fail(
    "circle() expects (center, vector), (center, point), (center, radius) or three points.",
    span,
  );
}

/**
 * The standard environment: builtin constructors and constants.
 *
 * @returns {Map<string, Value>}
 */
export function standardEnvironment() {
  /** @type {Map<string, Value>} */
  const env = new Map();
  env.set("true", true);
  env.set("false", false);
  env.set("inf", Line.atInfinity());
  env.set("x", new CoordSelector("x"));
  env.set("y", new CoordSelector("y"));
  env.set("point", new Builtin("point", (args) => makePoint(args, { start: 0, end: 0 })));
  env.set("line", new Builtin("line", (args) => makeLine(args, { start: 0, end: 0 })));
  env.set("circle", new Builtin("circle", (args) => makeCircle(args, { start: 0, end: 0 })));
  env.set(
    "rot",
    new Builtin("rot", (args) => {
      if (args.length === 1 && typeof args[0] === "number") {
        return new Rotation(args[0]);
      }
      throw new Error("rot() expects an angle in degrees.");
    }),
  );
  return env;
}

/**
 * Applies the overloaded `.` operator, mirroring the typed dispatch of the
 * original euclid compiler:
 *
 * - `A.x`, `A.y` — coordinates of a point (or vector),
 * - `l.rot(90)` — rotation applied to a line, point or vector,
 * - `l.m` — the intersection point of two lines,
 * - `c.l`, `l.c`, `c1.c2` — the intersection points (an array) when a circle
 *   is involved.
 *
 * @param {Value} left
 * @param {Value} right
 * @param {Span} span
 * @returns {Value}
 */
function applyDot(left, right, span) {
  if (right instanceof CoordSelector) {
    if (left instanceof Point) {
      if (left.isAtInfinity()) {
        return fail("A point at infinity has no coordinates.", span);
      }
      return right.apply(left);
    }
    if (left instanceof Vec2) {
      return right.apply(left);
    }
    return fail(`Cannot read coordinate of ${typeName(left)}.`, span);
  }
  if (right instanceof Rotation) {
    if (left instanceof Point) {
      return left.rotate(right.radians);
    }
    if (left instanceof Line) {
      return left.rotate(right.radians);
    }
    if (left instanceof Vec2) {
      return left.rotate(right.radians);
    }
    return fail(`Cannot rotate ${typeName(left)}.`, span);
  }
  if (left instanceof Line && right instanceof Line) {
    return left.intersectLine(right);
  }
  if (left instanceof Circle && right instanceof Line) {
    return left.intersectLine(right);
  }
  if (left instanceof Line && right instanceof Circle) {
    return right.intersectLine(left);
  }
  if (left instanceof Circle && right instanceof Circle) {
    return left.intersectCircle(right);
  }
  return fail(`Cannot apply "." to ${typeName(left)} and ${typeName(right)}.`, span);
}

/**
 * @param {string} op
 * @param {Value} a
 * @param {Value} b
 * @param {Span} span
 * @returns {Value}
 */
function applyBinary(op, a, b, span) {
  switch (op) {
    case "+": {
      if (typeof a === "number" && typeof b === "number") {
        return a + b;
      }
      if (a instanceof Vec2 && b instanceof Vec2) {
        return a.add(b);
      }
      if (a instanceof Point && b instanceof Vec2) {
        return a.translate(b);
      }
      if (a instanceof Vec2 && b instanceof Point) {
        return b.translate(a);
      }
      break;
    }
    case "-": {
      if (typeof a === "number" && typeof b === "number") {
        return a - b;
      }
      if (a instanceof Vec2 && b instanceof Vec2) {
        return a.sub(b);
      }
      if (a instanceof Point && b instanceof Point) {
        // A - B is the vector from B to A.
        if (a.isAtInfinity() || b.isAtInfinity()) {
          return fail("Cannot subtract points at infinity.", span);
        }
        return b.vectorTo(a);
      }
      if (a instanceof Point && b instanceof Vec2) {
        return a.translate(b.neg());
      }
      break;
    }
    case "*": {
      if (typeof a === "number" && typeof b === "number") {
        return a * b;
      }
      if (typeof a === "number" && b instanceof Vec2) {
        return b.mul(a);
      }
      if (a instanceof Vec2 && typeof b === "number") {
        return a.mul(b);
      }
      if (a instanceof Vec2 && b instanceof Vec2) {
        const product = a.dot(b);
        return product.isReal() ? product.re : NaN;
      }
      break;
    }
    case "/": {
      if (typeof a === "number" && typeof b === "number") {
        return a / b;
      }
      if (a instanceof Vec2 && typeof b === "number") {
        return a.div(b);
      }
      break;
    }
    case "<":
    case ">":
    case "<=":
    case ">=": {
      if (typeof a === "number" && typeof b === "number") {
        switch (op) {
          case "<":
            return a < b;
          case ">":
            return a > b;
          case "<=":
            return a <= b;
          default:
            return a >= b;
        }
      }
      break;
    }
    case "==":
    case "!=": {
      const equal = valuesEqual(a, b, span);
      return op === "==" ? equal : !equal;
    }
    case "in": {
      if (a instanceof Point && b instanceof Circle) {
        return a.isFinite() && a.isReal() && b.contains(a);
      }
      break;
    }
    case "on": {
      if (a instanceof Point && b instanceof Circle) {
        return b.goesThrough(a);
      }
      if (a instanceof Point && b instanceof Line) {
        return b.goesThrough(a);
      }
      break;
    }
    default:
      break;
  }
  return fail(`Cannot apply "${op}" to ${typeName(a)} and ${typeName(b)}.`, span);
}

/**
 * @param {Value} a
 * @param {Value} b
 * @param {Span} span
 * @returns {boolean}
 */
function valuesEqual(a, b, span) {
  if (typeof a === "number" && typeof b === "number") {
    return a === b;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }
  if (a instanceof Point && b instanceof Point) {
    return a.equals(b);
  }
  if (a instanceof Line && b instanceof Line) {
    return a.equals(b);
  }
  if (a instanceof Circle && b instanceof Circle) {
    return a.equals(b);
  }
  if (a instanceof Vec2 && b instanceof Vec2) {
    return a.equals(b);
  }
  return fail(`Cannot compare ${typeName(a)} and ${typeName(b)}.`, span);
}

/**
 * Evaluates a parsed program. Never throws — a runtime error is reported
 * through the `error` field together with everything evaluated up to that
 * point, so a partially valid construction still renders.
 *
 * @param {StatementNode[]} statements
 * @returns {Evaluation}
 */
export function evaluate(statements) {
  const env = standardEnvironment();

  /** @type {Map<string, Definition>} */
  const definitions = new Map();

  /** @type {Map<string, Value>[]} */
  const scopes = [];

  /** @type {DrawnItem[]} */
  const drawn = [];

  /** @type {{ message: string, statement: StatementNode }[]} */
  const printed = [];

  let drawAll = false;

  /**
   * @param {string} name
   * @param {Span} span
   * @returns {Value}
   */
  const lookup = (name, span) => {
    for (let i = scopes.length - 1; i >= 0; i -= 1) {
      const value = scopes[i].get(name);
      if (value !== undefined) {
        return value;
      }
    }
    const definition = definitions.get(name);
    if (definition) {
      return definition.value;
    }
    const builtin = env.get(name);
    if (builtin !== undefined) {
      return builtin;
    }
    return fail(`Variable "${name}" is not defined.`, span);
  };

  /**
   * @param {ExpressionNode} node
   * @returns {Value}
   */
  const evaluateExpression = (node) => {
    switch (node.kind) {
      case "number":
        return node.value;
      case "string":
        return node.value;
      case "name":
        return lookup(node.name, node);
      case "array":
        // Array items are scalars in practice; nesting has no syntax.
        return /** @type {import("./values.js").ScalarValue[]} */ (
          node.items.map(evaluateExpression)
        );
      case "unary": {
        const operand = evaluateExpression(node.operand);
        if (node.op === "-") {
          if (typeof operand === "number") {
            return -operand;
          }
          if (operand instanceof Vec2) {
            return operand.neg();
          }
          return fail(`Cannot negate ${typeName(operand)}.`, node);
        }
        if (node.op === "not") {
          if (typeof operand === "boolean") {
            return !operand;
          }
          return fail(`Cannot apply "not" to ${typeName(operand)}.`, node);
        }
        return fail(`Unknown unary operator "${node.op}".`, node);
      }
      case "binary": {
        if (node.op === "and" || node.op === "or") {
          const left = evaluateExpression(node.left);
          if (typeof left !== "boolean") {
            return fail(`Cannot apply "${node.op}" to ${typeName(left)}.`, node.left);
          }
          if (node.op === "and" ? !left : left) {
            return left;
          }
          const right = evaluateExpression(node.right);
          if (typeof right !== "boolean") {
            return fail(`Cannot apply "${node.op}" to ${typeName(right)}.`, node.right);
          }
          return right;
        }
        if (node.op === ".") {
          return applyDot(evaluateExpression(node.left), evaluateExpression(node.right), node);
        }
        return applyBinary(
          node.op,
          evaluateExpression(node.left),
          evaluateExpression(node.right),
          node,
        );
      }
      case "call": {
        const callee = evaluateExpression(node.callee);
        if (!(callee instanceof Builtin)) {
          return fail(`${typeName(callee)} is not a function.`, node);
        }
        const args = node.args.map(evaluateExpression);
        try {
          return callee.apply(args);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error), node);
        }
      }
      case "index": {
        const object = evaluateExpression(node.object);
        const index = evaluateExpression(node.index);
        if (!Array.isArray(object)) {
          return fail(`Cannot index ${typeName(object)}.`, node);
        }
        if (typeof index !== "number" || !Number.isInteger(index)) {
          return fail("Array index must be an integer.", node.index);
        }
        if (index < 0 || index >= object.length) {
          return fail(
            `Index ${index} is out of range; the array has ${object.length} element(s).`,
            node,
          );
        }
        return object[index];
      }
      case "pick": {
        const source = evaluateExpression(node.source);
        const candidates = Array.isArray(source) ? source : [source];
        /** @type {RuntimeError | null} */
        let predicateError = null;
        for (const candidate of candidates) {
          scopes.push(new Map([[node.name.name, candidate]]));
          try {
            const verdict = evaluateExpression(node.predicate);
            if (verdict === true) {
              return candidate;
            }
          } catch (thrown) {
            // A candidate the predicate cannot even evaluate on (say, a point
            // at infinity when the predicate reads coordinates) simply does
            // not match; keep looking. The error resurfaces only if nothing
            // matches at all.
            if (!(thrown instanceof RuntimeError)) {
              throw thrown;
            }
            predicateError = predicateError ?? thrown;
          } finally {
            scopes.pop();
          }
        }
        if (predicateError) {
          throw predicateError;
        }
        return fail("pick found no matching value.", node);
      }
      default:
        return fail("Unsupported expression.", node);
    }
  };

  /** @type {RuntimeErrorInfo | null} */
  let error = null;

  for (let order = 0; order < statements.length; order += 1) {
    const statement = statements[order];
    try {
      if (statement.kind === "assignment") {
        const value = evaluateExpression(statement.expression);
        definitions.set(statement.name.name, {
          name: statement.name.name,
          value,
          statement,
          order,
        });
      } else if (statement.kind === "draw") {
        if (!statement.expression) {
          drawAll = true;
        } else {
          const value = evaluateExpression(statement.expression);
          /** @type {Record<string, Value>} */
          const options = {};
          for (const option of statement.options) {
            options[option.key] = evaluateExpression(option.value);
          }
          if (!isRenderable(value) && !Array.isArray(value)) {
            fail(`Cannot draw ${typeName(value)}.`, statement);
          }
          drawn.push({ value, options, statement });
        }
      } else if (statement.kind === "print") {
        const value = evaluateExpression(statement.expression);
        printed.push({ message: toDisplayString(value), statement });
      }
    } catch (thrown) {
      if (thrown instanceof RuntimeError) {
        error = { message: thrown.message, start: thrown.start, end: thrown.end };
        break;
      }
      throw thrown;
    }
  }

  return { definitions, drawn, drawAll, printed, error };
}
