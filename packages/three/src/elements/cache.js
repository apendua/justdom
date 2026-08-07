import { addDependency, Derived, NoValueError } from "@apendua/signal";
import { filter } from "rxjs";
import { collapseWhitespace, groupIntoLines, preservesWhitespace } from "./textLines.js";

/**
 * @import {Subject} from 'rxjs';
 * @import {TextLine} from './textLines.js';
 */

/**
 * The attribute a portal marks its container element with. It lives here —
 * the leaf module everything on both sides of the portal already imports —
 * so that helpers which need to know where a portal's tree ends (ancestor
 * walks, `getPortalRoot`) can share it without importing each other.
 */
export const PORTAL_ATTRIBUTE = "data-xr-portal";

/**
 * Whether a computed `transform` value is one the mirror treats as a
 * transform at all. Browsers serialize every computed transform to a single
 * `matrix()`/`matrix3d()`, so under a real engine this is exactly "has a
 * transform"; jsdom passes author values through, and anything unrecognized
 * counts as untransformed everywhere, consistently.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function hasTransform(value) {
  return !!value && value !== "none" && value.startsWith("matrix");
}

/**
 * The attribute that switches an element's transform off while something is
 * being measured. Deliberately absent from the portal observer's filter, so
 * the toggling is invisible to invalidation — putting it there would make
 * every measurement announce a mutation, which would schedule another
 * measurement.
 */
const MEASURE_ATTRIBUTE = "data-xr-measure";

/** @type {HTMLStyleElement | null} */
let measureStyleElement = null;

function ensureMeasureStyle() {
  if (!measureStyleElement || !measureStyleElement.isConnected) {
    measureStyleElement = document.createElement("style");
    // !important outranks inline styles and animation values alike, which is
    // what lets this switch off a transform mid-transition.
    measureStyleElement.textContent = `[${MEASURE_ATTRIBUTE}] { transform: none !important; }`;
    document.head.appendChild(measureStyleElement);
  }
}

/**
 * Run `fn` with every CSS transform between `element` and its portal root
 * switched off, so the client rects it reads come back in layout space —
 * the space the mirror draws in, with the transforms re-applied as object
 * matrices. Transforms do not affect layout, so nothing actually moves; the
 * one blind spot is an absolutely positioned descendant whose containing
 * block the transform was.
 *
 * Reading the ancestors' styles here registers them as dependencies of the
 * calling computation, which is the correct thing: a transform toggling on
 * an ancestor changes what this measurement means.
 *
 * @template T
 * @param {HTMLElement | null} element
 * @param {() => T} fn
 * @returns {T}
 */
export function withoutTransforms(element, fn) {
  /** @type {HTMLElement[]} */
  const affected = [];
  /** @type {HTMLElement | null} */
  let el = element;
  while (el && !el.hasAttribute(PORTAL_ATTRIBUTE)) {
    if (hasTransform(getComputedStyleCached(el).transform)) {
      affected.push(el);
    }
    el = el.parentElement;
  }
  if (!affected.length) {
    return fn();
  }
  ensureMeasureStyle();
  for (const transformed of affected) {
    transformed.setAttribute(MEASURE_ATTRIBUTE, "");
  }
  try {
    return fn();
  } finally {
    for (const transformed of affected) {
      transformed.removeAttribute(MEASURE_ATTRIBUTE);
    }
  }
}

/**
 * The kinds of change a batch can announce. The first four mirror what the
 * portal's observer (and the font API) report. The last two come from the
 * animation clock, which has no mutations to relay — only time passing under
 * a running animation: `animated` says the computed styles of the targets'
 * neighbourhoods may have moved, and `reflow` says client rects have — of
 * the targets' subtrees, or of everything when layout itself is animating
 * and no target can name what it displaced.
 *
 * @typedef {"attributes" | "childList" | "fontLoaded" | "characterData" | "animated" | "reflow"} MutationType
 */

