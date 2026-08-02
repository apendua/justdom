import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { collapseWhitespace, groupIntoLines, preservesWhitespace } from "./textLines.js";

/**
 * Build the per-character rectangles a browser would report for a run of text
 * laid out on a single line, starting at `left` and advancing one unit per
 * character. Whitespace is marked blank unless the caller says otherwise.
 * @param {string} text
 * @param {object} options
 * @param {number} options.index Offset of the first character in the text node.
 * @param {number} options.left
 * @param {number} options.top
 * @param {boolean} [options.preserved]
 * @returns {import('./textLines.js').CharacterRect[]}
 */
function lineOf(text, { index, left, top, preserved = false }) {
  return Array.from(text, (char, offset) => ({
    index: index + offset,
    blank: !preserved && /\s/.test(char),
    left: left + offset,
    right: left + offset + 1,
    top,
    bottom: top + 10,
  }));
}

describe("preservesWhitespace", () => {
  test("only the pre-like values keep whitespace as authored", () => {
    assert.equal(preservesWhitespace("pre"), true);
    assert.equal(preservesWhitespace("pre-wrap"), true);
    assert.equal(preservesWhitespace("break-spaces"), true);
    assert.equal(preservesWhitespace("normal"), false);
    assert.equal(preservesWhitespace("nowrap"), false);
    assert.equal(preservesWhitespace("pre-line"), false);
  });
});

describe("collapseWhitespace", () => {
  test("collapses runs and trims the ends, as CSS does", () => {
    assert.equal(collapseWhitespace("  hello   world  ", "normal"), "hello world");
  });

  test("collapses the newlines and indentation of a template literal", () => {
    const authored = "\n            Trigger drags a piece,\n            grip pulls.\n          ";
    assert.equal(collapseWhitespace(authored, "normal"), "Trigger drags a piece, grip pulls.");
  });

  test("leaves pre-like text exactly as it was authored", () => {
    assert.equal(collapseWhitespace("  hello   world  ", "pre-wrap"), "  hello   world  ");
  });

  test("collapses within a line for pre-line, whose breaks are already lines", () => {
    assert.equal(collapseWhitespace("hello   world", "pre-line"), "hello world");
  });
});

describe("groupIntoLines", () => {
  test("keeps characters that share a baseline on one row", () => {
    const rows = groupIntoLines(lineOf("abc", { index: 0, left: 5, top: 0 }));
    assert.deepEqual(rows, [{ start: 0, end: 3, left: 5, right: 8, top: 0, bottom: 10 }]);
  });

  test("starts a new row for each line box", () => {
    const rows = groupIntoLines([
      ...lineOf("abc", { index: 0, left: 0, top: 0 }),
      ...lineOf("de", { index: 4, left: 0, top: 16 }),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [row.start, row.end, row.top]),
      [
        [0, 3, 0],
        [4, 6, 16],
      ],
    );
  });

  test("recovers a right-aligned line's own offset rather than the block's", () => {
    // The browser pushes the shorter second line further right; the row has to
    // report that offset, because it is what puts the line under the first one.
    const rows = groupIntoLines([
      ...lineOf("abcdef", { index: 0, left: 0, top: 0 }),
      ...lineOf("ghi", { index: 7, left: 3, top: 16 }),
    ]);
    assert.deepEqual(
      rows.map((row) => row.left),
      [0, 3],
    );
  });

  test("a space kept at the end of a wrapped line does not widen it", () => {
    const rows = groupIntoLines([
      ...lineOf("ab ", { index: 0, left: 0, top: 0 }),
      ...lineOf("cd", { index: 3, left: 0, top: 16 }),
    ]);
    assert.equal(rows[0].right, 2);
    assert.equal(rows[0].end, 3, "the trailing space still belongs to the line's text");
  });

  test("leading whitespace does not drag a line's left edge outwards", () => {
    const rows = groupIntoLines(lineOf(" ab", { index: 0, left: 0, top: 0 }));
    assert.equal(rows[0].left, 1);
    assert.equal(rows[0].right, 3);
  });

  test("preserved whitespace counts towards the extent", () => {
    const rows = groupIntoLines(lineOf(" ab", { index: 0, left: 0, top: 0, preserved: true }));
    assert.equal(rows[0].left, 0);
  });

  test("a line of nothing but collapsible whitespace still has an extent", () => {
    const rows = groupIntoLines(lineOf("  ", { index: 0, left: 4, top: 0 }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].left, 4);
    assert.equal(rows[0].right, 6);
  });

  test("sub-pixel differences in baseline do not split a row", () => {
    const rows = groupIntoLines([
      ...lineOf("ab", { index: 0, left: 0, top: 0 }),
      ...lineOf("cd", { index: 2, left: 2, top: 0.4 }),
    ]);
    assert.equal(rows.length, 1);
  });

  test("no rendered characters means no rows", () => {
    assert.deepEqual(groupIntoLines([]), []);
  });
});
