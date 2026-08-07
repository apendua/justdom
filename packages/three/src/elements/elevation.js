import { getComputedStyleCached } from "./cache.js";

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
