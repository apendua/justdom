import { addDependency, Derived, NoValueError } from "@apendua/signal";
import { filter, Subject } from "rxjs";
import { collapseWhitespace, groupIntoLines, preservesWhitespace } from "./textLines.js";

/**
 * @import {TextLine} from './textLines.js';
 */

/**
 * @typedef {"attributes" | "childList" | "fontLoaded" | "characterData"} MutationType
 */

/** @type {WeakMap<WeakKey, Subject<Set<MutationType>>>} */
const subjects = new WeakMap();

/**
 * @param {WeakKey} node
 * @param {Subject<Set<MutationType>>} subject
 * @returns {void}
 */
export function setSubject(node, subject) {
  subjects.set(node, subject);
}

/** @type {WeakMap<Element | Text, Map<string | null, Derived<CSSStyleDeclaration>>>} */
let computedStyleCache = new WeakMap();

/**
 * @param {Element | Text} element
 * @param {string | null} [pseudoElement]
 * @returns {CSSStyleDeclaration}
 */
export function getComputedStyleCached(element, pseudoElement = null) {
  let signalMap = computedStyleCache.get(element);
  if (!signalMap) {
    signalMap = new Map();
    computedStyleCache.set(element, signalMap);
  }
  let signal = signalMap.get(pseudoElement);
  if (!signal) {
    const dependency = subjects
      .get(element)
      ?.pipe(
        filter(
          (mutations) =>
            mutations.has("childList") ||
            mutations.has("attributes") ||
            mutations.has("fontLoaded"),
        ),
      );
    signal = new Derived(() => {
      if (dependency) {
        addDependency(dependency);
      }
      if (element instanceof Text) {
        if (!element.parentElement) {
          throw new NoValueError("Text node has no parent element");
        }
        return window.getComputedStyle(element.parentElement, pseudoElement);
      }
      return window.getComputedStyle(element, pseudoElement);
    });
    signalMap.set(pseudoElement, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element, Derived<DOMRect>>} */
let boundingClientRectCache = new WeakMap();

/**
 * @param {Element} element
 * @returns {DOMRect}
 */
export function getBoundingClientRectCached(element) {
  let signal = boundingClientRectCache.get(element);
  if (!signal) {
    const dependency = subjects
      .get(element)
      ?.pipe(
        filter(
          (mutations) =>
            mutations.has("childList") ||
            mutations.has("characterData") ||
            mutations.has("fontLoaded"),
        ),
      );
    signal = new Derived(() => {
      if (dependency) {
        addDependency(dependency);
      }
      return element.getBoundingClientRect();
    });
    boundingClientRectCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @typedef {object} TextLayout
 * @property {DOMRect} bounds Union of the text node's line boxes.
 * @property {TextLine[]} lines Line boxes, positioned relative to `bounds`.
 */

/**
 * Whether every rectangle in the list sits on the same line box.
 * @param {DOMRectList} rects
 * @returns {boolean}
 */
function isSingleLine(rects) {
  for (let i = 1; i < rects.length; i++) {
    const height = Math.max(1, rects[i].bottom - rects[i].top);
    if (Math.abs(rects[i].top - rects[0].top) >= height / 2) {
      return false;
    }
  }
  return true;
}

/**
 * Read back the line boxes the browser laid a text node out into, along with
 * the text that landed on each one.
 * @param {Text} text
 * @returns {TextLayout}
 */
function measureTextLayout(text) {
  const content = text.textContent || "";
  const whiteSpace = getComputedStyleCached(text).whiteSpace || "normal";
  const range = document.createRange();
  range.selectNodeContents(text);
  const bounds = range.getBoundingClientRect();

  const rects = range.getClientRects();
  if (rects.length === 0) {
    // Empty, or not laid out at all. Either way there is nothing to draw, and
    // in particular nothing that should be drawn at the origin instead.
    return { bounds, lines: [] };
  }

  // The overwhelmingly common case is a label on a single line, which the
  // bounding box already describes. Only text that actually wrapped is worth
  // walking character by character.
  if (isSingleLine(rects)) {
    const line = collapseWhitespace(content, whiteSpace);
    return {
      bounds,
      lines: line
        ? [{ text: line, left: 0, top: 0, width: bounds.width, height: bounds.height }]
        : [],
    };
  }

  const preserved = preservesWhitespace(whiteSpace);
  /** @type {import('./textLines.js').CharacterRect[]} */
  const characters = [];
  for (let index = 0; index < content.length; index++) {
    range.setStart(text, index);
    range.setEnd(text, index + 1);
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      // Whitespace the layout collapsed away occupies no space and belongs to
      // no line box.
      continue;
    }
    characters.push({
      index,
      blank: !preserved && /\s/.test(content[index]),
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    });
  }

  const lines = [];
  for (const row of groupIntoLines(characters)) {
    const line = collapseWhitespace(content.slice(row.start, row.end), whiteSpace);
    if (!line) {
      continue;
    }
    lines.push({
      text: line,
      left: row.left - bounds.left,
      top: row.top - bounds.top,
      width: row.right - row.left,
      height: row.bottom - row.top,
    });
  }

  return { bounds, lines };
}

/** @type {WeakMap<Text, Derived<TextLayout>>} */
let textLayoutCache = new WeakMap();

/**
 * @param {Text} text
 * @returns {TextLayout}
 */
export function getTextLayout(text) {
  let signal = textLayoutCache.get(text);
  if (!signal) {
    const dependency = subjects
      .get(text)
      ?.pipe(
        filter(
          (mutations) =>
            mutations.has("childList") ||
            mutations.has("characterData") ||
            mutations.has("fontLoaded"),
        ),
      );
    signal = new Derived(() => {
      if (dependency) {
        addDependency(dependency);
      }
      return measureTextLayout(text);
    });
    textLayoutCache.set(text, signal);
  }
  return signal.get();
}

/** @type {WeakMap<WeakKey, Derived<Element | null>>} */
const parentElementCache = new WeakMap();

/**
 * @param {Node} node
 * @returns {Element | null}
 */
export function getParentElement(node) {
  let signal = parentElementCache.get(node);
  if (!signal) {
    const dependency = subjects.get(node)?.pipe(filter((mutations) => mutations.has("childList")));
    signal = new Derived(() => {
      if (dependency) {
        addDependency(dependency);
      }
      return node.parentElement;
    });
    parentElementCache.set(node, signal);
  }
  return signal.get();
}
