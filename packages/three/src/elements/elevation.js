import * as THREE from "three";
import { Signal } from "justdom-signal";
import {
  getBorderBoxSize,
  getBoxOffset,
  getChildNodes,
  getComputedStyleCached,
  getParentElement,
  getTextDataCached,
  getTransformStyle,
  hasTransform,
  isTransformed,
  movesAgainstScroll,
  nodeCache,
  nodeDerived,
} from "./mirror.js";
import { PORTAL_ATTRIBUTE } from "./portalRoot.js";
import { composeTransform, getOwnTransform, hasDepthTransform } from "./cssTransform.js";
import { isSvgElement } from "./plugins.js";
import { getShadowBleed, parseTextShadow } from "./textHelpers.js";
import { isTextInput } from "./typing.js";

/**
 * @import {Derived} from 'justdom-signal';
 */

/*
 * How a panel keeps one thing in front of another. A page decides that by
 * paint order alone, and a panel does the same: it draws its content level,
 * in the order the page paints it, so that nothing has to hide anything by
 * depth (`docs/freedom-paint-order.md`).
 *
 * Every element belongs to a layer (`getLayer`): the panel's root, an
 * overlay (`isOverlay`) or an element transformed out of its parent's
 * plane. Within a layer the draw level (`getDrawLevel`) counts from the
 * layer's root, a level past the parent, and an element that clears a
 * sibling (`getClearedSiblings`) draws after everything that sibling draws.
 * Each layer draws from a base (`getLayerBase`), which a walk of the panel's
 * layers in their tree (`layerTree.js`) writes, ordering them by their
 * planes (`layerOrder.js`). Only an overlay sits at a distance,
 * `OVERLAY_LIFT` in front of its parent's content, so that a menu still
 * floats in stereo; an element transformed out of its parent's plane is
 * where its own matrix puts it, and everything else is level with its
 * parent's content.
 *
 * SVG content is drawn within the `<svg>`'s content level (`paintSlot` in
 * `svg/shape.js`), so an SVG element is never a layer of its own.
 *
 * The model's limits, each a place where the scene and the page can
 * disagree:
 *
 * - A piece of a layer cut by other layers' planes is drawn with its first
 *   `MAX_HALF_PLANES` half-planes (`halfPlanes.js`), and no more.
 * - Both eyes draw the order walked from the midpoint between them, so a
 *   layer seen edge-on, mid-flip, can be out of order for one eye.
 * - Two layers in one plane are ordered as siblings are, by the sign of
 *   `z-index` (`comparePaintOrder` in `layerTree.js`).
 * - A `z-index` inside a box that forms no stacking context is read where
 *   the box is, among its siblings, and not let out of it as a page does.
 * - The pieces past a panel's slot (`PANEL_PIECES` in `layerOrder.js`)
 *   share one place, in no order among them, and a layer with a piece
 *   there is drawn whole.
 * - An element's painted bounds take in its own text's shadow but not the
 *   2 px a run's glyphs, drawn one by one, can come out wider than their
 *   box (`TEXT_RENDER_BLEED` in `textHelpers.js`). Where they do, the
 *   overhang is ink, and an item it overlaps can share its level and draw
 *   over or under it.
 * - Flow siblings are not ordered against each other. Only an element that
 *   is positioned or transformed clears its siblings, so a box pulled over
 *   a neighbour by a negative margin keeps its tree level.
 * - A positioned box clears a flow sibling it covers whole, descendants
 *   included. A page paints that sibling's positioned descendants in tree
 *   order with the box, so one later in the tree than the box draws under
 *   it here and over it on a page.
 * - Only the sign of `z-index` counts. Two overlays stack in tree order,
 *   whatever their numbers.
 * - A child that overflows its parent is not counted. Overlap is tested on
 *   painted bounds (`getPaintedBounds`), so a later sibling that covers
 *   only a pin sticking out of an earlier card does not draw after the pin.
 * - A pile climbs. Every card in a stack of overlapping cards clears all
 *   the ones under it, a level a card, which `PIECE_BAND` is sized for.
 * - A box the scroll moves against its siblings, one anchored above a
 *   scroller its siblings scroll in, counts as covering everything. Every
 *   sibling a page paints over it draws after it, at every scroll
 *   position, rather than only those passing under it now.
 */

