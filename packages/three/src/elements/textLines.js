/**
 * Helpers for recovering the line boxes a browser laid a text node out into.
 *
 * The renderer used to break lines itself, measuring candidate lines with the
 * canvas and dividing the block height by the line height to guess how many
 * lines would fit. Both halves of that were wrong in ways that showed up as
 * missing text: the guess is short by a line whenever `line-height` is larger
 * than the glyph box, and canvas measurement of a line drawn glyph by glyph
 * disagrees with the shaped width the browser broke on. Reading the line boxes
 * back off the layout instead means the wrapping, the alignment and the
 * whitespace collapsing are the browser's, and there is nothing left to
 * disagree with.
 */

/**
 * @typedef {object} CharacterRect
 * @property {number} index Offset of the character within the text node.
 * @property {boolean} blank Whether this character is collapsible whitespace.
 * @property {number} left
 * @property {number} right
 * @property {number} top
 * @property {number} bottom
 */

/**
 * @typedef {object} LineRow
 * @property {number} start Offset of the first rendered character on the line.
 * @property {number} end Offset just past the last rendered character.
 * @property {number} left
 * @property {number} right
 * @property {number} top
 * @property {number} bottom
 */

/**
 * @typedef {object} TextLine
 * @property {string} text
 * @property {number} left Offset from the left of the text block's bounding box.
 * @property {number} top Offset from the top of the text block's bounding box.
 * @property {number} width
 * @property {number} height
 */

/**
 * Whether a `white-space` value keeps runs of whitespace as they were authored.
 * @param {string} whiteSpace
 * @returns {boolean}
 */
export function preservesWhitespace(whiteSpace) {
  return whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "break-spaces";
}

/**
 * Collapse a single line's worth of text the way CSS would. Line breaking has
 * already happened by the time this is called, so `pre-line` only has to
 * collapse the runs of spaces that `normal` collapses too.
 * @param {string} text
 * @param {string} whiteSpace
 * @returns {string}
 */
export function collapseWhitespace(text, whiteSpace) {
  if (preservesWhitespace(whiteSpace)) {
    return text;
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Group per-character rectangles into rows, one per line box. Characters come
 * in document order, so a row ends as soon as a character sits on a different
 * baseline.
 *
 * Rows measure their horizontal extent from the characters that leave a mark:
 * a space kept at the end of a wrapped line hangs past the text it follows, and
 * counting it would report a line wider than the glyphs actually drawn.
 * @param {CharacterRect[]} rects
 * @returns {LineRow[]}
 */
export function groupIntoLines(rects) {
  /** @type {LineRow[]} */
  const rows = [];
  /** @type {boolean[]} */
  const rowHasInk = [];

  for (const rect of rects) {
    const row = rows[rows.length - 1];
    const height = Math.max(1, rect.bottom - rect.top);
    const continuesRow = row !== undefined && Math.abs(rect.top - row.top) < height / 2;

    if (!continuesRow) {
      rows.push({
        start: rect.index,
        end: rect.index + 1,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      });
      rowHasInk.push(!rect.blank);
      continue;
    }

    row.end = rect.index + 1;
    row.top = Math.min(row.top, rect.top);
    row.bottom = Math.max(row.bottom, rect.bottom);

    const inkOnly = rowHasInk[rows.length - 1];
    if (rect.blank && inkOnly) {
      // Whitespace never widens a row that already has glyphs on it.
      continue;
    }
    if (!rect.blank && !inkOnly) {
      // First glyph after a run of leading whitespace: restart the extent.
      row.left = rect.left;
      row.right = rect.right;
      rowHasInk[rows.length - 1] = true;
      continue;
    }
    row.left = Math.min(row.left, rect.left);
    row.right = Math.max(row.right, rect.right);
  }

  return rows;
}
