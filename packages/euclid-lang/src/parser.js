import { tokenize, KEYWORDS } from "./tokenizer.js";

/**
 * @import { Token } from "./tokenizer.js"
 */

/**
 * @typedef {object} Span
 * @property {number} start
 * @property {number} end
 */

/**
 * @typedef {Span & { kind: "number", value: number }} NumberNode
 * @typedef {Span & { kind: "string", value: string }} StringNode
 * @typedef {Span & { kind: "name", name: string }} NameNode
 * @typedef {Span & { kind: "unary", op: string, operand: ExpressionNode }} UnaryNode
 * @typedef {Span & { kind: "binary", op: string, left: ExpressionNode, right: ExpressionNode }} BinaryNode
 * @typedef {Span & { kind: "call", callee: ExpressionNode, args: ExpressionNode[] }} CallNode
 * @typedef {Span & { kind: "index", object: ExpressionNode, index: ExpressionNode }} IndexNode
 * @typedef {Span & { kind: "array", items: ExpressionNode[] }} ArrayNode
 * @typedef {Span & { kind: "pick", name: NameNode, source: ExpressionNode, predicate: ExpressionNode }} PickNode
 */

/**
 * @typedef {(
 *   | NumberNode
 *   | StringNode
 *   | NameNode
 *   | UnaryNode
 *   | BinaryNode
 *   | CallNode
 *   | IndexNode
 *   | ArrayNode
 *   | PickNode
 * )} ExpressionNode
 */

/**
 * @typedef {object} DrawOption
 * @property {string} key
 * @property {ExpressionNode} value
 */

/**
 * @typedef {Span & { kind: "assignment", name: NameNode, expression: ExpressionNode }} AssignmentNode
 * @typedef {Span & { kind: "draw", expression: ExpressionNode | null, options: DrawOption[] }} DrawNode
 * @typedef {Span & { kind: "print", expression: ExpressionNode }} PrintNode
 */

/**
 * @typedef {AssignmentNode | DrawNode | PrintNode} StatementNode
 */

/**
 * @typedef {object} ParseError
 * @property {string} message
 * @property {number} start
 * @property {number} end
 * @property {number} line
 */

/**
 * @typedef {object} ParseResult
 * @property {StatementNode[]} statements Statements parsed before the first error.
 * @property {ParseError | null} error
 */

/**
 * The binding powers of infix operators.
 *
 * @type {Record<string, number>}
 */
const INFIX_BINDING_POWER = {
  or: 2,
  and: 3,
  "==": 4,
  "!=": 4,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  in: 4,
  on: 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  ".": 7,
  "(": 8,
  "[": 8,
};

class SyntaxError_ extends Error {
  /**
   * @param {string} message
   * @param {number} start
   * @param {number} end
   * @param {number} line
   */
  constructor(message, start, end, line) {
    super(message);
    this.start = start;
    this.end = end;
    this.line = line;
  }
}

/**
 * Parses code into a list of statements. Never throws — a syntax error is
 * reported through the `error` field alongside the statements that were
 * successfully parsed before it.
 *
 * @param {string} code
 * @returns {ParseResult}
 */
