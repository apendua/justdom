import { addDependency, Derived, NoValueError } from "@apendua/signal";
import { filter } from "rxjs";
import { collapseWhitespace, groupIntoLines, preservesWhitespace } from "./textLines.js";

/**
 * @import {Subject} from 'rxjs';
 * @import {TextLine} from './textLines.js';
 */

/**
 * @typedef {"attributes" | "childList" | "fontLoaded" | "characterData"} MutationType
 */

/**
 * One announcement from a portal's observer: which kinds of mutation happened,
 * and the nodes they happened at. `targets` carries the observer's own
 * `MutationRecord.target`s — the mutated element for `attributes`, the parent
 * for `childList`, the text node for `characterData` — so caches that can
 * scope their invalidation have something to scope it by. `null` means the
 * whole portal is affected: fonts arriving restyle and re-measure everything,
 * and there is no meaningful target to name.
 *
 * @typedef {object} MutationBatch
 * @property {Set<MutationType>} types
 * @property {Set<Node> | null} targets
 */

/** @type {WeakMap<WeakKey, Subject<MutationBatch>>} */
const subjects = new WeakMap();

/**
 * @param {WeakKey} node
 * @param {Subject<MutationBatch>} subject
 * @returns {void}
 */
export function setSubject(node, subject) {
  subjects.set(node, subject);
}

/**
 * Whether a batch can change the computed style of `node`.
 *
 * A mutation restyles its target and everything below it — descendant
 * combinators and plain inheritance both flow that way — but it can also
 * restyle the target's *siblings* and their subtrees, through `~`, `+` and
 * the structural pseudo-classes. All of those live inside the target's
 * parent, so the parent's subtree is the scope a target contributes; a batch
 * with no targets at all means the whole portal.
 *
 * The one selector this deliberately does not model is `:has()`, which lets
 * a mutation restyle its *ancestors*. Styling inside a portal with `:has()`
 * whose subject crosses upward past the mutated element's parent may go
 * stale until the next structural mutation re-announces the tree.
 *
 * @param {MutationBatch} batch
 * @param {Node} node
 * @returns {boolean}
 */
function affectsStyle(batch, node) {
  if (!batch.targets) {
    return true;
  }
  for (const target of batch.targets) {
    const scope = target.parentNode ?? target;
    if (scope.contains(node)) {
      return true;
    }
  }
  return false;
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
          (batch) =>
            (batch.types.has("childList") ||
              batch.types.has("attributes") ||
              batch.types.has("fontLoaded")) &&
            affectsStyle(batch, element),
        ),
      );
    signal = new Derived(
      () => {
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
      },
      {
        // Browsers hand back a *live* CSSStyleDeclaration with a stable
        // identity, so the default Object.is equality would treat every
        // recompute as "unchanged" and swallow the invalidation — leaving
        // dependents (hover restyles, class swaps) reading stale values
        // forever. Always propagate; dependents that derive plain values
        // gate on their own equality.
        isEqual: () => false,
      },
    );
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
    // Deliberately coarse: layout is non-local (a sibling growing moves this
    // element), so rects pay no attention to `targets` — but the types that
    // reach them are rare, structural ones.
    const dependency = subjects
      .get(element)
      ?.pipe(
        filter(
          (batch) =>
            batch.types.has("childList") ||
            batch.types.has("characterData") ||
            batch.types.has("fontLoaded"),
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
    // Coarse for the same reason rects are: where a text node wraps depends
    // on layout the whole tree decides together.
    const dependency = subjects
      .get(text)
      ?.pipe(
        filter(
          (batch) =>
            batch.types.has("childList") ||
            batch.types.has("characterData") ||
            batch.types.has("fontLoaded"),
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

/**
 * `Node.parentElement` is an `HTMLElement`, and `Derived` is invariant in its
 * value, so the cache has to say so rather than widening to `Element`.
 *
 * @type {WeakMap<WeakKey, Derived<HTMLElement | null>>}
 */
const parentElementCache = new WeakMap();

/**
 * @param {Node} node
 * @returns {HTMLElement | null}
 */
export function getParentElement(node) {
  let signal = parentElementCache.get(node);
  if (!signal) {
    const dependency = subjects.get(node)?.pipe(filter((batch) => batch.types.has("childList")));
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
