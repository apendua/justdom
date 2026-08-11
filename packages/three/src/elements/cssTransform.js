import * as THREE from "three";
import { getComputedStyleCached, hasTransform, isTransformed } from "./mirror.js";

/**
 * CSS transforms, read off the computed style and turned into the matrices
 * the mirror hangs on its objects.
 *
 * Client rects are useless the moment a transform is involved: the browser
 * reports the transformed axis-aligned bounds, and a box that will get the
 * transform applied as its own object matrix has to be measured *without*
 * it. So transformed elements are measured off their layout offsets instead,
 * and text — which has no offsets — is measured with the transforms briefly
 * switched off, against a detached clone (see `mirror.js`).
 */

/**
 * A computed `transform` as a matrix in portal-local coordinates, or null
 * for none.
 *
 * CSS lists `matrix3d`'s sixteen values column-major — the same order
 * `Matrix4` stores its elements — and `matrix(a, b, c, d, e, f)` is the 2D
 * column-major shorthand of the same thing.
 *
 * The portal's frame is a *z-mirror* of the CSS one: the container flip
 * lines local y up with CSS y-down, but it leaves local +z pointing away
 * from the viewer, where CSS +z points toward them (portal content sits at
 * negative local z). A 3D matrix embedded verbatim would send every
 * `translateZ` backwards into the panel and spin every `rotateX`/`rotateY`
 * the wrong way round, so it is conjugated by the flip — S·M·S with
 * S = diag(1, 1, −1) — which negates the six entries coupling z to the
 * rest and leaves a 2D matrix exactly alone.
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
    const matrix = new THREE.Matrix4().fromArray(values);
    const e = matrix.elements;
    e[2] = -e[2];
    e[6] = -e[6];
    e[8] = -e[8];
    e[9] = -e[9];
    e[11] = -e[11];
    e[14] = -e[14];
    return matrix;
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
 * transform applied about its origin, at the element's layout position.
 * Everything here is already in portal-local coordinates — `parseTransform`
 * mirrors the z axis, `getOwnTransform` mirrors the origin's z — so this is
 * plain composition.
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
  // The origin's z is a CSS length (toward the viewer); local z runs the
  // other way — the same mirror the matrix itself is conjugated by.
  origin.z = -origin.z;
  return { matrix, origin };
}

// The question belongs to whatever answers "what does a client rect of this
// element mean", which is the cache — and the cache is where it has to live
// anyway, since the rect it guards now depends on it. Re-exported here
// because this is where the rest of the transform vocabulary is.
export { isTransformed };

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
