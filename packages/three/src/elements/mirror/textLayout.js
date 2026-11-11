import {
  buildCharacterEdges,
  collapseLineOffsets,
  collapseWhitespace,
  findLineStarts,
  groupLineBoxes,
  preservesWhitespace,
  trimLineRange,
} from "../textLines.js";
import { frameFor, measureClientRect, measureClientRects, measureRunRect } from "../panelFrame.js";
import { readClientRect } from "./geometryReads.js";

/**
 * @import {RevealLayout, RevealLine, TextLine} from '../textLines.js';
 * @import {FramedRect, PanelFrame} from '../panelFrame.js';
 * @import {TextLayout} from '../mirror.js';
 */

/**
 * The one Range every text measurement is made with.
 *
 * A Range is live: the document keeps every one it hands out and updates
 * its boundary points on every mutation — a removed node moves them to the
 * parent, rewritten character data shifts the offsets. Creating one per
 * measurement and dropping it, still pointing into the text it measured,
 * left a mount of eight hundred labels with up to eight hundred stale
 * ranges for every mutation to walk until the collector got to them — the
 * hover writes a moving ray makes at frame rate included. One shared range
 * makes that one.
 *
 * It also closes a small leak on the transformed path: a measurement clone
 * is appended to the body and removed, and the floating range kept the
 * removed subtree reachable until it was collected. After each measurement
 * the range is pointed at the document itself, where nothing in a panel can
 * move it and nothing is held.
 *
 * Safe to share because every measurement is synchronous: nothing between
 * `selectNodeContents` and the last rect read yields to anything that could
 * measure.
 *
 * @type {Range | null}
 */
let measuringRange = null;

/**
 * @returns {Range}
 */
function getMeasuringRange() {
  if (!measuringRange) {
    measuringRange = document.createRange();
  }
  return measuringRange;
}

/**
 * Tests only: forget the shared range, so a test that stands in for
 * `document.createRange` is handed the stand-in on the next measurement
 * rather than a real range made before the stand-in was installed.
 *
 * @returns {void}
 */
export function resetMeasuringRangeForTests() {
  measuringRange = null;
}

/**
 * Measure with the shared range (`getMeasuringRange`), and let go of what it
 * measured afterwards. Every text measurement goes through this, an SVG
 * `<text>`'s included (`measureRuns` in `svg/text.js`).
 *
 * @template R
 * @param {(range: Range) => R} measure Synchronous, and making no
 *   measurement of its own through this.
 * @returns {R}
 */
export function withMeasuringRange(measure) {
  const range = getMeasuringRange();
  try {
    return measure(range);
  } finally {
    // Let go of the node. The document has children, so offset 0 is a valid
    // point in it, and it is one that nothing inside a panel can disturb.
    range.setStart(document, 0);
    range.setEnd(document, 0);
  }
}

/**
 * @param {Text} text
 * @param {HTMLElement} parentElement
 * @param {string} whiteSpace
 * @param {boolean} scrolled
 * @param {boolean} revealed
 * @returns {TextLayout}
 */
export function measureTextRects(text, parentElement, whiteSpace, scrolled, revealed) {
  return withMeasuringRange((range) =>
    measureTextRectsWith(range, text, parentElement, whiteSpace, scrolled, revealed),
  );
}

/**
 * The measuring core: line boxes and parent-relative position of one text
 * node, read off whatever tree the node currently sits in.
 *
 * A range already knows where the browser broke the text — `getClientRects`
 * reports the line boxes, wrapping and all — and what it does not say is
 * which characters landed on each of them. That is recovered by bisection
 * rather than by measuring every character: see `findLineStarts`. What it
 * costs is a handful of measurements per line, where a walk cost one per
 * character; on a wrapped paragraph in Chromium the difference was 2.2ms and
 * 0.5ms, per measurement.
 *
 * @param {Range} range The shared range — see `getMeasuringRange`.
 * @param {Text} text
 * @param {HTMLElement} parentElement
 * @param {string} whiteSpace
 * @param {boolean} scrolled Whether to fold the parent's scroll offset in —
 *   true against the live tree, false against a clone, which is never
 *   scrolled and already reports layout positions.
 * @param {boolean} revealed Whether to measure character boundaries too.
 * @returns {TextLayout}
 */
