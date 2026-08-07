import * as THREE from "three";
import { getComputedStyleCached, PORTAL_ATTRIBUTE } from "./cache.js";

/**
 * CSS transforms, read off the computed style and turned into the matrices
 * the mirror hangs on its objects.
 *
 * Client rects are useless the moment a transform is involved: the browser
 * reports the transformed axis-aligned bounds, and a box that will get the
 * transform applied as its own object matrix has to be measured *without*
 * it. So everything transformed is measured off the layout instead — offsets
 * for elements, and for text (which has no offsets) the transformed rects
 * with the accumulated transform divided back out.
 */

/**
 * Whether a computed `transform` value is one `parseTransform` accepts.
 * Browsers serialize every computed transform — however it was authored — to
 * a single `matrix()`/`matrix3d()`, so under a real engine this is exactly
 * "has a transform". (jsdom passes author values through verbatim; anything
 * unrecognized counts as untransformed there, consistently in both
 * functions.)
 *
 * @param {string} value
 * @returns {boolean}
 */
function hasTransform(value) {
  return !!value && value !== "none" && value.startsWith("matrix");
}

/**
 * A computed `transform` as a matrix, or null for none.
 *
 * CSS lists `matrix3d`'s sixteen values column-major — the same order
 * `Matrix4` stores its elements — and `matrix(a, b, c, d, e, f)` is the 2D
 * column-major shorthand of the same thing.
 *
 * @param {string} value
 * @returns {THREE.Matrix4 | null}
 */
export function parseTransform(value) {
  if (!hasTransform(value)) {
    return null;
  }
  const match = value.match(/^matrix(3d)?\(([^)]*)\)/);
  if (!match) {
    return null;
  }
  const values = match[2].split(",").map((part) => Number.parseFloat(part));
  if (values.some(Number.isNaN)) {
    return null;
  }
  if (match[1]) {
    if (values.length !== 16) {
      return null;
    }
    return new THREE.Matrix4().fromArray(values);
  }
  if (values.length !== 6) {
    return null;
  }
  const [a, b, c, d, e, f] = values;
  return new THREE.Matrix4().fromArray([a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1]);
}

/**
 * @param {string} part
 * @param {number} size
 * @returns {number}
 */
function resolveOriginComponent(part, size) {
  const parsed = Number.parseFloat(part);
  if (Number.isNaN(parsed)) {
    return size / 2;
  }
  if (part.endsWith("%")) {
    return (parsed / 100) * size;
  }
  return parsed;
}

/**
 * A computed `transform-origin`, resolved against the untransformed border
 * box. Computed values are always lengths in px; percentages (jsdom passes
 * author values through) resolve too, and anything else — keywords
 * included — falls back to the center, which is also CSS's default for an
 * absent component.
 *
 * @param {string} value
 * @param {number} width
 * @param {number} height
 * @returns {{ x: number, y: number, z: number }}
 */
export function parseTransformOrigin(value, width, height) {
  const [first = "", second = "", third = "0"] = value ? value.trim().split(/\s+/) : [];
  return {
    x: resolveOriginComponent(first, width),
    y: resolveOriginComponent(second, height),
    z: Number.parseFloat(third) || 0,
  };
}

const scratch = new THREE.Matrix4();

/**
 * `T(position) · T(origin) · M · T(−origin)`, written into `target`: the CSS
 * transform applied about its origin, at the element's layout position. The
 * portal's container flip already makes local space y-down px — the same
 * coordinate system CSS transforms are written in — so the matrix embeds
 * with no axis fixups.
 *
 * @param {THREE.Matrix4} target
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {THREE.Matrix4} matrix
 * @param {{ x: number, y: number, z: number }} origin
 * @returns {THREE.Matrix4}
 */
export function composeTransform(target, x, y, z, matrix, origin) {
  target.makeTranslation(x + origin.x, y + origin.y, z + origin.z);
  target.multiply(matrix);
  target.multiply(scratch.makeTranslation(-origin.x, -origin.y, -origin.z));
  return target;
}

