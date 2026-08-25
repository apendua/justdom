/**
 * Where a replaced element's image goes inside the box CSS gave it —
 * `object-fit` and `object-position`, as arithmetic.
 *
 * Layout decides the element's size; the image inside it has a size of its
 * own, and the two agree only by accident. CSS resolves that with a concrete
 * object size (`object-fit`) placed in the content box (`object-position`),
 * and the result is allowed to overflow — `cover` and `none` routinely do,
 * and the overflow is clipped by the content box rather than shrunk to fit.
 *
 * All of it is pure arithmetic over four numbers and two strings, which is
 * the point: the shader is handed a rectangle, and everything that could be
 * got wrong about `object-position: right 25%` is decided here, where a test
 * can look at it. Nothing in this file touches the DOM or three.
 */

/**
 * @typedef {object} Size
 * @property {number} width
 * @property {number} height
 */

/**
 * Where the image lands, relative to the content box's own top-left corner,
 * y running down like everywhere else in a portal.
 *
 * @typedef {object} ImageRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * One axis of `object-position`, split the way CSS defines it: a percentage
 * aligns that fraction of the image with the same fraction of the box, and a
 * length is a plain offset from the box's leading edge. Both are kept because
 * the two-value form allows both at once (`object-position: 10px 50%`), and
 * because a percentage means nothing until the free space is known.
 *
 * @typedef {object} PositionComponent
 * @property {number} percent
 * @property {number} length
 */

/** @type {PositionComponent} */
const CENTER = { percent: 50, length: 0 };

/** @type {Record<string, PositionComponent>} */
const KEYWORDS = {
  left: { percent: 0, length: 0 },
  top: { percent: 0, length: 0 },
  center: CENTER,
  right: { percent: 100, length: 0 },
  bottom: { percent: 100, length: 0 },
};

const HORIZONTAL = new Set(["left", "right"]);
const VERTICAL = new Set(["top", "bottom"]);

/**
 * One token of `object-position`, or null if it is not something this
 * understands — `calc()` above all, which browsers do produce for the
 * edge-relative four-value syntax (`right 10px bottom 20px`). Callers fall
 * back to centring that axis, which is what an unpositioned image does.
 *
 * @param {string} token
 * @returns {PositionComponent | null}
 */
function parseComponent(token) {
  const keyword = KEYWORDS[token];
  if (keyword) {
    return keyword;
  }
  const value = parseFloat(token);
  if (!Number.isFinite(value)) {
    return null;
  }
  if (token.endsWith("%")) {
    return { percent: value, length: 0 };
  }
  if (token.endsWith("px") || String(value) === token) {
    return { percent: 0, length: value };
  }
  // An em, an rem, a vh: a browser resolves every one of these to px before
  // it reaches a computed style, so anything left here came from somewhere
  // that does not, and guessing the font size to convert it would be worse
  // than centring.
  return null;
}

/**
 * `object-position` as two axes.
 *
 * Computed values arrive normalized — Chromium says `50% 50%` where the
 * author wrote `center` — but the author's own vocabulary is accepted too,
 * keyword order included: `top left` means the same as `left top`, and a
 * single value leaves the other axis centred.
 *
 * @param {string} value
 * @returns {[PositionComponent, PositionComponent]}
 */
export function parseObjectPosition(value) {
  const tokens = (value || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 2) {
    return [CENTER, CENTER];
  }
  if (tokens.length === 1) {
    const only = parseComponent(tokens[0]) ?? CENTER;
    return VERTICAL.has(tokens[0]) ? [CENTER, only] : [only, CENTER];
  }
  // `top left` and `left top` are the same declaration; only keywords can say
  // which axis they belong to, so only keywords can ask for the swap.
  const swapped = VERTICAL.has(tokens[0]) || HORIZONTAL.has(tokens[1]);
  const [first, second] = swapped ? [tokens[1], tokens[0]] : tokens;
  return [parseComponent(first) ?? CENTER, parseComponent(second) ?? CENTER];
}

/**
 * How much bigger or smaller than its natural size the image is drawn.
 * `NaN` means the fit does not preserve the aspect ratio at all — `fill`,
 * the initial value, which simply takes the box.
 *
 * @param {string} fit
 * @param {Size} box
 * @param {Size} natural
 * @returns {number}
 */
function fitScale(fit, box, natural) {
  const horizontal = box.width / natural.width;
  const vertical = box.height / natural.height;
  switch (fit) {
    case "contain":
      return Math.min(horizontal, vertical);
    case "cover":
      return Math.max(horizontal, vertical);
    case "none":
      return 1;
    case "scale-down":
      // "Whichever of `none` and `contain` is smaller" — an image that
      // already fits is left alone, and one that does not is shrunk.
      return Math.min(1, Math.min(horizontal, vertical));
    default:
      return NaN;
  }
}

/**
 * @param {PositionComponent} component
 * @param {number} free How much room the image leaves on that axis. Negative
 *   when the image is the larger of the two, which is how `cover` slides the
 *   crop around: a percentage of a negative number moves the image the other
 *   way, exactly as CSS specifies.
 * @returns {number}
 */
function place(component, free) {
  return (free * component.percent) / 100 + component.length;
}

/**
 * The rectangle an image is drawn in, in the content box's own coordinates.
 *
 * @param {string} fit Computed `object-fit`.
 * @param {string} position Computed `object-position`.
 * @param {Size} box The content box.
 * @param {Size} natural The image's intrinsic size.
 * @returns {ImageRect}
 */
export function fitImage(fit, position, box, natural) {
  let width = box.width;
  let height = box.height;
  if (natural.width > 0 && natural.height > 0) {
    const scale = fitScale(fit, box, natural);
    if (Number.isFinite(scale)) {
      width = natural.width * scale;
      height = natural.height * scale;
    }
  }
  const [x, y] = parseObjectPosition(position);
  return {
    x: place(x, box.width - width),
    y: place(y, box.height - height),
    width,
    height,
  };
}