function measureTextRectsWith(range, text, parentElement, whiteSpace, scrolled, revealed) {
  const content = text.textContent || "";
  // The live tree's frame is its panel's; a clone's is the body it is
  // appended to.
  const frame = frameFor(parentElement);
  // Against the live tree the parent's rect is shareable. A copy is none of
  // the panel's nodes, so its rect is read directly, once for each text
  // measured in it, even though a line box copy stands for many of them.
  const parentRect = scrolled
    ? readClientRect(parentElement)
    : measureClientRect(parentElement, frame);
  range.selectNodeContents(text);
  const boundsRect = measureClientRect(range, frame);
  const left = boundsRect.left - parentRect.left + (scrolled ? parentElement.scrollLeft || 0 : 0);
  const top = boundsRect.top - parentRect.top + (scrolled ? parentElement.scrollTop || 0 : 0);
  // Size alone: where the text sits is already said by `left` and `top`, in
  // the content-space terms the mirror draws in, and a fresh identity per
  // measurement would re-run the rasterizer for every visible label on
  // every frame that moved anything.
  const bounds = { width: boundsRect.width, height: boundsRect.height };

  const boxes = groupLineBoxes(measureClientRects(range, frame));
  if (boxes.length === 0) {
    // Empty, or not laid out at all. Either way there is nothing to draw,
    // and in particular nothing that should be drawn at the origin instead.
    return { bounds, left, top, lines: [], reveal: revealed ? EMPTY_REVEAL : null };
  }

  // The overwhelmingly common case is a label on a single line, which the
  // bounding box already describes — and describes for free, the rectangle
  // having been read already.
  if (boxes.length === 1) {
    const single = revealed
      ? collapseLineOffsets(content, 0, content.length, whiteSpace)
      : { text: collapseWhitespace(content, whiteSpace), offsets: [] };
    const lines = single.text
      ? [{ text: single.text, left: 0, top: 0, width: bounds.width, height: bounds.height }]
      : [];
    return {
      bounds,
      left,
      top,
      lines,
      reveal: revealed
        ? measureRevealLayout(
            text,
            range,
            frame,
            boundsRect,
            lines,
            lines.length ? [single.offsets] : [],
          )
        : null,
    };
  }

  const preserved = preservesWhitespace(whiteSpace);
  const starts = findLineStarts(content.length, boxes.length, (index) => {
    range.setStart(text, index);
    range.setEnd(text, index + 1);
    const rect = measureRunRect(range, frame);
    if (rect.width <= 0 && rect.height <= 0) {
      // Whitespace the layout collapsed away occupies no space and sits on
      // no line box.
      return null;
    }
    // Compared at the character's middle rather than its top: a line mixing
    // sizes or scripts leaves its shorter glyphs sitting inside the band
    // rather than at the top of it.
    const middle = (rect.top + rect.bottom) / 2;
    for (let line = boxes.length - 1; line > 0; line--) {
      if (middle >= boxes[line].top) {
        return line;
      }
    }
    return 0;
  });

  const lines = [];
  /** @type {number[][]} */
  const offsets = [];
  for (let line = 0; line < starts.length; line++) {
    const until = line + 1 < starts.length ? starts[line + 1] : content.length;
    const [from, to] = trimLineRange(content, starts[line], until, preserved);
    if (from >= to) {
      // A line with nothing on it but the whitespace that ended the one
      // before it, or the blank line a `pre` block is entitled to.
      continue;
    }
    const collapsed = revealed
      ? collapseLineOffsets(content, from, to, whiteSpace)
      : { text: collapseWhitespace(content.slice(from, to), whiteSpace), offsets: [] };
    const value = collapsed.text;
    if (!value) {
      continue;
    }
    if (revealed) {
      offsets.push(collapsed.offsets);
    }
    // One rectangle per line, over the text the line actually draws, so the
    // extent is the browser's own shaping — kerning included — rather than a
    // union of per-character boxes.
    range.setStart(text, from);
    range.setEnd(text, to);
    const rect = measureRunRect(range, frame);
    lines.push({
      text: value,
      left: rect.left - boundsRect.left,
      top: rect.top - boundsRect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  return {
    bounds,
    left,
    top,
    lines,
    reveal: revealed ? measureRevealLayout(text, range, frame, boundsRect, lines, offsets) : null,
  };
}

/** @type {RevealLayout} */
const EMPTY_REVEAL = { length: 0, lines: [] };

/**
 * The second half of a revealed run's measurement: for each line, the x of
 * every boundary between the characters drawn on it.
 *
 * One range read per character, which is the honest cost of the thing and the
 * reason it is opt-in — but paid once per *layout*, not once per keystroke,
 * which is the whole point. Everything a cursor moving does afterwards is
 * arithmetic over what this returned.
 *
 * @param {Text} text
 * @param {Range} range Reused, and left pointing wherever the last read put it.
 * @param {PanelFrame} frame What the text is measured in.
 * @param {FramedRect} boundsRect What the other positions are relative to.
 * @param {TextLine[]} lines The lines actually drawn, in document order.
 * @param {number[][]} offsets Where each line's rendered characters sit in
 *   the node's data, one array per line of `lines`.
 * @returns {RevealLayout}
 */
function measureRevealLayout(text, range, frame, boundsRect, lines, offsets) {
  /** @type {RevealLine[]} */
  const revealLines = [];
  let start = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineOffsets = offsets[index];
    const count = lineOffsets.length;
    const edges = buildCharacterEdges(count, (at) => {
      range.setStart(text, lineOffsets[at]);
      range.setEnd(text, lineOffsets[at] + 1);
      const rect = measureRunRect(range, frame);
      if (rect.width <= 0 && rect.height <= 0) {
        return null;
      }
      return [rect.left - boundsRect.left, rect.right - boundsRect.left];
    });
    revealLines.push({
      start,
      length: count,
      top: line.top,
      bottom: line.top + line.height,
      edges,
    });
    start += count;
  }
  return { length: start, lines: revealLines };
}
