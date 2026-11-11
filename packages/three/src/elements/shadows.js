import { parseCssColor } from "./css/cssColor.js";

/**
 * @import {RGBA} from './css/cssColor.js';
 */

/**
 * Reading the shadows a computed style asks for: `text-shadow`, which
 * `textHelpers.js` bakes into a run's texture, and `box-shadow`, which the
 * panel's batch draws as instances of their own (`paintBatch.js`).
 */

/**
 * A length inside a shadow. Computed values are always absolute, so `px` is
 * the only unit that can turn up and nothing here converts units.
 */
export const SHADOW_LENGTH = /-?\d*\.?\d+px/g;

/**
 * How many layers of a `box-shadow` are drawn: the topmost ones, which are
 * the first in the list. Four covers a ring and a soft shadow stacked
 * together, as utility CSS writes them.
 */
export const MAX_BOX_SHADOWS = 4;

/**
 * Splits a shadow into its layers: the commas that separate layers are the
 * ones at nesting depth zero, not the ones inside a color function.
 * `rgb(0, 0, 0) 2px 3px 4px` is a single layer with two commas in it, and
 * splitting on those leaves `rgb(0`, which has no length in it at all.
 *
 * @param {string} shadow
 * @returns {string[]}
 */
export function splitShadowLayers(shadow) {
  /** @type {string[]} */
  const layers = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < shadow.length; i++) {
    const char = shadow[i];
    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      layers.push(shadow.slice(start, i));
      start = i + 1;
    }
  }
  layers.push(shadow.slice(start));
  return layers;
}

/**
 * One layer of a `box-shadow`, in px, its colour in sRGB channels.
 *
 * @typedef {object} BoxShadow
 * @property {RGBA} color
 * @property {number} x
 * @property {number} y
 * @property {number} blur
 * @property {number} spread
 * @property {boolean} inset
 */

/**
 * Reads a `box-shadow` into its layers, topmost first, at most
 * `MAX_BOX_SHADOWS` of them.
 *
 * A computed value is colour first, then the two offsets, the blur and the
 * spread, then `inset`; author syntax, colour last or left out, reads too.
 * A layer without both offsets, or with a colour `parseCssColor` cannot
 * read, is dropped, and so is one whose colour has no alpha, which draws
 * nothing.
 *
 * @param {string} boxShadow
 * @param {string} [currentColor] What a layer without a colour, or with
 *   `currentcolor`, is drawn in.
 * @returns {BoxShadow[]}
 */
export function parseBoxShadow(boxShadow, currentColor) {
  /** @type {BoxShadow[]} */
  const shadows = [];
  if (!boxShadow || boxShadow === "none") {
    return shadows;
  }
  for (const layer of splitShadowLayers(boxShadow)) {
    if (shadows.length === MAX_BOX_SHADOWS) {
      break;
    }
    const [x, y, blur, spread] = layer.match(SHADOW_LENGTH) ?? [];
    if (x === undefined || y === undefined) {
      continue;
    }
    const words = layer.replace(SHADOW_LENGTH, " ");
    const inset = /(?:^|\s)inset(?:\s|$)/.test(words);
    const written = words.replace(/(?:^|\s)inset(?=\s|$)/, " ").trim();
    const color = parseCssColor(written || "currentcolor", currentColor);
    if (!color || color[3] <= 0) {
      continue;
    }
    shadows.push({
      color,
      x: Number.parseFloat(x),
      y: Number.parseFloat(y),
      // A negative blur is not a value CSS allows.
      blur: blur ? Math.max(0, Number.parseFloat(blur)) : 0,
      spread: spread ? Number.parseFloat(spread) : 0,
      inset,
    });
  }
  return shadows;
}