/**
 * The element's own CSS transform with its origin, or null when it has none.
 *
 * @param {HTMLElement} element
 * @returns {{ matrix: THREE.Matrix4, origin: { x: number, y: number, z: number } } | null}
 */
export function getOwnTransform(element) {
  const style = getComputedStyleCached(element);
  const matrix = parseTransform(style.transform);
  if (!matrix) {
    return null;
  }
  const origin = parseTransformOrigin(
    style.transformOrigin,
    element.offsetWidth,
    element.offsetHeight,
  );
  return { matrix, origin };
}

/**
 * Whether the element, or anything above it inside the portal, carries a CSS
 * transform — the question every measurement asks before trusting a client
 * rect, because an ancestor's transform pollutes the rects of the whole
 * subtree under it.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isTransformed(element) {
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
 * @param {HTMLElement} element
 * @returns {{ x: number, y: number }}
 */
function pageOffset(element) {
  let x = 0;
  let y = 0;
  /** @type {Element | null} */
  let el = element;
  while (el instanceof HTMLElement) {
    x += el.offsetLeft;
    y += el.offsetTop;
    /** @type {Element | null} */
    const parent = el.offsetParent;
    if (parent instanceof HTMLElement) {
      // Offsets are measured to the offset parent's padding edge; crossing
      // into it adds its border.
      x += parent.clientLeft;
      y += parent.clientTop;
    }
    el = parent;
  }
  return { x, y };
}

/**
 * Where the element's border box sits relative to `from`, in layout terms —
 * the offsets the browser worked out before any transform was applied, which
 * is the position a transformed box needs since its object carries the
 * transform itself. Whole px only, and blind to scrolled ancestors (overflow
 * is not mirrored yet); the untransformed path keeps its subpixel client
 * rects.
 *
 * The two offset chains need not run through each other — an absolutely
 * positioned child offsets against an ancestor further up than its parent —
 * so both sides resolve to page coordinates and the difference is taken
 * there.
 *
 * @param {HTMLElement} element
 * @param {HTMLElement | null} from
 * @returns {{ x: number, y: number }}
 */
export function untransformedOffset(element, from) {
  const position = pageOffset(element);
  if (!from) {
    return position;
  }
  const base = pageOffset(from);
  return { x: position.x - base.x, y: position.y - base.y };
}

/**
 * Undo the linear part of every CSS transform between the portal root and
 * `element` (inclusive) on a screen-space vector, giving the vector in the
 * element's own untransformed px.
 *
 * Text has no layout offsets to fall back on, so its measurements start from
 * client rects and get the accumulated transform divided back out. Deltas
 * between two points shed the translations, which leaves the linear parts —
 * exact under any mix of translations and scales. A rotated ancestor only
 * ever hands back axis-aligned bounds, so under rotation this is an
 * approximation.
 *
 * @param {HTMLElement} element
 * @param {number} x
 * @param {number} y
 * @returns {{ x: number, y: number }}
 */
export function untransformVector(element, x, y) {
  // Accumulate A = M_outer · … · M_inner, in the CSS layout where
  // x' = a·x + c·y and y' = b·x + d·y.
  let a = 1;
  let b = 0;
  let c = 0;
  let d = 1;
  /** @type {HTMLElement | null} */
  let el = element;
  while (el && !el.hasAttribute(PORTAL_ATTRIBUTE)) {
    const matrix = parseTransform(getComputedStyleCached(el).transform);
    if (matrix) {
      const m = matrix.elements;
      const [ma, mb, mc, md] = [m[0], m[1], m[4], m[5]];
      const na = ma * a + mc * b;
      const nb = mb * a + md * b;
      const nc = ma * c + mc * d;
      const nd = mb * c + md * d;
      a = na;
      b = nb;
      c = nc;
      d = nd;
    }
    el = el.parentElement;
  }
  if (a === 1 && b === 0 && c === 0 && d === 1) {
    return { x, y };
  }
  const det = a * d - b * c;
  if (!det) {
    // A dimension scaled to nothing has no inverse and nothing sensible to
    // draw; leave the vector alone rather than blowing it up.
    return { x, y };
  }
  return { x: (d * x - c * y) / det, y: (a * y - b * x) / det };
}
