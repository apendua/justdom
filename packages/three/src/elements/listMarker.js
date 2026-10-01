import { Derived, flatMap, observable, selector } from "@apendua/signal";
import { Nothing } from "../operators.js";
import { box } from "./div.js";
import {
  getAttributeCached,
  getBorderBoxSize,
  getChildNodes,
  getComputedStyleCached,
  getParentElement,
  nodeCache,
} from "./mirror.js";
import { getRunRenderStyle, isTintableText, measureTextRun, px } from "./textHelpers.js";
import { surfaceRun } from "./surfaceRun.js";

/**
 * @import {Component} from '../core.js';
 * @import {BoxSurface} from './div.js';
 * @import {Source} from '@apendua/signal';
 * @import * as THREE from 'three';
 */

/**
 * The glyph each symbolic `list-style-type` draws, as CSS Counter Styles
 * defines them. A marker is its glyph and a space, which is what keeps it
 * clear of the item's text.
 *
 * @type {Readonly<Record<string, string>>}
 */
const SYMBOLS = {
  disc: "•",
  circle: "◦",
  square: "▪",
  "disclosure-open": "▾",
  "disclosure-closed": "▸",
};

const LATIN = "abcdefghijklmnopqrstuvwxyz";
const GREEK = "αβγδεζηθικλμνξοπρστυφχψω";

/** @type {ReadonlyArray<readonly [number, string]>} */
const ROMAN = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

/**
 * `n` in a bijective base of the given digits: a, b, … z, aa, ab, which is
 * how the alphabetic styles count. Defined from 1 up.
 *
 * @param {number} n
 * @param {string} digits
 * @returns {string}
 */
function alphabetic(n, digits) {
  const symbols = [...digits];
  let result = "";
  for (let rest = n; rest > 0; rest = Math.floor(rest / symbols.length)) {
    rest -= 1;
    result = symbols[rest % symbols.length] + result;
  }
  return result;
}

/**
 * @param {number} n From 1 to 3999.
 * @returns {string}
 */
function roman(n) {
  let result = "";
  let rest = n;
  for (const [value, numeral] of ROMAN) {
    for (; rest >= value; rest -= value) {
      result += numeral;
    }
  }
  return result;
}

/**
 * The counter of a numbered marker, in its style. A number outside the
 * range a style is defined for is written in decimal, and so is a style
 * this does not know, a `@counter-style` of the page's own included: CSS
 * falls back to decimal in both cases.
 *
 * @param {string} type
 * @param {number} n
 * @returns {string}
 */
function formatCounter(type, n) {
  switch (type) {
    case "decimal-leading-zero":
      return `${n < 0 ? "-" : ""}${String(Math.abs(n)).padStart(2, "0")}`;
    case "lower-alpha":
    case "lower-latin":
      return n >= 1 ? alphabetic(n, LATIN) : String(n);
    case "upper-alpha":
    case "upper-latin":
      return n >= 1 ? alphabetic(n, LATIN).toUpperCase() : String(n);
    case "lower-greek":
      return n >= 1 ? alphabetic(n, GREEK) : String(n);
    case "lower-roman":
      return n >= 1 && n <= 3999 ? roman(n) : String(n);
    case "upper-roman":
      return n >= 1 && n <= 3999 ? roman(n).toUpperCase() : String(n);
    default:
      return String(n);
  }
}

/**
 * A computed `list-style-type` that is a string, `"→ "`, unquoted; or null
 * for one that names a style.
 *
 * @param {string} type
 * @returns {string | null}
 */
function unquote(type) {
  const quote = type[0];
  if ((quote !== '"' && quote !== "'") || type.length < 2 || type.at(-1) !== quote) {
    return null;
  }
  return type.slice(1, -1).replace(/\\(.)/g, "$1");
}

/**
 * What a list item's marker says, with its suffix and the space after it,
 * such as `"• "`, `"3. "` or `"iv. "`. Null for `none`.
 *
 * The number is asked for only by a numbered style, so a bulleted list
 * never counts its items.
 *
 * @param {string} type The computed `list-style-type`.
 * @param {() => number} ordinal The item's number in its list.
 * @returns {string | null}
 */
export function listMarkerText(type, ordinal) {
  if (!type || type === "none") {
    return null;
  }
  const string = unquote(type);
  if (string !== null) {
    return string || null;
  }
  const symbol = SYMBOLS[type];
  if (symbol) {
    return `${symbol} `;
  }
  return `${formatCounter(type, ordinal())}. `;
}

/**
 * An integer attribute as HTML reads one, leading sign and all, or null
 * when it is absent or no number.
 *
 * @param {string | null} value
 * @returns {number | null}
 */
