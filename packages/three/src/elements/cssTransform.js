import * as THREE from "three";
import { getTransformStyle, hasTransform, isTransformed } from "./mirror.js";

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
 * Where `readNumber` leaves off: the number it read, and the index of the
 * first character after it. One object for the module, since a read is
 * used before the next one starts.
 */
const scanned = { value: 0, end: 0 };

/**
 * The powers of ten a float holds exactly, the most `readNumber` scales by
 * in one step.
 */
const POWERS_OF_TEN = [
  1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17,
  1e18, 1e19, 1e20, 1e21, 1e22,
];

/**
 * Read the number `value` spells from `index` on, skipping spaces before
 * it, into `scanned`, as `Number.parseFloat` would read it: a sign, digits
 * with an optional fraction, and an optional exponent. Reads nothing, and
 * answers false, where no digit is. Allocates nothing for the numbers a
 * computed style gives, which is the reason for it: a transform animating
 * is parsed every frame.
 *
 * The digits are read as one integer and scaled by a power of ten in one
 * division or product, which rounds once, as `Number.parseFloat` does, while
 * the integer and the power are exact. Past that, an integer past
 * `Number.MAX_SAFE_INTEGER` or a power past 1e22, it hands the text to
 * `Number.parseFloat`.
 *
 * @param {string} value
 * @param {number} index
 * @returns {boolean}
 */
function readNumber(value, index) {
  let at = index;
  while (value.charCodeAt(at) === 32) {
    at += 1;
  }
  const start = at;
  let sign = 1;
  const first = value.charCodeAt(at);
  if (first === 45 || first === 43) {
    sign = first === 45 ? -1 : 1;
    at += 1;
  }
  let digits = 0;
  let mantissa = 0;
  let exponent = 0;
  for (let code = value.charCodeAt(at); code >= 48 && code <= 57; code = value.charCodeAt(at)) {
    mantissa = mantissa * 10 + (code - 48);
    digits += 1;
    at += 1;
  }
  if (value.charCodeAt(at) === 46) {
    at += 1;
    for (let code = value.charCodeAt(at); code >= 48 && code <= 57; code = value.charCodeAt(at)) {
      mantissa = mantissa * 10 + (code - 48);
      exponent -= 1;
      digits += 1;
      at += 1;
    }
  }
  if (digits === 0) {
    return false;
  }
  const e = value.charCodeAt(at);
  if (e === 101 || e === 69) {
    let after = at + 1;
    let exponentSign = 1;
    const signed = value.charCodeAt(after);
    if (signed === 45 || signed === 43) {
      exponentSign = signed === 45 ? -1 : 1;
      after += 1;
    }
    let written = 0;
    let exponentDigits = 0;
    for (
      let code = value.charCodeAt(after);
      code >= 48 && code <= 57;
      code = value.charCodeAt(after)
    ) {
      written = written * 10 + (code - 48);
      exponentDigits += 1;
      after += 1;
    }
    if (exponentDigits > 0) {
      exponent += exponentSign * written;
      at = after;
    }
  }
  scanned.end = at;
  if (mantissa > Number.MAX_SAFE_INTEGER || exponent > 22 || exponent < -22) {
    scanned.value = Number.parseFloat(value.slice(start, at));
    return true;
  }
  const scaled =
    exponent < 0 ? mantissa / POWERS_OF_TEN[-exponent] : mantissa * POWERS_OF_TEN[exponent];
  scanned.value = sign * scaled;
  return true;
}

/** The six or sixteen values of the last matrix `readMatrix` read. */
const matrixScratch = new Float64Array(16);

/**
 * Read a computed `matrix(...)` or `matrix3d(...)` into `matrixScratch`,
 * answering how many values it has: 6, 16, or 0 for anything else. The same
 * values `matrixValues` in `panelFrame.js` reads, without the arrays.
 *
 * @param {string} value
 * @returns {number}
 */
function readMatrix(value) {
  let at;
  let expected;
  if (value.startsWith("matrix3d(")) {
    at = 9;
    expected = 16;
  } else if (value.startsWith("matrix(")) {
    at = 7;
    expected = 6;
  } else {
    return 0;
  }
  for (let index = 0; index < expected; index++) {
    if (!readNumber(value, at)) {
      return 0;
    }
    matrixScratch[index] = scanned.value;
    at = scanned.end;
    while (value.charCodeAt(at) === 32) {
      at += 1;
    }
    const separator = value.charCodeAt(at);
    if (separator !== (index === expected - 1 ? 41 : 44)) {
      return 0;
    }
    at += 1;
  }
  return expected;
}

/**
 * A computed `transform` as a matrix in portal-local coordinates, written
 * into `target`; false, and `target` untouched, for none.
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
 * @param {THREE.Matrix4} target
 * @returns {boolean}
 */
