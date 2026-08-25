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
 *
 * Reading them back used to mean measuring every character, because a rect
 * says where a line is but not what is written on it. It does not have to:
 * the line a character landed on rises with its offset and never falls, so
 * the offset each line starts at can be found by bisection — a handful of
 * measurements per line instead of one per character, and the same answer.
 */

/**
 * One line box, as the vertical band it occupies. Horizontal extent is left
 * out on purpose: a line's own is measured from the text on it once its
 * offsets are known, which is what keeps a trailing space from widening it.
 *
 * @typedef {object} LineBox
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
 * Collect the rectangles a range reports into the line boxes they belong to.
 * A line usually reports one, but a line with both directions of text on it
 * reports one per run, so rectangles that share a band are merged into it.
 *
 * @param {ArrayLike<{ top: number, bottom: number }>} rects In document order,
 *   which is the order a range reports them in.
 * @returns {LineBox[]}
 */
export function groupLineBoxes(rects) {
  /** @type {LineBox[]} */
  const boxes = [];
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index];
    const height = rect.bottom - rect.top;
    if (height <= 0) {
      // A rectangle of no height is not a line box: an empty range reports
      // one, and so does a collapsed break.
      continue;
    }
    const current = boxes[boxes.length - 1];
    if (current && Math.abs(rect.top - current.top) < Math.max(1, height) / 2) {
      current.top = Math.min(current.top, rect.top);
      current.bottom = Math.max(current.bottom, rect.bottom);
      continue;
    }
    boxes.push({ top: rect.top, bottom: rect.bottom });
  }
  return boxes;
}

/**
 * Where each line box's text begins, as an offset into the text node.
 *
 * The search rests on one fact about line breaking: it runs over the text in
 * logical order, so a character can never land on an earlier line than one
 * before it. Bidi reorders a line's runs on screen but not the order they
 * were broken in, which is why lines are told apart by their vertical band
 * and nothing else. That makes "which line is this character on" monotone in
 * the offset, and a monotone question is a bisection: about log₂(length)
 * measurements per line, against one per character for a walk.
 *
 * Collapsed whitespace has no box to report, and `lineOf` says so by
 * answering null. The search steps forward to the next character that does
 * report one; the characters skipped are blanks, and a blank at a line
 * boundary is trimmed off both lines regardless of which one it is called
 * part of.
 *
 * @param {number} length How many characters the text node holds.
 * @param {number} lineCount How many line boxes it was laid out into.
 * @param {(index: number) => number | null} lineOf Which line box the
 *   character at an offset sits on, or null if it left no mark.
 * @returns {number[]} One offset per line box, ascending, starting at 0.
 */
export function findLineStarts(length, lineCount, lineOf) {
  const starts = [0];
  for (let line = 1; line < lineCount; line++) {
    let low = starts[line - 1] + 1;
    let high = length;
    while (low < high) {
      let at = (low + high) >> 1;
      let found = lineOf(at);
      while (found === null && at + 1 < high) {
        found = lineOf((at += 1));
      }
      if (found !== null && found >= line) {
        high = at;
      } else {
        low = at + 1;
      }
    }
    starts.push(low);
  }
  return starts;
}

/**
 * The stretch of a line that actually leaves a mark: its own text without the
 * whitespace the layout collapsed at either end. Measuring *this* is what
 * keeps a space kept at a wrap point from reporting a line wider than the
 * glyphs on it, and a line's leading indentation from dragging its left edge
 * out to where nothing is drawn.
 *
 * Preserved whitespace is part of the line and stays, save for the newline a
 * line ends with, which belongs to the break rather than to either side.
 *
 * @param {string} content
 * @param {number} from
 * @param {number} to
 * @param {boolean} preserved Whether `white-space` keeps runs as authored.
 * @returns {[start: number, end: number]} Empty when the line is all blank.
 */
export function trimLineRange(content, from, to, preserved) {
  let start = from;
  let end = to;
  if (preserved) {
    while (end > start && /[\r\n]/.test(content[end - 1])) {
      end -= 1;
    }
    return [start, end];
  }
  while (start < end && /\s/.test(content[start])) {
    start += 1;
  }
  while (end > start && /\s/.test(content[end - 1])) {
    end -= 1;
  }
  return [start, end];
}