/**
 * How far in front of its parent's content an overlay sits, in the
 * container's local px: the one element at a distance. Enough that stereo
 * reads it as hovering, and at the scale panels are usually mounted at a
 * matter of millimetres.
 */
export const OVERLAY_LIFT = 10;

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

/** @type {WeakMap<Element, Derived<Element>>} */
const layerCache = nodeCache();

/**
 * The root of the layer the element is drawn in: the
 * element itself when it is the panel's root, an overlay (`isOverlay`) or
 * transformed out of its parent's plane (`hasDepthTransform`), and its
 * parent's layer otherwise. What is inside an `<svg>` is drawn within the
 * `<svg>`'s content level, so an SVG element is never a layer of its own.
 * Gated by identity, so a restyle that leaves an element in its layer
 * stops here.
 *
 * @param {Element} element
 * @returns {Element}
 */
export function getLayer(element) {
  let signal = layerCache.get(element);
  if (!signal) {
    signal = nodeDerived(element, () => {
      const parent = getPanelParent(element);
      if (!parent) {
        return element;
      }
      const html = /** @type {HTMLElement} */ (element);
      if (!isSvgElement(element) && (isOverlay(html) || hasDepthTransform(html))) {
        return element;
      }
      return getLayer(parent);
    });
    layerCache.set(element, signal);
  }
  return signal.get();
}

/**
 * Where content belonging to `element` sits in the scene's draw order: one
 * level after the element's own box, which `VisualProperties.renderOrder`
 * puts at its layer's base plus `getDrawLevel`. That is the level of a
 * child's box, which the panel's one batch lays half a level later
 * (`BOX_BUCKET_BIAS` in `boxBatch.js`). Text uses
 * this: a glyph drawn before the surface it sits on blends its antialiased
 * edges with whatever was behind the panel instead, and writes depth that
 * then keeps the surface out.
 *
 * @param {HTMLElement} element
 * @returns {number}
 */
export function getContentRenderOrder(element) {
  return getRenderBand(element) + getDrawLevel(element) + 1;
}

/**
 * How many draw levels a piece of a layer has to itself (`getLayerBase`):
 * more than the deepest pile of cards a layer climbs through, a level a
 * card. A box's content and a batched box's bias (`BOX_BUCKET_BIAS`) stay
 * within its level's place, so a piece's draws never reach the next's.
 */
export const PIECE_BAND = 4096;

/**
 * The first order of the band `order` is in: the base of the piece that
 * draws at it.
 *
 * @param {number} order
 * @returns {number}
 */
export function bandBase(order) {
  return Math.floor(order / PIECE_BAND) * PIECE_BAND;
}

/** @type {WeakMap<Element, Signal<number | null>>} */
const layerBases = new WeakMap();

/**
 * @param {Element} layer
 * @returns {Signal<number | null>}
 */
function layerBaseSignal(layer) {
  let signal = layerBases.get(layer);
  if (!signal) {
    signal = Signal.of(/** @type {number | null} */ (null));
    layerBases.set(layer, signal);
  }
  return signal;
}

/**
 * Where the first piece of a layer of a panel starts in
 * the scene's draw order: what the panel's walk last wrote (`setLayerBase`),
 * which is the piece's place in the walk, or, before any walk, a
 * `PIECE_BAND` for each layer it is nested in. Reactive, so a layer the
 * walk moves takes its boxes and marks with it.
 *
 * @param {Element} layer
 * @returns {number}
 */
export function getLayerBase(layer) {
  return (
    layerBaseSignal(layer).get() ?? getElevation(/** @type {HTMLElement} */ (layer)) * PIECE_BAND
  );
}

/**
 * Put a layer's first piece where the panel's walk puts it.
 *
 * @param {Element} layer
 * @param {number} base A whole number of `PIECE_BAND`s.
 */
export function setLayerBase(layer, base) {
  const signal = layerBaseSignal(layer);
  if (signal.get() !== base) {
    signal.set(base);
  }
}

/**
 * Where the element's draw level counts from in the scene's draw order: its
 * layer's base.
 *
 * @param {HTMLElement} element
 * @returns {number}
 */
export function getRenderBand(element) {
  return getLayerBase(getLayer(element));
}

/** @type {WeakMap<HTMLElement, Derived<number>>} */
const elevationCache = nodeCache();

