/**
 * Structured, span-based edits of euclid source code.
 *
 * The code text is the single source of truth for a construction, so
 * interactive tools do not manipulate a scene graph — they edit the code.
 * The helpers here produce those edits: appending construction steps and
 * rewriting coordinate literals in place (for dragging points), preserving
 * all surrounding formatting and comments.
 */

/**
 * @import { AssignmentNode, ExpressionNode, StatementNode } from "./parser.js"
 */

/**
 * Formats a coordinate for use in generated code.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatCoord(value) {
  const rounded = Math.round(value * 1000) / 1000;
  // Avoid "-0" in generated code.
  return `${rounded === 0 ? 0 : rounded}`;
}

/**
 * Picks the next free name: for points A, B, C, …, Z, A1, B1, …; for other
 * kinds prefix1, prefix2, … (e.g. l1, c1).
 *
 * @param {Iterable<string>} usedNames
 * @param {"point" | "line" | "circle"} kind
 * @returns {string}
 */
export function nextName(usedNames, kind) {
  const used = new Set(usedNames);
  if (kind === "point") {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let round = 0; ; round += 1) {
      for (const letter of letters) {
        const name = round === 0 ? letter : `${letter}${round}`;
        if (!used.has(name)) {
          return name;
        }
      }
    }
  }
  const prefix = kind === "line" ? "l" : "c";
  for (let i = 1; ; i += 1) {
    const name = `${prefix}${i}`;
    if (!used.has(name)) {
      return name;
    }
  }
}

/**
 * @param {string} name
 * @param {number} x
 * @param {number} y
 * @returns {string}
 */
export function pointStatement(name, x, y) {
  return `${name}=point(${formatCoord(x)}, ${formatCoord(y)});`;
}

/**
 * @param {string} name
 * @param {string} a Name of the first point.
 * @param {string} b Name of the second point.
 * @returns {string}
 */
export function lineStatement(name, a, b) {
  return `${name}=line(${a}, ${b});`;
}

/**
 * A circle centered at `center` through the point `through`, written with a
 * radius vector as in `circle(A, B-A)`.
 *
 * @param {string} name
 * @param {string} center Name of the center point.
 * @param {string} through Name of the point the circle passes through.
 * @returns {string}
 */
export function circleStatement(name, center, through) {
  return `${name}=circle(${center}, ${through}-${center});`;
}

/**
 * An intersection point of two objects. Two lines meet in a single point,
 * so no indexing is needed; when a circle is involved, the intersection is
 * an array and the point is selected by index.
 *
 * @param {string} name
 * @param {string} a Name of the first object.
 * @param {string} b Name of the second object.
 * @param {number | null} index Index into the intersection array, or null
 *   for the line-line case.
 * @returns {string}
 */
export function intersectionStatement(name, a, b, index) {
  if (index === null) {
    return `${name}=${a}.${b};`;
  }
  return `${name}=(${a}.${b})[${index}];`;
}

/**
 * Appends a statement on its own line at the end of the code.
 *
 * @param {string} code
 * @param {string} statement
 * @returns {string}
 */
export function appendStatement(code, statement) {
  if (code === "") {
    return `${statement}\n`;
  }
  return code.endsWith("\n") ? `${code}${statement}\n` : `${code}\n${statement}\n`;
}

/**
 * @typedef {object} NumberSpan
 * @property {number} start
 * @property {number} end
 * @property {number} value
 */

/**
 * Recognizes a numeric literal, possibly negated, and returns its span and
 * value. This is the shape of coordinates in `point(x, y)` calls.
 *
 * @param {ExpressionNode} node
 * @returns {NumberSpan | null}
 */
function numericLiteral(node) {
  if (node.kind === "number") {
    return { start: node.start, end: node.end, value: node.value };
  }
  if (node.kind === "unary" && node.op === "-" && node.operand.kind === "number") {
    return { start: node.start, end: node.end, value: -node.operand.value };
  }
  return null;
}

/**
 * Whether an assignment defines a point by literal coordinates, i.e. has the
 * form `A=point(<number>, <number>);` — the only kind of point the editor
 * can drag freely.
 *
 * @param {StatementNode} statement
 * @returns {statement is AssignmentNode}
 */
export function isFreePoint(statement) {
  if (statement.kind !== "assignment") {
    return false;
  }
  const { expression } = statement;
  return (
    expression.kind === "call" &&
    expression.callee.kind === "name" &&
    expression.callee.name === "point" &&
    expression.args.length === 2 &&
    expression.args.every((arg) => numericLiteral(arg) !== null)
  );
}

/**
 * Rewrites the coordinate literals of a free point assignment in place,
 * leaving the rest of the code untouched. Returns null when the statement
 * is not a free point definition.
 *
 * @param {string} code
 * @param {StatementNode} statement
 * @param {number} x
 * @param {number} y
 * @returns {string | null}
 */
export function movePoint(code, statement, x, y) {
  if (!isFreePoint(statement) || statement.expression.kind !== "call") {
    return null;
  }
  const [argX, argY] = statement.expression.args;
  const spanX = numericLiteral(argX);
  const spanY = numericLiteral(argY);
  if (!spanX || !spanY) {
    return null;
  }
  // Replace the later span first so the earlier offsets stay valid.
  return (
    code.slice(0, spanX.start) +
    formatCoord(x) +
    code.slice(spanX.end, spanY.start) +
    formatCoord(y) +
    code.slice(spanY.end)
  );
}

/**
 * Finds the statement whose source span contains the given offset.
 *
 * @param {StatementNode[]} statements
 * @param {number} offset
 * @returns {StatementNode | null}
 */
export function statementAt(statements, offset) {
  for (const statement of statements) {
    if (offset >= statement.start && offset <= statement.end) {
      return statement;
    }
  }
  return null;
}
