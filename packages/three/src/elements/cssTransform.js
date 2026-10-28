import * as THREE from "three";
import { getComputedStyleCached, hasTransform, isTransformed } from "./mirror.js";
import { matrixValues } from "./panelFrame.js";

/**
 * CSS transforms, read off the computed style and turned into the matrices
 * the mirror hangs on its objects.
 *
 * Client rects are useless the moment a transform is involved: the browser
 * reports the transformed axis-aligned bounds, and a box that will get the
 * transform applied as its own object matrix has to be measured *without*
 * it. So transformed elements are measured off their layout offsets instead,
 * by `getBoxOffset`. Text has no offsets, so it is measured with the
 * transforms briefly switched off, against a detached clone. Both live in
 * `mirror.js` beside the client-rect readers they stand in for, and this
 * module keeps the matrices.
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
  const values = matrixValues(value);
  if (!values) {
    return null;
  }
  if (values.length === 16) {
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

/**
 * Whether the element's own transform moves it out of its parent's plane: a
 * `translateZ` other than 0, a `rotateX` or `rotateY`, a perspective. A
 * computed style gives any 3D function as `matrix3d(...)`, planar ones such
 * as `translateZ(0)` and `translate3d(x, y, 0)` included, so the matrix is
 * read: out of the plane is a z row or column that is not the identity's,
 * or a perspective term in the bottom row, which divides the box by a `w`
 * that varies across it and can take part of it behind the eye.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function hasDepthTransform(element) {
  const matrix = parseTransform(getComputedStyleCached(element).transform);
  if (!matrix) {
    return false;
  }
  const e = matrix.elements;
  return (
    e[2] !== 0 ||
    e[3] !== 0 ||
    e[6] !== 0 ||
    e[7] !== 0 ||
    e[8] !== 0 ||
    e[9] !== 0 ||
    e[11] !== 0 ||
    e[14] !== 0 ||
    e[10] !== 1
  );
}

// The question belongs to whatever answers "what does a client rect of this
// element mean", which is the cache — and the cache is where it has to live
// anyway, since the rect it guards now depends on it. Re-exported here
// because this is where the rest of the transform vocabulary is.
export { isTransformed };
