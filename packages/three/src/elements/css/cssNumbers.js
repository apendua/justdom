/**
 * The numbers of a computed `matrix()` or `matrix3d()`, read without the
 * strings and arrays a split would make, since the motion step reads a
 * transform every frame it animates (`cssTransform.js`). The panel's frame
 * reads its scale through the same parser (`panelFrame.js`), so the two
 * agree on what counts as a matrix.
 */

/**
 * Where `readNumber` leaves off: the number it read, and the index of the
 * first character after it. One object for the module, since a read is
 * used before the next one starts.
 */
export const scanned = { value: 0, end: 0 };

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
export function readNumber(value, index) {
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
export const matrixScratch = new Float64Array(16);

/**
 * Read a computed `matrix(...)` or `matrix3d(...)` into `matrixScratch`,
 * answering how many values it has: 6, 16, or 0 for anything else. A
 * browser computes every transform to one of the two; jsdom passes the
 * author's value through, which counts as none here as it does for
 * `hasTransform`. The values are good until the next read.
 *
 * @param {string} value
 * @returns {number}
 */
export function readMatrix(value) {
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
