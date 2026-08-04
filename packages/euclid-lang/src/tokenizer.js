/**
 * @typedef {(
 *   | "number"
 *   | "name"
 *   | "string"
 *   | "operator"
 *   | "comment"
 * )} TokenType
 */

/**
 * @typedef {object} Token
 * @property {TokenType} type
 * @property {string} text The raw source text of the token.
 * @property {number} [value] The numeric value, for number tokens.
 * @property {number} start Offset of the first character.
 * @property {number} end Offset one past the last character.
 * @property {number} line 1-based line number of the first character.
 * @property {number} column 1-based column number of the first character.
 */

/**
 * Keywords are tokenized as names; the parser gives them meaning. Listed here
 * so that syntax highlighting can color them without running the parser.
 */
export const KEYWORDS = new Set(["draw", "print", "pick", "in", "on", "not", "and", "or", "all"]);

/**
 * Names bound by the standard environment; also exposed for highlighting.
 */
export const BUILTINS = new Set([
  "point",
  "line",
  "circle",
  "rot",
  "inf",
  "true",
  "false",
  "x",
  "y",
]);

const MULTI_CHAR_OPERATORS = ["==", "!=", "<=", ">="];

/**
 * @param {string} char
 * @returns {boolean}
 */
function isDigit(char) {
  return char >= "0" && char <= "9";
}

/**
 * @param {string} char
 * @returns {boolean}
 */
function isNameStart(char) {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
}

/**
 * @param {string} char
 * @returns {boolean}
 */
function isNameChar(char) {
  return isNameStart(char) || isDigit(char);
}

/**
 * Splits code into tokens. Whitespace is skipped; comments are kept (with
 * type "comment") so that highlighting and pretty printing can use them —
 * the parser filters them out.
 *
 * Never throws: unexpected characters come out as single-character operator
 * tokens and are rejected by the parser instead.
 *
 * @param {string} code
 * @returns {Token[]}
 */
export function tokenize(code) {
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  /**
   * @param {TokenType} type
   * @param {number} start
   * @param {number} startLine
   * @param {number} startColumn
   */
  const push = (type, start, startLine, startColumn) => {
    const text = code.slice(start, i);
    /** @type {Token} */
    const token = {
      type,
      text,
      start,
      end: i,
      line: startLine,
      column: startColumn,
    };
    if (type === "number") {
      token.value = Number(text);
    }
    tokens.push(token);
  };

  while (i < code.length) {
    const start = i;
    const startLine = line;
    const startColumn = start - lineStart + 1;
    const char = code[i];

    if (char === "\n") {
      i += 1;
      line += 1;
      lineStart = i;
    } else if (char === " " || char === "\t" || char === "\r") {
      i += 1;
    } else if (isDigit(char)) {
      while (i < code.length && isDigit(code[i])) {
        i += 1;
      }
      if (code[i] === "." && isDigit(code[i + 1])) {
        i += 1;
        while (i < code.length && isDigit(code[i])) {
          i += 1;
        }
      }
      push("number", start, startLine, startColumn);
    } else if (isNameStart(char)) {
      while (i < code.length && isNameChar(code[i])) {
        i += 1;
      }
      push("name", start, startLine, startColumn);
    } else if (char === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") {
        i += 1;
      }
      push("comment", start, startLine, startColumn);
    } else if (char === '"') {
      i += 1;
      while (i < code.length && code[i] !== '"') {
        i += code[i] === "\\" ? 2 : 1;
      }
      if (i < code.length) {
        i += 1;
      }
      push("string", start, startLine, startColumn);
    } else {
      const pair = code.slice(i, i + 2);
      i += MULTI_CHAR_OPERATORS.includes(pair) ? 2 : 1;
      push("operator", start, startLine, startColumn);
    }
  }

  return tokens;
}