/**
 * How many layers this element sits inside (`getLayer`), not counting the
 * panel's root: the root is at 0, and each overlay or element transformed
 * out of its parent's plane one past the layer it is in. It places a
 * layer's base before the panel's first walk (`getLayerBase`). Cached for
 * each element as its parent's count and its own, so that a restyle above it
 * reaches its readers only when the count changes, and a box that left the
 * panel keeps the count it was drawn with (`nodeDerived`).
 *
 * @param {HTMLElement} element
 * @returns {number}
 */
export function getElevation(element) {
  let signal = elevationCache.get(element);
  if (!signal) {
    signal = nodeDerived(element, () => {
      const parent = getPanelParent(element);
      return parent ? (getLayer(element) === element ? 1 : 0) + getElevation(parent) : 0;
    });
    elevationCache.set(element, signal);
  }
  return signal.get();
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
export function overlaps(a, b) {
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
 * does not re-run the sibling scan in `getClearedSiblings` for every other
 * sibling.
 *
 * @param {Element} element
 * @returns {PaintLayer}
 */
export function getPaintLayer(element) {
  let signal = paintLayerCache.get(element);
  if (!signal) {
    signal = nodeDerived(element, () => {
      const style = getComputedStyleCached(element);
      const positioned = !!style.position && style.position !== "static";
      if (!positioned) {
        return hasTransform(getTransformStyle(element).transform) ? 0 : null;
      }
      const zIndex = parseInt(style.zIndex, 10);
      return zIndex < 0 ? -1 : zIndex > 0 ? 1 : 0;
    });
    paintLayerCache.set(element, signal);
  }
  return signal.get();
}

/** What an element without a shadowed text of its own adds to its box. */
const NO_BLEED = Object.freeze({ right: 0, bottom: 0 });

/**
 * How far the shadow of `element`'s own text reaches past its box: none
 * when it has no text of its own, since `text-shadow` is inherited by
 * every descendant and inked only where there are glyphs.
 *
 * @param {HTMLElement} element
 * @returns {{ right: number, bottom: number }}
 */
function ownShadowBleed(element) {
  // The shadow first: nearly every element has text and no shadow, and its
  // bounds then need not follow its children.
  const shadow = parseTextShadow(getComputedStyleCached(element).textShadow);
  if (!shadow || !drawsOwnText(element)) {
    return NO_BLEED;
  }
  return getShadowBleed(shadow);
}

/**
 * Whether `element` draws text of its own: a text child with characters
 * in it, read through its character data so that text filled in later
 * counts, or a field, whose value or placeholder `textInput.js` draws as
 * a run styled by the field itself. The portal picks fields by the same
 * test (`isTextInput`).
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
function drawsOwnText(element) {
  if (isTextInput(element)) {
    return true;
  }
  for (const node of getChildNodes(element)) {
    if (node.nodeType === Node.TEXT_NODE && getTextDataCached(/** @type {Text} */ (node)).trim()) {
      return true;
    }
  }
  return false;
}

/** Scratch for transforming an element's corners into its parent's frame. */
const cornerMatrix = new THREE.Matrix4();
const corner = new THREE.Vector3();

/** @type {WeakMap<Element, Derived<PaintedBounds>>} */
const paintedBoundsCache = nodeCache();

/** The origin `paintedBoundsInto` is given with no matrix to apply it to. */
const NO_ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 });

/**
 * The area `element` covers in its parent's content space with its border
 * box, `width` by `height`, at `x`, `y` and its own transform `matrix` about
 * `origin`, or none for `matrix` null: `getPaintedBounds` for numbers given
 * rather than read. Written into `out`, or `EVERYWHERE` when a corner goes
 * to or behind the eye. Allocates nothing, for the motion step's check of a
 * transform against the bounds its siblings were ordered by (`div.js`).
 *
 * @param {PaintedBounds} out
 * @param {HTMLElement} element
 * @param {number} x
 * @param {number} y
 * @param {number} borderWidth
 * @param {number} borderHeight
 * @param {THREE.Matrix4 | null} matrix
 * @param {{ x: number, y: number, z: number }} origin
 * @returns {PaintedBounds}
 */
