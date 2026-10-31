import { PNG } from "pngjs";

/**
 * Comparing two photographs of the same scene, and asking simple questions of
 * one.
 *
 * A pixel counts as changed only if a channel moved further than the eye
 * would call the same colour, and an image counts as changed only if enough
 * pixels did. Both numbers are measured rather than guessed: photographing
 * the frozen scene twice in this renderer moves exactly zero pixels, so the
 * budgets below are slack for a rasterizer that is less steady, not room the
 * scene is known to need.
 */

/**
 * Comparing a photograph against a stored one. The budget is a few hundred
 * pixels — under a tenth of a percent of the frame — which is less than the
 * smallest specimen in the motion panel covers, and far less than a border,
 * a label or a panel.
 */
export const BASELINE = { channelTolerance: 24, maxRatio: 0.0005 };

/**
 * Asking whether anything at all happened between two photographs. No budget:
 * a still scene is still to the pixel, so one pixel of movement is movement.
 */
export const MOVEMENT = { channelTolerance: 24, maxRatio: 0 };

/**
 * @typedef {object} Comparison
 * @property {boolean} same
 * @property {number} changed How many pixels differ beyond the tolerance.
 * @property {number} ratio Those pixels as a fraction of the image.
 * @property {string} [reason] Why the images could not be compared at all.
 * @property {Buffer} [diff] PNG marking what moved, when something did.
 */

/**
 * @param {Buffer} actual PNG bytes.
 * @param {Buffer} expected PNG bytes.
 * @param {object} [options]
 * @param {number} [options.channelTolerance] How far a channel may drift, 0–255.
 * @param {number} [options.maxRatio] How much of the image may drift that far.
 * @returns {Comparison}
 */
export function comparePng(actual, expected, options = BASELINE) {
  const { channelTolerance = BASELINE.channelTolerance, maxRatio = BASELINE.maxRatio } = options;
  const a = PNG.sync.read(actual);
  const b = PNG.sync.read(expected);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      same: false,
      changed: Infinity,
      ratio: 1,
      reason: `sizes differ: ${a.width}x${a.height} against ${b.width}x${b.height}`,
    };
  }

  const diff = new PNG({ width: a.width, height: a.height });
  let changed = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    const drift = Math.max(
      Math.abs(a.data[index] - b.data[index]),
      Math.abs(a.data[index + 1] - b.data[index + 1]),
      Math.abs(a.data[index + 2] - b.data[index + 2]),
    );
    const moved = drift > channelTolerance;
    if (moved) {
      changed += 1;
    }
    // What changed in magenta, what did not as a dim ghost of the baseline,
    // so a diff can be read on its own.
    diff.data[index] = moved ? 255 : b.data[index] >> 2;
    diff.data[index + 1] = moved ? 0 : b.data[index + 1] >> 2;
    diff.data[index + 2] = moved ? 255 : b.data[index + 2] >> 2;
    diff.data[index + 3] = 255;
  }

  const ratio = changed / (a.width * a.height);
  return {
    same: ratio <= maxRatio,
    changed,
    ratio,
    diff: PNG.sync.write(diff),
  };
}

/**
 * How much of an image is not the page's own background — the share of it
 * that something was actually drawn on.
 *
 * @param {Buffer} png
 * @param {object} [options]
 * @param {[number, number, number]} [options.background] The colour to discount.
 * @param {number} [options.tolerance]
 * @returns {number} 0 to 1.
 */
export function inkRatio(png, { background = [20, 22, 29], tolerance = 12 } = {}) {
  const image = PNG.sync.read(png);
  let ink = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const drift = Math.max(
      Math.abs(image.data[index] - background[0]),
      Math.abs(image.data[index + 1] - background[1]),
      Math.abs(image.data[index + 2] - background[2]),
    );
    if (drift > tolerance) {
      ink += 1;
    }
  }
  return ink / (image.width * image.height);
}

/**
 * How many pixels of an image are within reach of a colour.
 *
 * Used to ask whether the scene is wearing the colours its stylesheet asked
 * for — the question behind a text mask that forgot its tint, which draws
 * every label white and is invisible to anything that only counts pixels.
 *
 * @param {Buffer} png
 * @param {[number, number, number]} colour
 * @param {number} [tolerance]
 * @returns {number} A count, not a ratio: an accent is meant to be rare.
 */
export function countNear(png, colour, tolerance = 40) {
  return countWhere(png, (r, g, b) => {
    const drift = Math.max(
      Math.abs(r - colour[0]),
      Math.abs(g - colour[1]),
      Math.abs(b - colour[2]),
    );
    return drift <= tolerance;
  });
}

/**
 * How many pixels of an image pass a test of their colour.
 *
 * For a colour that is only known by its hue: a label seen through a
 * translucent card is the label's colour mixed with the card's, in whichever
 * space the renderer blends in.
 *
 * @param {Buffer} png
 * @param {(r: number, g: number, b: number) => boolean} test
 * @returns {number}
 */
export function countWhere(png, test) {
  const image = PNG.sync.read(png);
  let found = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    if (test(image.data[index], image.data[index + 1], image.data[index + 2])) {
      found += 1;
    }
  }
  return found;
}
