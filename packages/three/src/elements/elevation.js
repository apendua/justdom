import * as THREE from "three";
import { Derived } from "@apendua/signal";
import {
  getBorderBoxSize,
  getChildNodes,
  getComputedStyleCached,
  getParentElement,
  hasTransform,
  isTransformed,
  movesAgainstScroll,
  nodeCache,
  PORTAL_ATTRIBUTE,
} from "./mirror.js";
import { composeTransform, getBoxOffset, getOwnTransform } from "./cssTransform.js";
import { isSvgElement } from "./plugins.js";

/*
 * How a panel keeps one thing in front of another. A page decides that by
 * paint order alone; in the scene everything is a flat quad, so the depth
 * of each quad has to say it, and two quads on one plane are separated only
 * by draw order and rounding. The model has two halves.
 *
 * Boxes are stepped in geometry, here. Each element's object sits
 * `getLift` in front of its parent's content: `CONTENT_STEP` for an
 * ordinary box, `ELEVATION_STEP` more for an overlay (`isOverlay`), and for
 * an element in a painting layer (`getPaintLayer`) far enough to clear
 * every sibling it overlaps that a page paints under it, subtree included.
 * Within a layer, tree order decides. The box's
 * own quad is 1 px behind its object. `getElevation` puts overlays later in
 * `renderOrder` as well, since depth alone does not order transparent
 * quads.
 *
 * Marks are not stepped. Text, carets and list markers are drawn level with
 * the object of the box they belong to, so 1 px in front of its quad, with
 * no depth write and the polygon offset of `MARK_MATERIAL_SETTINGS` in
 * `textHelpers.js`, the offset a decal is drawn with. A mark therefore
 * always reaches the reader in front of its own box and behind anything
 * stepped in front of that box.
 *
 * SVG content is on neither side. The shapes, images and text inside an
 * `<svg>` are drawn level with it (`getReach` gives it none) and their
 * materials, in `svg/`, write no depth and take no polygon offset, so draw
 * order alone keeps them over the box behind them.
 *
 * The model's limits, each a place where the scene and the page can
 * disagree:
 *
 * - Flow siblings are not stepped. Only an element that is positioned or
 *   transformed clears its siblings, and only those that are too. A box
 *   pulled over a neighbour by a negative margin, or a positioned box over a
 *   flow sibling, stays on the same plane as what it covers.
 * - Only the sign of `z-index` counts. Two overlays, or two boxes with a
 *   negative `z-index`, stack in tree order, whatever their numbers.
 * - An overlay takes the larger of its two lifts, not the sum. Over a
 *   sibling it overlaps, it sits `CONTENT_STEP` in front of what that
 *   sibling draws rather than `ELEVATION_STEP` beyond it, so it does not
 *   read as hovering above that sibling. Its `renderOrder` still puts it
 *   last.
 * - A child that overflows its parent is not counted. Overlap is tested on
 *   border boxes (`getPaintedBounds`), so a later sibling that covers only
 *   a pin sticking out of an earlier card is not stepped past the pin, and
 *   the pin is drawn over it where a page would draw it under.
 * - A pile grows. Every card in a stack of overlapping cards clears all the
 *   ones under it, so the lift grows with the pile: on the bench's board of
 *   cards with labels, by 4 px a card, 402 px at 100 cards.
 * - An overlay that escapes its box is not stepped past that box's later
 *   siblings. Inside a box that is no stacking context, a pin with
 *   `z-index: 1` is painted over a later card, and the later card leaves it
 *   out of what it clears (`getContainedReach`). The pin still sits where
 *   its own box puts it, so a later card stepped past a deep box can reach
 *   in front of it.
 * - A box the scroll moves against its siblings, one anchored above a
 *   scroller its siblings scroll in, counts as covering everything. Every
 *   sibling a page paints over it is stepped past it, at every scroll
 *   position, rather than only those passing under it now.
 * - Stacking contexts are modelled for `z-index`, `position: fixed` and
 *   `sticky`, transforms and `opacity` only (`formsStackingContext`).
 * - Draw order does not follow the step. `renderOrder` is still the
 *   elevation and the tree depth, so the content of a card that a later
 *   sibling clears is drawn after that sibling's box, which has already
 *   written depth in front of it. Where the later card is translucent, a
 *   page shows the earlier card's label tinted through it, and the scene
 *   leaves a hole showing only the earlier card's own background.
 */

/**
 * How far in front of its parent each box sits, in the container's local px.
 * Small enough to read as one surface, large enough that a child never fights
 * its parent's background for the same pixels.
 */
