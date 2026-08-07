import { addDependency, Derived, NoValueError } from "@apendua/signal";
import { filter } from "rxjs";
import {
  collapseWhitespace,
  findLineStarts,
  groupLineBoxes,
  preservesWhitespace,
  trimLineRange,
} from "./textLines.js";
import { clipBoxEqual, intersectClipBoxes, UNCLIPPED } from "./clip.js";

/**
 * @import {Subject} from 'rxjs';
 * @import {TextLine} from './textLines.js';
 * @import {TextBounds} from './textHelpers.js';
 * @import {ClipBox} from './clip.js';
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
 * Whether the element, or any ancestor inside the portal, carries a CSS
 * transform. Reading the styles here registers them as dependencies of the
 * calling computation, which is the correct thing: a transform toggling on
 * an ancestor changes what a measurement of this element means.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
function isSubtreeTransformed(element) {
  /** @type {HTMLElement | null} */
  let el = element;
  while (el && !el.hasAttribute(PORTAL_ATTRIBUTE)) {
    if (hasTransform(getComputedStyleCached(el).transform)) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * A detached, untransformed copy of `element` to measure instead of the real
 * thing, parked off-screen outside the portal's observed subtree.
 *
 * Touching the live elements is not an option: masking a transform with an
 * !important rule interacts with `transition: transform` at the browser's
 * pace, not ours — a synchronous flush updates the transition *baseline*
 * while transitions themselves are only generated at frames — so any
 * mask-and-restore protocol either swallows a transition the mutation meant
 * to start or manufactures one out of the restore. A clone has no
 * transitions to disturb.
 *
 * The clone's layout reproduces the original's because every resolved style
 * — the used width included — is copied onto its root; descendants keep
 * their classes and the document's stylesheets apply as usual. The one
 * blind spot: a descendant selector that reaches *above* the cloned element
 * (`.card[data-state] p`) has no ancestors to match against and falls back
 * to base styling.
 *
 * @param {HTMLElement} element
 * @returns {HTMLElement}
 */
function createMeasurementClone(element) {
  const clone = /** @type {HTMLElement} */ (element.cloneNode(true));
  const computed = window.getComputedStyle(element);
  for (let i = 0; i < computed.length; i++) {
    const property = computed[i];
    clone.style.setProperty(property, computed.getPropertyValue(property));
  }
  clone.style.setProperty("transform", "none", "important");
  clone.style.setProperty("transition", "none", "important");
  clone.style.setProperty("animation", "none", "important");
  clone.style.setProperty("position", "absolute", "important");
  clone.style.setProperty("top", "0", "important");
  clone.style.setProperty("left", "-99999px", "important");
  clone.style.setProperty("visibility", "hidden", "important");
  return clone;
}

/**
 * The kinds of change a batch can announce. The first four mirror what the
 * portal's observer (and the font API) report. The next two come from the
 * animation clock, which has no mutations to relay — only time passing under
 * a running animation: `animated` says the computed styles of the targets'
 * neighbourhoods may have moved, and `reflow` says client rects have — of
 * the targets' subtrees, or of everything when layout itself is animating
 * and no target can name what it displaced.
 *
 * `scroll` is the last, and the odd one: scrolling mutates nothing and
 * restyles nothing, so no observer reports it, yet it moves the client rects
 * of everything inside the scroller. The portal listens for it directly.
 *
 * @typedef {"attributes" | "childList" | "fontLoaded" | "characterData" | "animated" | "reflow" | "scroll"} MutationType
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
  //
  // `scroll` scopes the same way, and unusually precisely: scrolling moves
  // the rects of the scroller's own subtree and of nothing else on the page,
  // so the target the portal names with it is exactly the affected scope.
  if (!batch.types.has("attributes") && !batch.types.has("reflow") && !batch.types.has("scroll")) {
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
 * @property {TextBounds} bounds How big the union of the text node's line
 *   boxes is. Deliberately a size and not a rectangle — see
 *   `measureTextRects`.
 * @property {number} left Where `bounds` sits relative to the parent
 *   element's border box, in layout px.
 * @property {number} top Same, vertically.
 * @property {TextLine[]} lines Line boxes, positioned relative to `bounds`.
 */

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
 * 0.5ms, per measurement, and every frame of a scroll is one measurement.
 *
 * @param {Text} text
 * @param {HTMLElement} parentElement
 * @param {string} whiteSpace
 * @returns {TextLayout}
 */
function measureTextRects(text, parentElement, whiteSpace) {
  const content = text.textContent || "";
  const parentRect = parentElement.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(text);
  const boundsRect = range.getBoundingClientRect();
  const left = boundsRect.left - parentRect.left;
  const top = boundsRect.top - parentRect.top;
  // Size alone, and a plain object: where the text sits in the viewport is
  // already said by `left` and `top`, in the parent-relative terms the mirror
  // draws in — and it is the only part of this rectangle that a scroll
  // changes. Handing the viewport position on as well would make every
  // dependent of these bounds a dependent of the scroll position too — and a
  // `DOMRect` is not a plain object, so the selector proxy cannot look inside
  // one: a fresh identity per measurement would re-run the rasterizer for
  // every visible label on every frame that moved anything.
  const bounds = { width: boundsRect.width, height: boundsRect.height };

  const boxes = groupLineBoxes(range.getClientRects());
  if (boxes.length === 0) {
    // Empty, or not laid out at all. Either way there is nothing to draw,
    // and in particular nothing that should be drawn at the origin instead.
    return { bounds, left, top, lines: [] };
  }

  // The overwhelmingly common case is a label on a single line, which the
  // bounding box already describes — and describes for free, the rectangle
  // having been read already.
  if (boxes.length === 1) {
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
  const starts = findLineStarts(content.length, boxes.length, (index) => {
    range.setStart(text, index);
    range.setEnd(text, index + 1);
    const rect = range.getBoundingClientRect();
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
  for (let line = 0; line < starts.length; line++) {
    const until = line + 1 < starts.length ? starts[line + 1] : content.length;
    const [from, to] = trimLineRange(content, starts[line], until, preserved);
    if (from >= to) {
      // A line with nothing on it but the whitespace that ended the one
      // before it, or the blank line a `pre` block is entitled to.
      continue;
    }
    const value = collapseWhitespace(content.slice(from, to), whiteSpace);
    if (!value) {
      continue;
    }
    // One rectangle per line, over the text the line actually draws, so the
    // extent is the browser's own shaping — kerning included — rather than a
    // union of per-character boxes.
    range.setStart(text, from);
    range.setEnd(text, to);
    const rect = range.getBoundingClientRect();
    lines.push({
      text: value,
      left: rect.left - boundsRect.left,
      top: rect.top - boundsRect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  return { bounds, left, top, lines };
}

/**
 * Read back the line boxes the browser laid a text node out into, along with
 * the text that landed on each one.
 *
 * Under a transform anywhere on the chain, the real tree's client rects are
 * screen-space bounds — a rotation would group lines by screen rows, which
 * is not where the browser broke them — so the measurement runs against a
 * detached untransformed clone of the parent instead. The text node is
 * always a direct child of its parent element, so finding it again in the
 * clone is an index lookup.
 *
 * @param {Text} text
 * @returns {TextLayout}
 */
function measureTextLayout(text) {
  const parentElement = text.parentElement;
  if (!parentElement) {
    throw new NoValueError("Text node has no parent element");
  }
  const whiteSpace = getComputedStyleCached(text).whiteSpace || "normal";
  if (!isSubtreeTransformed(parentElement)) {
    return measureTextRects(text, parentElement, whiteSpace);
  }
  const clone = createMeasurementClone(parentElement);
  document.body.appendChild(clone);
  try {
    const index = Array.prototype.indexOf.call(parentElement.childNodes, text);
    const cloneText = clone.childNodes[index];
    if (!(cloneText instanceof Text)) {
      throw new NoValueError("Text node not found in measurement clone");
    }
    return measureTextRects(cloneText, clone, whiteSpace);
  } finally {
    clone.remove();
  }
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
    //
    // Which means this re-measures whenever anything moves the text — every
    // frame of a layout animation, and every frame of a scroll once there is
    // one. What it must not do is make that re-measurement *look* like a
    // change to anyone reading it: every field it reports is relative to the
    // text's own parent or to its own bounds, so a subtree sliding through
    // the viewport recomputes to the same numbers and the selector proxy
    // stops there. Nothing downstream — the texture above all — re-runs.
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
 * @param {string} value
 * @returns {number}
 */
function pixels(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The overflow that applies on one axis. A browser always resolves the
 * longhands, but a headless layout engine may only report the shorthand it
 * was given, and answering "visible" there would quietly switch clipping off
 * in every test that uses one.
 *
 * @param {CSSStyleDeclaration} style
 * @param {"overflowX" | "overflowY"} axis
 * @returns {boolean}
 */
function hidesOverflow(style, axis) {
  const value = style[axis] || style.overflow;
  return !!value && value !== "visible";
}

/**
 * Whether an element clips what overflows it, on either axis — the first half
 * of "does it scroll", and the same answer the clip walk below acts on.
 *
 * @param {CSSStyleDeclaration} style
 * @returns {boolean}
 */
export function clipsOverflow(style) {
  return hidesOverflow(style, "overflowX") || hidesOverflow(style, "overflowY");
}

/**
 * What an element confines its descendants to: its padding box, which is
 * where CSS puts the edge of `overflow: hidden`, on whichever axes are not
 * `visible`, with the corners its border radii round — reduced by the border
 * they sit behind, the same way the box's own inner edge is.
 *
 * @param {HTMLElement} element
 * @returns {ClipBox}
 */
function getOwnClipBox(element) {
  const style = getComputedStyleCached(element);
  const clipsX = hidesOverflow(style, "overflowX");
  const clipsY = hidesOverflow(style, "overflowY");
  if (!clipsX && !clipsY) {
    return UNCLIPPED;
  }
  const rect = getBoundingClientRectCached(element);
  const borderLeft = pixels(style.borderLeftWidth);
  const borderRight = pixels(style.borderRightWidth);
  const borderTop = pixels(style.borderTopWidth);
  const borderBottom = pixels(style.borderBottomWidth);
  /**
   * @param {string} radius
   * @param {number} first
   * @param {number} second
   * @returns {number}
   */
  const inset = (radius, first, second) => Math.max(pixels(radius) - Math.max(first, second), 0);
  return {
    left: clipsX ? rect.left + borderLeft : UNCLIPPED.left,
    right: clipsX ? rect.right - borderRight : UNCLIPPED.right,
    top: clipsY ? rect.top + borderTop : UNCLIPPED.top,
    bottom: clipsY ? rect.bottom - borderBottom : UNCLIPPED.bottom,
    // A corner is only rounded on the axes that are actually being clipped:
    // one that hides overflow in y alone cuts two straight horizontal lines.
    topLeft: clipsX && clipsY ? inset(style.borderTopLeftRadius, borderLeft, borderTop) : 0,
    topRight: clipsX && clipsY ? inset(style.borderTopRightRadius, borderRight, borderTop) : 0,
    bottomRight:
      clipsX && clipsY ? inset(style.borderBottomRightRadius, borderRight, borderBottom) : 0,
    bottomLeft:
      clipsX && clipsY ? inset(style.borderBottomLeftRadius, borderLeft, borderBottom) : 0,
  };
}

/** @type {WeakMap<Node, Derived<ClipBox>>} */
const clipBoxCache = new WeakMap();

/**
 * The region a node's ancestors confine it to, in client coordinates.
 *
 * Each level is derived from the level above, so the chain is memoized the
 * way every other layout read here is: a scroller that has not moved does not
 * recompute the clip of anything inside it. Equality is by value, so the
 * common case during a scroll — content moving inside a stationary window —
 * leaves this signal, and the uniforms hanging off it, alone.
 *
 * Who does the confining is decided by where the node's box *lives*, which
 * for a positioned element is not its parent. CSS hangs an absolutely
 * positioned box off its containing block — the nearest positioned ancestor —
 * so `overflow` ancestors *below* that block never clip it, which is how a
 * dropdown menu whose anchor sits outside a scroller escapes the scroller
 * its trigger row lives in; and a fixed box escapes every ancestor there is.
 * The clipping that does apply to it is exactly the clipping that applies to
 * its containing block's content — the block's own overflow included — and
 * that is a chain the block's ordinary children already share, so the
 * memoization survives the skip. (A transform or a filter also establishes a
 * containing block for positioned descendants; neither is modelled here, the
 * same way neither is modelled anywhere else in the mirror.)
 *
 * The walk stops at the portal's container. What the page around the scene
 * does with `body` is none of a panel's business, and its rect is not in the
 * panel's coordinate system anyway.
 *
 * @param {Node} node
 * @returns {ClipBox}
 */
export function getClipBoxCached(node) {
  let signal = clipBoxCache.get(node);
  if (!signal) {
    signal = new Derived(
      () => {
        // The portal's own container clips nothing and has nothing above it
        // worth consulting — the walk ends here rather than climbing out into
        // the page. (`nodeType` rather than `instanceof Element`: this runs in
        // environments where that global is not the document's.)
        const self = node.nodeType === 1 ? /** @type {Element} */ (node) : null;
        if (self?.hasAttribute(PORTAL_ATTRIBUTE)) {
          return UNCLIPPED;
        }
        const position = self ? getComputedStyleCached(self).position || "static" : "static";
        if (position === "fixed") {
          return UNCLIPPED;
        }
        // The box this node hangs off: its parent in the ordinary case, its
        // containing block when it is absolutely positioned.
        let holder = getParentElement(node);
        if (position === "absolute") {
          while (
            holder &&
            !holder.hasAttribute(PORTAL_ATTRIBUTE) &&
            (getComputedStyleCached(holder).position || "static") === "static"
          ) {
            holder = getParentElement(holder);
          }
        }
        if (!holder || holder.hasAttribute(PORTAL_ATTRIBUTE)) {
          return UNCLIPPED;
        }
        const inherited = getClipBoxCached(holder);
        const own = getOwnClipBox(holder);
        // Passing the inherited box through unchanged keeps the shared
        // UNCLIPPED object identical the whole way down a subtree nobody
        // clips, which is what lets the elements in it skip the rest.
        return own === UNCLIPPED ? inherited : intersectClipBoxes(inherited, own);
      },
      { isEqual: clipBoxEqual },
    );
    clipBoxCache.set(node, signal);
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