/**
 * How an animated property ranks for invalidation — see `animationClock.js`,
 * which is organized around it. It lives here with the mutation types
 * because the two vocabularies translate into each other: paint asks for
 * `animated` alone, transform adds a targeted `reflow`, layout a portal-wide
 * one.
 *
 * @typedef {"paint" | "transform" | "layout"} AnimationClass
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

/**
 * Whether a batch can change the client rects of `node`.
 *
 * Structural mutations and fonts arriving re-lay-out the whole portal, and
 * layout is non-local — a sibling growing moves this element — so those stay
 * portal-wide. Attribute mutations were long assumed unable to move
 * anything, which is the bargain that keeps hover cheap; but one thing they
 * *can* do is toggle a CSS transform, and a transform changes the client
 * rects of exactly the mutated element's own subtree and nobody else's.
 * Re-measuring that subtree keeps transformed bounds coherent with the
 * styles that produced them, at the price of a few rect reads per hover.
 * Sizes an attribute changes through actual layout (padding on hover) still
 * go stale outside the mutated subtree — that contract stands.
 *
 * @param {MutationBatch} batch
 * @param {Node} node
 * @returns {boolean}
 */
function affectsRect(batch, node) {
  if (
    batch.types.has("childList") ||
    batch.types.has("characterData") ||
    batch.types.has("fontLoaded")
  ) {
    return true;
  }
  // `reflow` is the animation clock saying rects moved without any mutation:
  // an animating transform moves its own subtree's rects exactly the way a
  // toggled one does, and an animating layout property moves anybody's,
  // which the clock announces with no targets at all.
  if (!batch.types.has("attributes") && !batch.types.has("reflow")) {
    return false;
  }
  if (!batch.targets) {
    return true;
  }
  for (const target of batch.targets) {
    if (target.contains(node)) {
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
              batch.types.has("fontLoaded") ||
              batch.types.has("animated")) &&
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
    const dependency = subjects.get(element)?.pipe(filter((batch) => affectsRect(batch, element)));
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
 * A text node's layout, measured with every transform on the chain switched
 * off — line boxes read back under a rotation would group by *screen* rows,
 * which is not where the browser broke the lines.
 *
 * @typedef {object} TextLayout
 * @property {DOMRect} bounds Union of the text node's line boxes.
 * @property {number} left Where `bounds` sits relative to the parent
 *   element's border box, in layout px.
 * @property {number} top Same, vertically.
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
 * the text that landed on each one. Everything is measured inside
 * `withoutTransforms`: rects of transformed content are screen-space bounds,
 * and both the line grouping and the parent-relative position have to happen
 * in layout space — the object carrying the transform re-applies it.
 * @param {Text} text
 * @returns {TextLayout}
 */
function measureTextLayout(text) {
  const parentElement = text.parentElement;
  if (!parentElement) {
    throw new NoValueError("Text node has no parent element");
  }
  const content = text.textContent || "";
  const whiteSpace = getComputedStyleCached(text).whiteSpace || "normal";
  return withoutTransforms(parentElement, () => {
    const parentRect = parentElement.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(text);
    const bounds = range.getBoundingClientRect();
    const left = bounds.left - parentRect.left;
    const top = bounds.top - parentRect.top;

    const rects = range.getClientRects();
    if (rects.length === 0) {
      // Empty, or not laid out at all. Either way there is nothing to draw,
      // and in particular nothing that should be drawn at the origin instead.
      return { bounds, left, top, lines: [] };
    }

    // The overwhelmingly common case is a label on a single line, which the
    // bounding box already describes. Only text that actually wrapped is
    // worth walking character by character.
    if (isSingleLine(rects)) {
      const line = collapseWhitespace(content, whiteSpace);
      return {
        bounds,
        left,
        top,
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
        // Whitespace the layout collapsed away occupies no space and belongs
        // to no line box.
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

    return { bounds, left, top, lines };
  });
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
    // Same rule as rects: line boxes are client rects, so a transform toggled
    // on an ancestor moves them too.
    const dependency = subjects.get(text)?.pipe(filter((batch) => affectsRect(batch, text)));
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