const CONTENT_STEP = 2;

/**
 * The extra distance an overlay puts between itself and the surface it floats
 * above. A few times the ordinary step: enough that stereo reads it as
 * hovering rather than as one more nested box, and enough room underneath for
 * the tree it covers, however deep that happens to be. At the scale panels are
 * usually mounted at this is a matter of millimetres.
 */
const ELEVATION_STEP = 8;

/**
 * Whether an element asks to float above what it overlaps, rather than merely
 * sitting somewhere unusual. `position` other than `static` plus a positive
 * `z-index` is how the ordinary web says exactly that, so a menu, a popover or
 * a modal opts in through its stylesheet with no extra attribute — the same
 * bargain `cursor: pointer` strikes for ray targets.
 *
 * Plenty of absolutely positioned boxes are not overlays: a badge pinned to a
 * corner overlaps nothing and wants no layer of its own. Asking for `z-index`
 * as well keeps the declaration deliberate.
 *
 * The magnitude is not modelled — only whether the element is an overlay. Two
 * layers are expressed by nesting one inside the other, not by writing a
 * bigger number, because the depth the scene gives an overlay is a physical
 * offset and `z-index: 1000` is an idiom, not a distance.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isOverlay(element) {
  const style = getComputedStyleCached(element);
  if (!style.position || style.position === "static") {
    return false;
  }
  // "auto" — the overwhelmingly common value — parses to NaN, which is the
  // answer we want anyway.
  const zIndex = parseInt(style.zIndex, 10);
  return Number.isFinite(zIndex) && zIndex > 0;
}

/**
 * Where content belonging to `element` sits in the scene's draw order: the
 * same figure `VisualProperties.renderOrder` gives the element's own box,
 * except counted from the element itself — one deeper than the box — which
 * is where the element's *content* belongs. Text uses this: a glyph drawn
 * before the surface it sits on blends its antialiased edges with whatever
 * was behind the panel instead, and writes depth that then keeps the
 * surface out.
 *
 * @param {HTMLElement} element
 * @returns {number}
 */
export function getContentRenderOrder(element) {
  let layer = 0;
  /** @type {HTMLElement | null} */
  let el = element;
  while (el) {
    layer += 1;
    el = el.parentElement;
  }
  return getElevation(element) * 1000 + layer;
}

/**
 * How many overlays this element sits inside, counting itself. Nothing in a
 * plain panel is elevated at all; a dropdown menu is at 1, and a dropdown
 * inside a modal is at 2.
 *
 * Unlike the offset each layer contributes to its own position, this is an
 * absolute figure: `renderOrder` is compared across the whole scene rather
 * than against a parent, so it has to be counted from the top every time.
 *
 * @param {HTMLElement} element
 * @returns {number}
 */
export function getElevation(element) {
  let elevation = 0;
  /** @type {HTMLElement | null} */
  let el = element;
  while (el) {
    if (isOverlay(el)) {
      elevation += 1;
    }
    el = el.parentElement;
  }
  return elevation;
}

/**
 * @typedef {object} PaintedBounds
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * What an element whose bounds cannot be worked out is taken to cover:
 * everything, which is the answer that never leaves a sibling coplanar.
 *
 * @type {PaintedBounds}
 */
const EVERYWHERE = Object.freeze({
  left: -Infinity,
  top: -Infinity,
  right: Infinity,
  bottom: Infinity,
});

/** @typedef {-1 | 0 | 1 | null} PaintLayer */

/**
 * @param {PaintedBounds} a
 * @param {PaintedBounds} b
 * @returns {boolean}
 */
