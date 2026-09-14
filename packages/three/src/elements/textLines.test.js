import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCharacterEdges,
  collapseLineOffsets,
  collapseWhitespace,
  findLineStarts,
  groupLineBoxes,
  preservesWhitespace,
  trimLineRange,
} from "./textLines.js";

/**
 * A layout engine small enough to assert against: it breaks `text` at spaces
 * into lines of at most `width` characters, and answers the two questions a
 * range would — which line boxes there are, and which of them a character
 * landed on — while counting how often it was asked.
 *
 * @param {string} text
 * @param {number} width
 */
function layOut(text, width) {
  /** @type {number[]} */
  const lineOfIndex = new Array(text.length).fill(-1);
  let line = 0;
  let column = 0;
  for (let index = 0; index < text.length; index++) {
    const wordEnd = text.indexOf(" ", index);
    if (text[index] === " ") {
      // A space at a break is collapsed away and lands on no line at all.
      if (column === 0) {
        continue;
      }
      lineOfIndex[index] = line;
      column += 1;
      continue;
    }
    if (column > 0) {
      const wordLength = (wordEnd === -1 ? text.length : wordEnd) - index;
      if (column + wordLength > width) {
        line += 1;
        column = 0;
      }
    }
    lineOfIndex[index] = line;
    column += 1;
  }

  let probes = 0;
  return {
    lineCount: line + 1,
    get probes() {
      return probes;
    },
    /** @param {number} index */
    lineOf(index) {
      probes += 1;
      return lineOfIndex[index] === -1 ? null : lineOfIndex[index];
    },
    /** The answer the search is supposed to arrive at. */
    starts() {
      /** @type {number[]} */
      const starts = [];
      for (let index = 0; index < text.length; index++) {
        if (lineOfIndex[index] !== -1 && lineOfIndex[index] === starts.length) {
          starts.push(index);
        }
      }
      return starts;
    },
  };
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

describe("groupLineBoxes", () => {
  test("one rectangle per line becomes one box per line", () => {
    const boxes = groupLineBoxes([
      { top: 0, bottom: 10 },
      { top: 10, bottom: 20 },
      { top: 20, bottom: 30 },
    ]);
    assert.deepEqual(boxes, [
      { top: 0, bottom: 10 },
      { top: 10, bottom: 20 },
      { top: 20, bottom: 30 },
    ]);
  });

  test("a line reported as several runs is still one line", () => {
    // What a range reports for a line with both directions of text on it.
    const boxes = groupLineBoxes([
      { top: 0, bottom: 10 },
      { top: 0, bottom: 12 },
      { top: 12, bottom: 22 },
    ]);
    assert.deepEqual(boxes, [
      { top: 0, bottom: 12 },
      { top: 12, bottom: 22 },
    ]);
  });

  test("sub-pixel differences in baseline do not split a line", () => {
    const boxes = groupLineBoxes([
      { top: 0, bottom: 10 },
      { top: 0.4, bottom: 10.4 },
    ]);
    assert.equal(boxes.length, 1);
  });

  test("nothing laid out is no lines", () => {
    assert.deepEqual(groupLineBoxes([]), []);
  });
});

describe("findLineStarts", () => {
  test("finds where each line begins, and skips the space that ended the last", () => {
    const text = "one two three four five six seven eight nine ten";
    const layout = layOut(text, 12);
    const starts = findLineStarts(text.length, layout.lineCount, (i) => layout.lineOf(i));
    assert.deepEqual(starts, layout.starts());
    assert.deepEqual(
      starts.map((start, line) =>
        text.slice(start, line + 1 < starts.length ? starts[line + 1] : text.length).trimEnd(),
      ),
      ["one two", "three four", "five six", "seven eight", "nine ten"],
    );
  });

  test("asks about a handful of characters per line rather than all of them", () => {
    // The point of the whole exercise: bisection, not a walk. Ten times the
    // text costs a few more questions per line, not ten times as many.
    const text = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do ".repeat(10);
    const layout = layOut(text, 40);
    findLineStarts(text.length, layout.lineCount, (i) => layout.lineOf(i));
    assert.ok(
      layout.probes < text.length / 4,
      `expected far fewer than ${text.length} probes, got ${layout.probes}`,
    );
  });

  test("a single line is answered without asking anything", () => {
    const layout = layOut("no wrapping here", 40);
    assert.deepEqual(
      findLineStarts(16, 1, (i) => layout.lineOf(i)),
      [0],
    );
    assert.equal(layout.probes, 0);
  });

  test("text with no spaces to break at is split all the same", () => {
    // `overflow-wrap: anywhere`, or a script that does not write spaces:
    // every offset is a break opportunity and the search never sees one.
    const lineOfIndex = (/** @type {number} */ index) => Math.floor(index / 7);
    const starts = findLineStarts(28, 4, lineOfIndex);
    assert.deepEqual(starts, [0, 7, 14, 21]);
  });

  test("a run of collapsed whitespace at a break belongs to neither line", () => {
    // Indices 4, 5 and 6 report nothing at all; the line begins after them.
    const lineOfIndex = (/** @type {number} */ index) => {
      if (index >= 4 && index <= 6) {
        return null;
      }
      return index < 4 ? 0 : 1;
    };
    assert.deepEqual(findLineStarts(12, 2, lineOfIndex), [0, 7]);
  });
});

describe("trimLineRange", () => {
  test("drops the whitespace collapsed at either end of a line", () => {
    const content = "one two  three";
    assert.deepEqual(trimLineRange(content, 0, 9, false), [0, 7]);
    assert.deepEqual(trimLineRange(content, 7, 14, false), [9, 14]);
  });

  test("keeps preserved whitespace, save for the newline that ended the line", () => {
    const content = "  kept  \nnext";
    assert.deepEqual(trimLineRange(content, 0, 9, true), [0, 8]);
  });

  test("a line of nothing but collapsible whitespace comes back empty", () => {
    assert.deepEqual(trimLineRange("a    b", 1, 5, false), [5, 5]);
  });
});

describe("collapseLineOffsets", () => {
  test("renders exactly what collapseWhitespace renders", () => {
    for (const content of ["one two", "  one   two  ", "a\nb", "   ", "", "one  two  three"]) {
      for (const whiteSpace of ["normal", "pre", "pre-wrap", "nowrap"]) {
        assert.equal(
          collapseLineOffsets(content, 0, content.length, whiteSpace).text,
          collapseWhitespace(content, whiteSpace),
          `${JSON.stringify(content)} as ${whiteSpace}`,
        );
      }
    }
  });

  test("a collapsed run of blanks is measured at the one character that was drawn", () => {
    const content = "one   two";
    const { text, offsets } = collapseLineOffsets(content, 0, content.length, "normal");
    assert.equal(text, "one two");
    // o n e _ t w o — the space maps to the first of the three, which is the
    // one the layout gave a box to.
    assert.deepEqual(offsets, [0, 1, 2, 3, 6, 7, 8]);
    assert.equal(offsets.length, text.length);
  });

  test("blanks at either end are not rendered and so are not mapped", () => {
    const content = "  hi  ";
    const { text, offsets } = collapseLineOffsets(content, 0, content.length, "normal");
    assert.equal(text, "hi");
    assert.deepEqual(offsets, [2, 3]);
  });

  test("preserved whitespace maps one to one, over the range asked for", () => {
    const content = "  kept  ";
    const { text, offsets } = collapseLineOffsets(content, 2, 6, "pre");
    assert.equal(text, "kept");
    assert.deepEqual(offsets, [2, 3, 4, 5]);
  });
});

describe("buildCharacterEdges", () => {
  /**
   * @param {Array<number[] | null>} rects
   * @returns {(index: number) => [number, number] | null}
   */
  const from = (rects) => (index) => {
    const rect = rects[index];
    return rect ? /** @type {[number, number]} */ ([rect[0], rect[1]]) : null;
  };

  test("a boundary per character, plus the end of the line", () => {
    const edges = buildCharacterEdges(
      3,
      from([
        [0, 10],
        [10, 20],
        [20, 33],
      ]),
    );
    assert.deepEqual([...(edges ?? [])], [0, 10, 20, 33]);
  });

  test("a boundary that does not advance is snapped forward past the cluster", () => {
    // A ligature over the first two characters: the boundary between them
    // reports the rect the pair does, so it has not moved. Left alone, the
    // first keystroke into it would draw nothing.
    const edges = buildCharacterEdges(
      3,
      from([
        [0, 14],
        [0, 14],
        [14, 24],
      ]),
    );
    assert.deepEqual([...(edges ?? [])], [0, 14, 14, 24]);
  });

  test("a run of boundaries that all stand still takes the next one that moves", () => {
    const edges = buildCharacterEdges(
      4,
      from([
        [0, 30],
        [0, 30],
        [0, 30],
        [30, 40],
      ]),
    );
    assert.deepEqual([...(edges ?? [])], [0, 30, 30, 30, 40]);
  });

  test("a character that left no box shares the advance of the one beside it", () => {
    // The same shape as a ligature, seen from the other end: two characters
    // over one advance, and a boundary between them that cannot move. It is
    // snapped forward like any other, so the pair is revealed together.
    const edges = buildCharacterEdges(3, from([[0, 10], null, [10, 20]]));
    assert.deepEqual([...(edges ?? [])], [0, 10, 20, 20]);
  });

  test("boundaries that run right to left are read from the right", () => {
    // Three characters of a right-to-left line: the first one read sits at
    // the right end, so the edges descend — and the line is still cuttable.
    const edges = buildCharacterEdges(
      3,
      from([
        [22, 35],
        [12, 22],
        [2, 12],
      ]),
    );
    assert.deepEqual([...(edges ?? [])], [35, 22, 12, 2]);
  });

  test("a cluster on a right-to-left line is snapped forward the same way", () => {
    // The same ligature case, read the other way round: the boundary between
    // the first two characters has not moved, so it takes the next one that
    // did — which on this line is further *left*.
    const edges = buildCharacterEdges(
      3,
      from([
        [21, 35],
        [21, 35],
        [11, 21],
      ]),
    );
    assert.deepEqual([...(edges ?? [])], [35, 21, 21, 11]);
  });

  test("boundaries that run backwards are refused rather than approximated", () => {
    // Both directions on one line: the prefix of it is not a rectangle, and
    // there is no x that says where to cut.
    assert.equal(
      buildCharacterEdges(
        3,
        from([
          [0, 10],
          [30, 40],
          [20, 30],
        ]),
      ),
      null,
    );
  });

  test("a line of one character still has two boundaries", () => {
    const edges = buildCharacterEdges(1, from([[4, 12]]));
    assert.deepEqual([...(edges ?? [])], [4, 12]);
  });
});