export function parseTransformInto(value, target) {
  if (!hasTransform(value)) {
    return false;
  }
  const count = readMatrix(value);
  const v = matrixScratch;
  if (count === 16) {
    target.set(
      v[0],
      v[4],
      -v[8],
      v[12],
      v[1],
      v[5],
      -v[9],
      v[13],
      -v[2],
      -v[6],
      v[10],
      -v[14],
      v[3],
      v[7],
      -v[11],
      v[15],
    );
    return true;
  }
  if (count === 6) {
    target.set(v[0], v[2], 0, v[4], v[1], v[3], 0, v[5], 0, 0, 1, 0, 0, 0, 0, 1);
    return true;
  }
  return false;
}

/**
 * `parseTransformInto` into a matrix of its own, or null for none.
 *
 * @param {string} value
 * @returns {THREE.Matrix4 | null}
 */
export function parseTransform(value) {
  const matrix = new THREE.Matrix4();
  return parseTransformInto(value, matrix) ? matrix : null;
}

/**
 * One component of a computed `transform-origin`, the token of `value` that
 * starts at `index`, resolved against `size`: a length as it stands, a
 * percentage of `size`, and anything else, a keyword included, the centre.
 * Leaves in `scanned.end` where the token ends.
 *
 * @param {string} value
 * @param {number} index
 * @param {number} size
 * @returns {number}
 */
function readOriginComponent(value, index, size) {
  let at = index;
  while (value.charCodeAt(at) === 32) {
    at += 1;
  }
  const read = readNumber(value, at);
  const parsed = scanned.value;
  let end = read ? scanned.end : at;
  const unit = value.charCodeAt(end);
  while (end < value.length && value.charCodeAt(end) !== 32) {
    end += 1;
  }
  scanned.end = end;
  if (!read) {
    return size / 2;
  }
  return unit === 37 ? (parsed / 100) * size : parsed;
}

/**
 * A computed `transform-origin`, resolved against the untransformed border
 * box and written into `out`. Computed values are always lengths in px;
 * percentages (jsdom passes author values through) resolve too, and
 * anything else — keywords included — falls back to the center, which is
 * also CSS's default for an absent component.
 *
 * @param {string} value
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number, z: number }} out
 * @returns {{ x: number, y: number, z: number }}
 */
export function parseTransformOriginInto(value, width, height, out) {
  const text = value ?? "";
  out.x = readOriginComponent(text, 0, width);
  out.y = readOriginComponent(text, scanned.end, height);
  let at = scanned.end;
  while (text.charCodeAt(at) === 32) {
    at += 1;
  }
  out.z = readNumber(text, at) ? scanned.value || 0 : 0;
  return out;
}

/**
 * `parseTransformOriginInto` into an object of its own.
 *
 * @param {string} value
 * @param {number} width
 * @param {number} height
 * @returns {{ x: number, y: number, z: number }}
 */
export function parseTransformOrigin(value, width, height) {
  return parseTransformOriginInto(value, width, height, { x: 0, y: 0, z: 0 });
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
 * The element's own CSS transform and its origin, written into `matrix` and
 * `origin`; false, and both untouched, when it has none. The origin is
 * resolved against `width` by `height`, the box the transform applies to.
 * Allocates nothing, for a transform read every frame it animates.
 *
 * @param {HTMLElement} element
 * @param {number} width
 * @param {number} height
 * @param {THREE.Matrix4} matrix
 * @param {{ x: number, y: number, z: number }} origin
 * @returns {boolean}
 */
export function readOwnTransform(element, width, height, matrix, origin) {
  const style = getTransformStyle(element);
  if (!parseTransformInto(style.transform, matrix)) {
    return false;
  }
  parseTransformOriginInto(style.transformOrigin, width, height, origin);
  // The origin's z is a CSS length (toward the viewer); local z runs the
  // other way — the same mirror the matrix itself is conjugated by.
  origin.z = -origin.z;
  return true;
}

/**
 * The element's own CSS transform with its origin, or null when it has none.
 *
 * @param {HTMLElement} element
 * @returns {{ matrix: THREE.Matrix4, origin: { x: number, y: number, z: number } } | null}
 */
export function getOwnTransform(element) {
  const matrix = new THREE.Matrix4();
  const origin = { x: 0, y: 0, z: 0 };
  return readOwnTransform(element, element.offsetWidth, element.offsetHeight, matrix, origin)
    ? { matrix, origin }
    : null;
}

/** What `hasDepthTransform` reads a matrix into. */
const depthScratch = new THREE.Matrix4();

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
  if (!parseTransformInto(getTransformStyle(element).transform, depthScratch)) {
    return false;
  }
  const e = depthScratch.elements;
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