export function paintedBoundsInto(out, element, x, y, borderWidth, borderHeight, matrix, origin) {
  const bleed = ownShadowBleed(element);
  const width = borderWidth + bleed.right;
  const height = borderHeight + bleed.bottom;
  if (!matrix) {
    out.left = x;
    out.top = y;
    out.right = x + width;
    out.bottom = y + height;
    return out;
  }
  composeTransform(cornerMatrix, x, y, 0, matrix, origin);
  const e = cornerMatrix.elements;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < 4; i += 1) {
    const cornerX = i & 1 ? width : 0;
    const cornerY = i & 2 ? height : 0;
    // A perspective that sends a corner to or behind the eye has no
    // finite box to give: dividing by a w at or below zero would
    // mirror that corner to the wrong side rather than fail.
    if (e[3] * cornerX + e[7] * cornerY + e[15] <= 0) {
      return EVERYWHERE;
    }
    corner.set(cornerX, cornerY, 0).applyMatrix4(cornerMatrix);
    left = Math.min(left, corner.x);
    top = Math.min(top, corner.y);
    right = Math.max(right, corner.x);
    bottom = Math.max(bottom, corner.y);
  }
  out.left = left;
  out.top = top;
  out.right = right;
  out.bottom = bottom;
  return out;
}

/**
 * The area an element covers in its parent's content space, the frame its
 * object is placed in: its border box at `getBoxOffset`. For an element with
 * a transform of its own this is the axis-aligned box around the four
 * transformed corners, so a rotated card is taken to cover every point its
 * corners span, which can be more than it does. A perspective that puts a
 * corner at or behind the eye gives no such box, and the element is taken
 * to cover everything. Descendants that overflow the border box are not
 * counted. The box takes in the shadow of the element's own text, which is
 * ink past it (`getShadowBleed`).
 *
 * @param {HTMLElement} element
 * @returns {PaintedBounds}
 */
export function getPaintedBounds(element) {
  let signal = paintedBoundsCache.get(element);
  if (!signal) {
    signal = nodeDerived(
      element,
      () => {
        // A box the scroll moves against its siblings overlaps different
        // ones at every step of the scroll. Taken to cover everything, it
        // keeps the draw levels, and the sibling scans behind them, out of
        // the scroll's frames.
        if (!isTransformed(element) && movesAgainstScroll(element)) {
          return EVERYWHERE;
        }
        const size = getBorderBoxSize(element);
        const offset = getBoxOffset(element);
        const own = getOwnTransform(element);
        return paintedBoundsInto(
          { left: 0, top: 0, right: 0, bottom: 0 },
          element,
          offset.x,
          offset.y,
          size.width,
          size.height,
          own ? own.matrix : null,
          own ? own.origin : NO_ORIGIN,
        );
      },
      { isEqual: boundsEqual },
    );
    paintedBoundsCache.set(element, signal);
  }
  return signal.get();
}

/** @type {readonly Element[]} */
const NOTHING_CLEARED = Object.freeze([]);

/**
 * @param {readonly Element[]} a
 * @param {readonly Element[]} b
 * @returns {boolean}
 */
function clearedEqual(a, b) {
  return a.length === b.length && a.every((sibling, i) => sibling === b[i]);
}

/** @type {WeakMap<Element, Derived<readonly Element[]>>} */
const clearedCache = nodeCache();

/**
 * The siblings an element draws after, in tree order. An element in a
 * painting layer (see `getPaintLayer`) clears every sibling it overlaps
 * that a page paints under it: the earlier siblings in its own layer,
 * every sibling in a lower one and every flow sibling, earlier or later,
 * since a page paints the flow first. Without that, the text of one card
 * would draw over a later card that covers it. Siblings that do not overlap
 * are not cleared, so a board of separate cards shares its levels however
 * many cards it holds. A box with a negative `z-index` clears nothing, and nor
 * does the portal's root.
 *
 * This is the one place the paint-layer and overlap rules are applied.
 * Whatever orders an element against its siblings reads it rather than
 * scanning again: `getDrawLevel`, and the paint-order count in
 * `test/paintOrderCount.js`.
 *
 * Reactive: it follows the style, layout and child list of the parent's
 * children. Nothing here runs per frame. The scan reads every sibling's
 * layer once per recompute, and the bounds of those painted under it, so a
 * parent with n positioned children costs O(n²) cached reads when it is
 * built, and again when its first child moves, since every later child's
 * scan read that child's bounds. Flow siblings are painted under it too, so
 * one badge in a list of n rows reads n bounds, and its scan reruns when
 * any row's layout changes. Behind an equality gate, so a sibling that
 * moved without changing what is cleared stops here.
 *
 * @param {Element} element
 * @returns {readonly Element[]}
 */
