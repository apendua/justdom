import { Derived, flatMap, observable, selector } from "@apendua/signal";
import { Nothing } from "../operators.js";
import { box } from "./div.js";
import {
  getAttributeCached,
  getBorderBoxSize,
  getChildNodes,
  getComputedStyleCached,
  getFirstLine,
  getInteriorClipBox,
  getParentElement,
  getScrollOffset,
  nodeCache,
  nodeDerived,
} from "./mirror.js";
import {
  contentBox,
  getRunRenderStyle,
  isTintableText,
  measureTextAdvance,
  measureTextRun,
  px,
} from "./textHelpers.js";
import { surfaceRun } from "./surfaceRun.js";

/**
 * @import {Component} from '../core.js';
 * @import {BoxSurface} from './div.js';
 * @import {Source} from '@apendua/signal';
 * @import * as THREE from 'three';
 */

/** @typedef {"ltr" | "rtl"} Direction */

/**
 * What a marker draws: its glyphs, and the space between them and the
 * item's text, which is part of the marker's box and takes no ink.
 *
 * @typedef {object} MarkerText
 * @property {string} text
 * @property {string} space
 */

/**
 * The glyph each symbolic `list-style-type` draws, as CSS Counter Styles
 * defines them, for left-to-right and right-to-left text. A closed
 * disclosure triangle points the way the text runs; the rest are the same
 * either way.
 *
 * @type {Readonly<Record<string, Readonly<Record<Direction, string>>>>}
 */
const SYMBOLS = {
  disc: { ltr: "•", rtl: "•" },
  circle: { ltr: "◦", rtl: "◦" },
  square: { ltr: "▪", rtl: "▪" },
  "disclosure-open": { ltr: "▾", rtl: "▾" },
  "disclosure-closed": { ltr: "▸", rtl: "◂" },
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
 * What a list item's marker draws, such as `•`, `3.` or `iv.`, with the
 * space after it kept apart. Null for `none`.
 *
 * In right-to-left text a number's full stop is on the side of the item's
 * text, as a browser draws it: `.3`. A string is drawn as it is written,
 * whichever way the text runs; its trailing whitespace is its space.
 *
 * The number is asked for only by a numbered style, so a bulleted list
 * never counts its items.
 *
 * @param {string} type The computed `list-style-type`.
 * @param {() => number} ordinal The item's number in its list.
 * @param {Direction} [direction]
 * @returns {MarkerText | null}
 */
export function listMarkerText(type, ordinal, direction = "ltr") {
  if (!type || type === "none") {
    return null;
  }
  const string = unquote(type);
  if (string !== null) {
    const text = string.trimEnd();
    return text ? { text, space: string.slice(text.length) } : null;
  }
  const symbol = SYMBOLS[type];
  if (symbol) {
    return { text: symbol[direction], space: " " };
  }
  const counter = formatCounter(type, ordinal());
  return { text: direction === "rtl" ? `.${counter}` : `${counter}.`, space: " " };
}

/**
 * @param {MarkerText | null} a
 * @param {MarkerText | null} b
 * @returns {boolean}
 */
function markerEqual(a, b) {
  return a === b || (!!a && !!b && a.text === b.text && a.space === b.space);
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
    signal = nodeDerived(element, () => getComputedStyleCached(element).display === "list-item");
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

/**
 * How many items an ordinal walks back over before it asks the item there
 * for its number instead. Counting back keeps each item's dependencies
 * near it; the limit keeps a long list from nesting one evaluation per item
 * on the stack when every item is dirty at once and the last is read
 * first. Ten thousand rows nest about three hundred deep.
 */
const ORDINAL_REACH = 32;

/** @type {WeakMap<Element, Derived<number>>} */
const ordinalCache = nodeCache();

/**
 * The number a list item's marker shows: its own `value`, or one on from
 * the item before it (one back, in a `reversed` list), or the list's first.
 *
 * An item counts back over the items before it to the nearest one with a
 * `value` or to the start of the list, and past `ORDINAL_REACH` of them
 * asks the item it reached instead. Appending a row is that row's walk and
 * nobody else's, however long the list. What tells an item that the items
 * before it are different ones now is its own computed style: a change to
 * a child list restyles every child from the change to the end
 * (`#restyleAround` in mirror.js), which is exactly the run of items whose
 * predecessors can have changed. The one list that does renumber on every
 * append is a `reversed` one with no `start`, whose first number is its
 * length; every number in it has changed.
 *
 * @param {Element} element
 * @returns {number}
 */
export function getListItemOrdinal(element) {
  let signal = ordinalCache.get(element);
  if (!signal) {
    signal = nodeDerived(element, () => {
      getComputedStyleCached(element);
      const list = getParentElement(element);
      const reversed = list?.localName === "ol" && getAttributeCached(list, "reversed") !== null;
      const step = reversed ? -1 : 1;
      let item = element;
      for (let back = 0; ; back++) {
        const own = parseInteger(getAttributeCached(item, "value"));
        if (own !== null) {
          return own + back * step;
        }
        const previous = previousListItem(item);
        if (!previous) {
          return firstOrdinal(list, reversed) + back * step;
        }
        if (back + 1 === ORDINAL_REACH) {
          return getListItemOrdinal(previous) + ORDINAL_REACH * step;
        }
        item = previous;
      }
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
 * otherwise, and cut by the item's own `overflow` as well as its
 * ancestors', as an outside marker is on a page.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {BoxSurface} surface
 * @param {Derived<MarkerText | null>} marker
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
    const { text, space } = marker.get() ?? { text: "", space: "" };
    const run = measureTextRun(text, renderStyle);
    // The whole marker, its space included, is what stands between the
    // content box and where the glyphs start.
    const advance = run.width + measureTextAdvance(space, renderStyle);
    const box = contentBox(own, getBorderBoxSize(element));
    const end = box.x + box.width;
    const rtl = own.direction === "rtl";
    const left =
      own.listStylePosition === "inside"
        ? rtl
          ? end - advance
          : box.x
        : rtl
          ? end
          : box.x - advance;
    const line = getFirstLine(element);
    return {
      text,
      // In right-to-left text the space is on the left, toward the content.
      x: rtl ? left + advance - run.width : left,
      y: (line ? line.top : box.y) - getScrollOffset(element).top,
      width: run.width,
      height: line?.height || px(own.lineHeight) || run.ascent + run.descent,
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
    clip: () => getInteriorClipBox(element),
  });
}

/**
 * An element's box, and in front of it the list marker its computed style
 * gives it, for as long as it gives it one: `display: list-item` and a
 * `list-style-type` that is not `none`. That is every `<li>` a page has not
 * restyled, a `<summary>` with its disclosure triangle, and anything a
 * stylesheet makes a list item. Decided reactively rather than by the tag,
 * so it is the portal's ordinary box; an element with no marker builds no
 * run.
 *
 * An item with no box draws no marker either. Its own `display` is still
 * `list-item` under a `display: none` ancestor, in a closed `<details>` or
 * in a hidden tab panel, but nothing of it is laid out, and the mirror's
 * sign for that is a box measured at nothing, as it is for text.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @returns {Source<THREE.Object3D>}
 */
export function markedBox(ctx, element) {
  const marker = new Derived(
    () => {
      if (!isListItem(element)) {
        return null;
      }
      const size = getBorderBoxSize(element);
      if (size.width <= 0 && size.height <= 0) {
        return null;
      }
      const style = getComputedStyleCached(element);
      return listMarkerText(
        style.listStyleType,
        () => getListItemOrdinal(element),
        style.direction === "rtl" ? "rtl" : "ltr",
      );
    },
    { isEqual: markerEqual },
  );
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