function parseInteger(value) {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** @type {WeakMap<Element, Derived<boolean>>} */
const listItemCache = nodeCache();

/**
 * Whether the element is laid out as a list item, and so is counted by its
 * list and draws a marker. Behind a gate of its own, so that a hover on one
 * item, which restyles it, tells the item after it nothing.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function isListItem(element) {
  let signal = listItemCache.get(element);
  if (!signal) {
    signal = new Derived(() => getComputedStyleCached(element).display === "list-item");
    listItemCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @param {Element} element
 * @returns {Element | null}
 */
function previousListItem(element) {
  for (
    let sibling = element.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    if (isListItem(sibling)) {
      return sibling;
    }
  }
  return null;
}

/**
 * The number of a list's first item: its `start`, or for a `reversed` list
 * without one, how many items it has. Only an `<ol>` has either.
 *
 * @param {Element | null} list
 * @param {boolean} reversed
 * @returns {number}
 */
function firstOrdinal(list, reversed) {
  if (!list || list.localName !== "ol") {
    return 1;
  }
  const start = parseInteger(getAttributeCached(list, "start"));
  if (start !== null) {
    return start;
  }
  if (!reversed) {
    return 1;
  }
  let count = 0;
  for (const child of getChildNodes(list)) {
    if (child.nodeType === Node.ELEMENT_NODE && isListItem(/** @type {Element} */ (child))) {
      count += 1;
    }
  }
  return count;
}

/** @type {WeakMap<Element, Derived<number>>} */
const ordinalCache = nodeCache();

/**
 * The number a list item's marker shows: its own `value`, or one on from
 * the item before it (one back, in a `reversed` list), or the list's first.
 *
 * Each item asks only the item before it, so appending a row numbers that
 * row and nobody else, however long the list. What tells an item that the
 * item before it is a different one now is its own computed style: a
 * change to a child list restyles every child from the change to the end
 * (`#restyleAround` in mirror.js), which is exactly the run of items whose
 * predecessor can have changed. The one list that does renumber on every
 * append is a `reversed` one with no `start`, whose first number is its
 * length; every number in it has changed.
 *
 * @param {Element} element
 * @returns {number}
 */
export function getListItemOrdinal(element) {
  let signal = ordinalCache.get(element);
  if (!signal) {
    signal = new Derived(() => {
      getComputedStyleCached(element);
      const own = parseInteger(getAttributeCached(element, "value"));
      if (own !== null) {
        return own;
      }
      const list = getParentElement(element);
      const reversed = list?.localName === "ol" && getAttributeCached(list, "reversed") !== null;
      const previous = previousListItem(element);
      if (previous) {
        return getListItemOrdinal(previous) + (reversed ? -1 : 1);
      }
      return firstOrdinal(list, reversed);
    });
    ordinalCache.set(element, signal);
  }
  return signal.get();
}

/**
 * The marker, drawn where the browser draws it: on the item's first line,
 * outside its content box on the side the text starts from, or at the start
 * of that line for `list-style-position: inside`, where the browser has
 * already moved the item's text over to make room. In the colour and font
 * the page gives `::marker`, which are the item's unless a rule says
 * otherwise.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {BoxSurface} surface
 * @param {Derived<string | null>} marker
 * @returns {Source<Component>}
 */
function markerRun(ctx, element, surface, marker) {
  const style = selector(() => getComputedStyleCached(element, "::marker"));
  const own = selector(() => getComputedStyleCached(element));
  const renderStyle = selector(() => getRunRenderStyle(style));
  const tint = selector(() => {
    if (!isTintableText(style)) {
      return { masked: false, color: "#ffffff" };
    }
    return { masked: true, color: style.color || "#000000" };
  });

  const placed = selector(() => {
    const text = marker.get() ?? "";
    const drawn = text.trimEnd();
    // The whole marker, its space included, is what stands between the
    // content box and where the glyphs start.
    const advance = measureTextRun(text, renderStyle);
    const width = measureTextRun(drawn, renderStyle).width;
    const size = getBorderBoxSize(element);
    const start = px(own.borderLeftWidth) + px(own.paddingLeft);
    const end = size.width - px(own.borderRightWidth) - px(own.paddingRight);
    const rtl = own.direction === "rtl";
    const left =
      own.listStylePosition === "inside"
        ? rtl
          ? end - advance.width
          : start
        : rtl
          ? end
          : start - advance.width;
    return {
      text: drawn,
      // In right-to-left text the space is on the left, toward the content.
      x: rtl ? left + advance.width - width : left,
      y: px(own.borderTopWidth) + px(own.paddingTop),
      width,
      // The item's line, which is the one the marker sits on.
      height: px(own.lineHeight) || advance.ascent + advance.descent,
    };
  });

  const layout = selector(() => {
    const { text, width, height } = placed;
    return {
      bounds: { width: Math.max(width, 1), height: Math.max(height, 1) },
      lines: text ? [{ text, left: 0, top: 0, width, height }] : [],
    };
  });

  return surfaceRun(ctx, surface, {
    layout: () => layout,
    renderStyle: () => renderStyle,
    tint: () => tint,
    origin: () => ({ x: placed.x, y: placed.y }),
    clip: () => surface.clipBox(),
  });
}

/**
 * An `<li>`: its box, and the marker in front of it for as long as its
 * computed style gives it one. That takes `display: list-item` and a
 * `list-style-type` that is not `none`. An item with no marker builds no
 * run, so a list styled `list-style: none`, the usual thing for a list of
 * rows in an app, costs what a list of divs does.
 *
 * Decided by the tag, which never changes, as the portal decides every
 * element: another element made `display: list-item` by a stylesheet is
 * drawn as the box it is, with no marker.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @returns {Source<THREE.Object3D>}
 */
export function listItem(ctx, element) {
  const marker = new Derived(() => {
    if (!isListItem(element)) {
      return null;
    }
    return listMarkerText(getComputedStyleCached(element).listStyleType, () =>
      getListItemOrdinal(element),
    );
  });
  return box(ctx, element, {
    content: (surface) => [
      // No equality gate between the two: `Derived` already stops a
      // recomputation that lands on the value it held.
      flatMap((/** @type {boolean} */ shown) =>
        shown ? markerRun(ctx, element, surface, marker) : Nothing(),
      )(observable(() => marker.get() !== null)),
    ],
  });
}