function boundsEqual(a, b) {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/**
 * Whether two boxes share any area. Boxes that only touch along an edge do
 * not: cards laid edge to edge on a board are not stacked.
 *
 * @param {PaintedBounds} a
 * @param {PaintedBounds} b
 * @returns {boolean}
 */
function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** @type {WeakMap<Element, Derived<PaintLayer>>} */
const paintLayerCache = nodeCache();

/**
 * Which of a page's painting layers an element is in, among the siblings a
 * page paints over one another, or `null` for a box in the flow. CSS paints
 * a positioned element (`position` other than `static`) and one with a
 * `transform` of its own after the flow. Within that, a negative `z-index`
 * goes under everything else (-1), a positive one over it (1, which is
 * `isOverlay`), and the rest are one layer (0). A later element covers an
 * earlier one in the same layer, and a higher layer covers a lower one
 * whatever the tree order. As with `isOverlay`, the number itself is not
 * modelled, only its sign.
 *
 * Behind its own signal, so that a restyle which leaves the answer alone
 * does not re-run the sibling scan in `getLift` for every other sibling.
 *
 * @param {Element} element
 * @returns {PaintLayer}
 */
function getPaintLayer(element) {
  let signal = paintLayerCache.get(element);
  if (!signal) {
    signal = new Derived(() => {
      const style = getComputedStyleCached(element);
      const positioned = !!style.position && style.position !== "static";
      if (!positioned) {
        return hasTransform(style.transform) ? 0 : null;
      }
      const zIndex = parseInt(style.zIndex, 10);
      return zIndex < 0 ? -1 : zIndex > 0 ? 1 : 0;
    });
    paintLayerCache.set(element, signal);
  }
  return signal.get();
}

/** Scratch for transforming an element's corners into its parent's frame. */
const cornerMatrix = new THREE.Matrix4();
const corner = new THREE.Vector3();

/** @type {WeakMap<Element, Derived<PaintedBounds>>} */
const paintedBoundsCache = nodeCache();

/**
 * The area an element covers in its parent's content space, the frame its
 * object is placed in: its border box at `getBoxOffset`. For an element with
 * a transform of its own this is the axis-aligned box around the four
 * transformed corners, so a rotated card is taken to cover every point its
 * corners span, which can be more than it does. A perspective that puts a
 * corner at or behind the eye gives no such box, and the element is taken
 * to cover everything. Descendants that overflow the border box are not
 * counted.
 *
 * @param {HTMLElement} element
 * @returns {PaintedBounds}
 */
function getPaintedBounds(element) {
  let signal = paintedBoundsCache.get(element);
  if (!signal) {
    signal = new Derived(
      () => {
        // A box the scroll moves against its siblings overlaps different
        // ones at every step of the scroll. Taken to cover everything, it
        // keeps the lifts, and the sibling scans behind them, out of the
        // scroll's frames.
        if (!isTransformed(element) && movesAgainstScroll(element)) {
          return EVERYWHERE;
        }
        const { width, height } = getBorderBoxSize(element);
        const offset = getBoxOffset(element);
        const own = getOwnTransform(element);
        if (!own) {
          return {
            left: offset.x,
            top: offset.y,
            right: offset.x + width,
            bottom: offset.y + height,
          };
        }
        composeTransform(cornerMatrix, offset.x, offset.y, 0, own.matrix, own.origin);
        const e = cornerMatrix.elements;
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (let i = 0; i < 4; i += 1) {
          const x = i & 1 ? width : 0;
          const y = i & 2 ? height : 0;
          // A perspective that sends a corner to or behind the eye has no
          // finite box to give: dividing by a w at or below zero would
          // mirror that corner to the wrong side rather than fail.
          if (e[3] * x + e[7] * y + e[15] <= 0) {
            return EVERYWHERE;
          }
          corner.set(x, y, 0).applyMatrix4(cornerMatrix);
          left = Math.min(left, corner.x);
          top = Math.min(top, corner.y);
          right = Math.max(right, corner.x);
          bottom = Math.max(bottom, corner.y);
        }
        return { left, top, right, bottom };
      },
      { isEqual: boundsEqual },
    );
    paintedBoundsCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element, Derived<number>>} */
const liftCache = nodeCache();

/**
 * How far in front of its parent's content the element's object sits, in
 * the container's local px. Its box quad is 1 px behind that and its text
 * is level with it.
 *
 * An ordinary box sits `CONTENT_STEP` in front, and an overlay another
 * `ELEVATION_STEP` on top of that. An element in a painting layer (see
 * `getPaintLayer`) also clears every sibling it overlaps that a page paints
 * under it: the earlier siblings in its own layer and every sibling in a
 * lower one. It goes `CONTENT_STEP` in front of the farthest thing a page
 * paints of that sibling under it, which is the sibling's lift plus its
 * reach: `getReach`, or `getContainedReach` when overlays inside the
 * sibling escape it and are painted over this element.
 * Without that, a clock hand and the dial under it are coplanar and the
 * depth test picks between them by rounding, the text of one card, 1 px in
 * front of its own quad, shows through a later card that covers it, and a
 * later `position: relative` page covers a modal before it. Siblings that
 * do not overlap stay at the ordinary step, so a board of separate cards
 * stays flat however many cards it holds.
 *
 * Reactive: it follows the style, layout and child list of the parent's
 * children and the reach of the siblings it clears. Nothing here runs per
 * frame. The scan reads every sibling's layer once per recompute, and the
 * bounds of those painted under it, so a parent with n positioned children
 * costs O(n²) cached reads when it is built, and again when its first child
 * moves, since every later child's scan read that child's bounds.
 *
 * @param {Element} element
 * @returns {number}
 */
export function getLift(element) {
  let signal = liftCache.get(element);
  if (!signal) {
    signal = new Derived(() => {
      const own = isOverlay(/** @type {HTMLElement} */ (element))
        ? CONTENT_STEP + ELEVATION_STEP
        : CONTENT_STEP;
      // The portal's root has no siblings inside the portal.
      const layer = element.hasAttribute(PORTAL_ATTRIBUTE) ? null : getPaintLayer(element);
      if (layer === null) {
        return own;
      }
      const parent = getParentElement(element);
      if (!parent) {
        return own;
      }
      const bounds = getPaintedBounds(/** @type {HTMLElement} */ (element));
      let lift = own;
      let earlier = true;
      for (const node of getChildNodes(parent)) {
        if (node === element) {
          earlier = false;
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }
        const sibling = /** @type {HTMLElement} */ (node);
        const below = getPaintLayer(sibling);
        if (below === null || below > layer || (below === layer && !earlier)) {
          continue;
        }
        if (!overlaps(bounds, getPaintedBounds(sibling))) {
          continue;
        }
        // The overlays that escape a sibling are painted in the overlay
        // layer at the sibling's place in the tree: under this element only
        // if it is an overlay that comes later.
        const reach =
          formsStackingContext(sibling) || (layer === 1 && earlier)
            ? getReach(sibling)
            : getContainedReach(sibling);
        lift = Math.max(lift, getLift(sibling) + reach + CONTENT_STEP);
      }
      return lift;
    });
    liftCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element, Derived<number>>} */
const reachCache = nodeCache();

/** @type {WeakMap<Element, Derived<number>>} */
const containedReachCache = nodeCache();

/**
 * How far in front of the element's own origin its descendants reach: the
 * largest lift plus reach among its child elements, or 0 for none. The
 * shapes inside an `<svg>` are drawn level with it, so an `<svg>` reaches
 * nowhere.
 *
 * @param {Element} element
 * @returns {number}
 */
function getReach(element) {
  let signal = reachCache.get(element);
  if (!signal) {
    signal = new Derived(() => measureReach(element, false));
    reachCache.set(element, signal);
  }
  return signal.get();
}

/**
 * `getReach` without the overlays that escape the element. An element that
 * is no stacking context (see `formsStackingContext`) does not paint its
 * subtree as one: an overlay inside it is painted in the stacking context
 * above, in front of the element's later siblings that are not overlays,
 * and so is an overlay inside a descendant that is no stacking context
 * either. What is left is what a page paints at the element's own place.
 *
 * @param {Element} element
 * @returns {number}
 */
function getContainedReach(element) {
  let signal = containedReachCache.get(element);
  if (!signal) {
    signal = new Derived(() => measureReach(element, true));
    containedReachCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @param {Element} element
 * @param {boolean} contained Whether to leave out the overlays that escape.
 * @returns {number}
 */
function measureReach(element, contained) {
  if (isSvgElement(element)) {
    return 0;
  }
  let reach = 0;
  for (const node of getChildNodes(element)) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    const child = /** @type {Element} */ (node);
    if (contained && getPaintLayer(child) === 1) {
      continue;
    }
    const inner =
      contained && !formsStackingContext(child) ? getContainedReach(child) : getReach(child);
    reach = Math.max(reach, getLift(child) + inner);
  }
  return reach;
}

/**
 * Whether a page paints the element and its subtree as one unit among its
 * siblings: a stacking context. A positioned element with a `z-index`, a
 * `fixed` or `sticky` one, one with a transform of its own, and one with an
 * `opacity` below 1 are. The rarer triggers (`filter`, `isolation`,
 * `will-change` and the like) are not modelled, and such an element is
 * taken to be none.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function formsStackingContext(element) {
  const style = getComputedStyleCached(element);
  if (style.position === "fixed" || style.position === "sticky") {
    return true;
  }
  if (
    !!style.position &&
    style.position !== "static" &&
    Number.isFinite(parseInt(style.zIndex, 10))
  ) {
    return true;
  }
  return hasTransform(style.transform) || parseFloat(style.opacity) < 1;
}