export function parse(code) {
  const tokens = tokenize(code).filter((token) => token.type !== "comment");
  let position = 0;

  /**
   * @returns {Token | undefined}
   */
  const peek = () => tokens[position];

  /**
   * @param {Token | undefined} token
   * @returns {never}
   */
  const unexpectedEnd = (token) => {
    const at = token ?? tokens[tokens.length - 1];
    throw new SyntaxError_(
      "Unexpected end of input.",
      at ? at.start : code.length,
      at ? at.end : code.length,
      at ? at.line : 1,
    );
  };

  /**
   * @param {string} [expectedText]
   * @returns {Token}
   */
  const next = (expectedText) => {
    const token = tokens[position];
    if (!token) {
      return unexpectedEnd(token);
    }
    if (expectedText !== undefined && token.text !== expectedText) {
      throw new SyntaxError_(
        `Expected "${expectedText}", got "${token.text}".`,
        token.start,
        token.end,
        token.line,
      );
    }
    position += 1;
    return token;
  };

  /**
   * @param {string} text
   * @returns {boolean}
   */
  const lookingAt = (text) => {
    const token = peek();
    return !!token && token.text === text;
  };

  /**
   * @param {Token} token
   * @returns {never}
   */
  const unexpected = (token) => {
    throw new SyntaxError_(`Unexpected "${token.text}".`, token.start, token.end, token.line);
  };

  /**
   * @returns {ExpressionNode}
   */
  const parsePrefix = () => {
    const token = next();
    if (token.type === "number") {
      return { kind: "number", value: token.value ?? 0, start: token.start, end: token.end };
    }
    if (token.type === "string") {
      let value = token.text;
      try {
        value = JSON.parse(token.text);
      } catch {
        // Keep the raw text of an unterminated string.
      }
      return { kind: "string", value, start: token.start, end: token.end };
    }
    if (token.type === "name") {
      if (token.text === "not") {
        const operand = parseExpression(3);
        return { kind: "unary", op: "not", operand, start: token.start, end: operand.end };
      }
      if (token.text === "pick") {
        const nameToken = next();
        if (nameToken.type !== "name" || KEYWORDS.has(nameToken.text)) {
          unexpected(nameToken);
        }
        /** @type {NameNode} */
        const name = {
          kind: "name",
          name: nameToken.text,
          start: nameToken.start,
          end: nameToken.end,
        };
        next("in");
        const source = parseExpression(0);
        next(":");
        const predicate = parseExpression(0);
        return { kind: "pick", name, source, predicate, start: token.start, end: predicate.end };
      }
      if (KEYWORDS.has(token.text)) {
        unexpected(token);
      }
      return { kind: "name", name: token.text, start: token.start, end: token.end };
    }
    if (token.text === "-") {
      const operand = parseExpression(6);
      return { kind: "unary", op: "-", operand, start: token.start, end: operand.end };
    }
    if (token.text === "(") {
      const expression = parseExpression(0);
      next(")");
      return expression;
    }
    if (token.text === "{") {
      /** @type {ExpressionNode[]} */
      const items = [];
      if (!lookingAt("}")) {
        items.push(parseExpression(0));
        while (lookingAt(",")) {
          next(",");
          items.push(parseExpression(0));
        }
      }
      const close = next("}");
      return { kind: "array", items, start: token.start, end: close.end };
    }
    return unexpected(token);
  };

  /**
   * @param {number} rbp
   * @returns {ExpressionNode}
   */
  const parseExpression = (rbp) => {
    let left = parsePrefix();
    for (;;) {
      const token = peek();
      if (!token) {
        return left;
      }
      const lbp = INFIX_BINDING_POWER[token.text];
      if (lbp === undefined || lbp <= rbp) {
        return left;
      }
      next();
      if (token.text === "(") {
        /** @type {ExpressionNode[]} */
        const args = [];
        if (!lookingAt(")")) {
          args.push(parseExpression(0));
          while (lookingAt(",")) {
            next(",");
            args.push(parseExpression(0));
          }
        }
        const close = next(")");
        left = { kind: "call", callee: left, args, start: left.start, end: close.end };
      } else if (token.text === "[") {
        const index = parseExpression(0);
        const close = next("]");
        left = { kind: "index", object: left, index, start: left.start, end: close.end };
      } else {
        const right = parseExpression(token.text === "or" || token.text === "and" ? lbp - 1 : lbp);
        left = {
          kind: "binary",
          op: token.text,
          left,
          right,
          start: left.start,
          end: right.end,
        };
      }
    }
  };

  /**
   * @returns {StatementNode}
   */
  const parseStatement = () => {
    const token = peek();
    if (!token) {
      return unexpectedEnd(token);
    }
    if (token.text === "draw") {
      next();
      if (lookingAt("all")) {
        next("all");
        const semi = next(";");
        return { kind: "draw", expression: null, options: [], start: token.start, end: semi.end };
      }
      const expression = parseExpression(0);
      /** @type {DrawOption[]} */
      const options = [];
      if (lookingAt(":")) {
        next(":");
        for (;;) {
          const keyToken = next();
          if (keyToken.type !== "name") {
            unexpected(keyToken);
          }
          next("=");
          // Comma separates options here, so parse just above its precedence.
          const value = parseExpression(1);
          options.push({ key: keyToken.text, value });
          if (!lookingAt(",")) {
            break;
          }
          next(",");
        }
      }
      const semi = next(";");
      return { kind: "draw", expression, options, start: token.start, end: semi.end };
    }
    if (token.text === "print") {
      next();
      const expression = parseExpression(0);
      const semi = next(";");
      return { kind: "print", expression, start: token.start, end: semi.end };
    }
    if (token.type === "name" && !KEYWORDS.has(token.text)) {
      const nameToken = next();
      /** @type {NameNode} */
      const name = {
        kind: "name",
        name: nameToken.text,
        start: nameToken.start,
        end: nameToken.end,
      };
      next("=");
      const expression = parseExpression(0);
      const semi = next(";");
      return { kind: "assignment", name, expression, start: nameToken.start, end: semi.end };
    }
    return unexpected(token);
  };

  /** @type {StatementNode[]} */
  const statements = [];
  try {
    while (position < tokens.length) {
      // Tolerate stray semicolons between statements.
      if (lookingAt(";")) {
        next(";");
        continue;
      }
      statements.push(parseStatement());
    }
  } catch (error) {
    if (error instanceof SyntaxError_) {
      return {
        statements,
        error: {
          message: error.message,
          start: error.start,
          end: error.end,
          line: error.line,
        },
      };
    }
    throw error;
  }
  return { statements, error: null };
}
