/**
 * @import {TextBounds} from '../textHelpers.js';
 * @import {TextLine} from '../textLines.js';
 */

/**
 * The most a band of text covers, in square CSS px. A text node whose lines
 * cover more is drawn as several runs, each a band of whole lines within
 * this, so that no one raster and no one upload is larger than a band's.
 *
 * At the top step of the ladder a px is sixteen texels, which makes a band
 * about a megabyte. The screen of a terminal 421 px across and 345 px tall
 * was one raster of 9.3 MB there, and on a Quest it took 22 ms to draw and
 * 16 ms to upload, each longer than a frame. A guess until a headset says
 * what a megabyte costs.
 */
export const BAND_AREA = 16384;

/**
 * One band of a text node's lines: what one run draws.
 *
 * @typedef {object} TextBand
 * @property {number} top Where the band's raster starts, below the top of
 *   the node's bounds, in CSS px. Under the first line's top by `room` for
 *   a node in more than one band.
 * @property {TextLine[]} lines The band's lines, placed relative to `top`.
 * @property {TextBounds} bounds The node's width, and the band's height.
 */

/**
 * @param {TextLine[]} a
 * @param {TextLine[]} b
 * @returns {boolean}
 */
function sameLines(a, b) {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index++) {
    const x = a[index];
    const y = b[index];
    if (
      x.text !== y.text ||
      x.left !== y.left ||
      x.top !== y.top ||
      x.width !== y.width ||
      x.height !== y.height
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Cut a text node's lines into bands.
 *
 * The rules:
 *
 * - Lines that cover no more than `area` are one band, which is the node as
 *   it was measured: its lines, its bounds, and no room above.
 * - Otherwise the lines are taken from the top, and a band ends before the
 *   line that would take its height times the node's width past `area`. A
 *   band has at least one line, so a single line wider than `area` allows
 *   is a band larger than `area`. A line is never cut.
 * - Every band is as wide as the node, so bands of as many lines of one
 *   height come out one size, and the text batch keeps them in one array
 *   (`SizeClass` in `textBatch.js`).
 * - A band of a node in more than one starts `room` above its first line,
 *   for ink that reaches up out of a line, which a text shadow does. The
 *   raster of a node in one band is cut at the node's top, as it always
 *   was.
 * - A band equal to the one `previous` has at its index is that object, and
 *   an array of the same bands is `previous` itself. A band is equal when
 *   its top, its bounds and its lines are, so a node one of whose lines
 *   changed hands back every other band as it was.
 *
 * @param {TextLine[]} lines The node's lines, top to bottom.
 * @param {TextBounds} bounds The node's bounds.
 * @param {number} room How far ink reaches above a line, in CSS px.
 * @param {readonly TextBand[]} [previous] What the last cut returned.
 * @param {number} [area]
 * @returns {readonly TextBand[]}
 */
export function cutIntoBands(lines, bounds, room, previous = [], area = BAND_AREA) {
  /** @type {TextBand[]} */
  const bands = [];
  if (bounds.width * bounds.height <= area || lines.length < 2) {
    bands.push({ top: 0, lines, bounds });
  } else {
    let first = 0;
    while (first < lines.length) {
      const top = lines[first].top - room;
      let end = first + 1;
      while (
        end < lines.length &&
        (lines[end].top + lines[end].height - top) * bounds.width <= area
      ) {
        end += 1;
      }
      // The last band runs to the bottom of the node's bounds, as the one
      // raster did, and every other to the bottom of its last line.
      const bottom =
        end === lines.length ? bounds.height : lines[end - 1].top + lines[end - 1].height;
      /** @type {TextLine[]} */
      const taken = [];
      for (let index = first; index < end; index++) {
        const line = lines[index];
        taken.push({
          text: line.text,
          left: line.left,
          top: line.top - top,
          width: line.width,
          height: line.height,
        });
      }
      bands.push({ top, lines: taken, bounds: { width: bounds.width, height: bottom - top } });
      first = end;
    }
  }

  let same = bands.length === previous.length;
  for (let index = 0; index < bands.length; index++) {
    const band = bands[index];
    const before = previous[index];
    if (
      before &&
      before.top === band.top &&
      before.bounds.width === band.bounds.width &&
      before.bounds.height === band.bounds.height &&
      sameLines(before.lines, band.lines)
    ) {
      bands[index] = before;
    } else {
      same = false;
    }
  }
  return same ? previous : bands;
}