export function getClearedSiblings(element) {
  let signal = clearedCache.get(element);
  if (!signal) {
    signal = nodeDerived(
      element,
      () => {
        // The portal's root has no siblings inside the portal.
        const layer = element.hasAttribute(PORTAL_ATTRIBUTE) ? null : getPaintLayer(element);
        // A box with a negative `z-index` clears nothing either: anything it
        // cleared would also put it after its flow siblings, which a page
        // paints over it.
        if (layer === null || layer === -1) {
          return NOTHING_CLEARED;
        }
        const parent = getParentElement(element);
        if (!parent) {
          return NOTHING_CLEARED;
        }
        const bounds = getPaintedBounds(/** @type {HTMLElement} */ (element));
        /** @type {Element[] | null} */
        let cleared = null;
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
          // A flow sibling is under the element in either tree order: a
          // page paints the flow before any positioned box.
          if (below !== null && (below > layer || (below === layer && !earlier))) {
            continue;
          }
          if (!overlaps(bounds, getPaintedBounds(sibling))) {
            continue;
          }
          (cleared ??= []).push(sibling);
        }
        return cleared ?? NOTHING_CLEARED;
      },
      { isEqual: clearedEqual },
    );
    clearedCache.set(element, signal);
  }
  return signal.get();
}

/**
 * The element's parent within its panel, or null for the panel's root,
 * above which everything is the page's.
 *
 * @param {Element} element
 * @returns {HTMLElement | null}
 */
function getPanelParent(element) {
  return element.hasAttribute(PORTAL_ATTRIBUTE) ? null : getParentElement(element);
}

/** @type {WeakMap<Element, Derived<number>>} */
const drawLevelCache = nodeCache();

/**
 * Where the element's box sits in the draw order, counted from its layer's
 * base (`getLayerBase`). Its content draws one level later
 * (`getContentRenderOrder`).
 *
 * A layer's root is at level 0, and the rest of the layer counts from it, a
 * level past the parent, so its levels are the order a page paints it in
 * and nothing has to hide anything by depth. An element that clears
 * siblings (see `getClearedSiblings`) draws after everything such a sibling
 * draws, at `getDrawLevel(sibling) + getDrawReach(sibling) + 1` where that
 * is higher, and its subtree comes with it. Only the siblings in its own
 * layer count: the panel's walk places the rest, sibling layers included.
 * A pile of cards climbs a level a card, which `PIECE_BAND` is sized for.
 *
 * @param {Element} element
 * @returns {number}
 */
export function getDrawLevel(element) {
  let signal = drawLevelCache.get(element);
  if (!signal) {
    signal = nodeDerived(element, () => {
      const parent = getPanelParent(element);
      if (!parent || getLayer(element) === element) {
        return 0;
      }
      let level = getDrawLevel(parent) + 1;
      for (const sibling of getClearedSiblings(element)) {
        if (getLayer(sibling) !== sibling) {
          level = Math.max(level, getDrawLevel(sibling) + getDrawReach(sibling) + 1);
        }
      }
      return level;
    });
    drawLevelCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element, Derived<number>>} */
const drawReachCache = nodeCache();

/**
 * How many levels past its own draw level an element's subtree draws: 1 for
 * its own content alone, and more for each descendant whose box or content
 * draws later. A layer inside it is left out, since the panel's walk places
 * it, and so is what is inside an `<svg>`, which is drawn within the
 * `<svg>`'s content level (`paintSlot` in `svg/shape.js`).
 *
 * @param {Element} element
 * @returns {number}
 */
function getDrawReach(element) {
  let signal = drawReachCache.get(element);
  if (!signal) {
    signal = nodeDerived(element, () => {
      if (isSvgElement(element)) {
        return 1;
      }
      const level = getDrawLevel(element);
      let reach = 1;
      for (const node of getChildNodes(element)) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }
        const child = /** @type {HTMLElement} */ (node);
        if (getLayer(child) === child) {
          continue;
        }
        reach = Math.max(reach, getDrawLevel(child) - level + getDrawReach(child));
      }
      return reach;
    });
    drawReachCache.set(element, signal);
  }
  return signal.get();
}
