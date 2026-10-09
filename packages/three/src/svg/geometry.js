/**
 * The arithmetic of putting an SVG shape where the browser puts it: the
 * viewport transform an `<svg>` applies to its user space, the CSS transform
 * each element applies about its origin, and the composition of the two into
 * one matrix from a shape's user space to the `<svg>` root's border-box
 * frame — the frame the portal's clip box is given in. Each of the parts is
 * committed to an object's matrix in the scene graph; the composition is
 * what the clip patch is told, so the clip can follow the shape there.
 *
 * Everything here is pure and 2D. A matrix is the six numbers SVG and CSS
 * both write it as, `[a, b, c, d, e, f]`: x′ = a·x + c·y + e and y′ = b·x +
 * d·y + f, column-major exactly as `matrix(a, b, c, d, e, f)` lists them.
 */

/**
 * @typedef {readonly [number, number, number, number, number, number]} Matrix2D
 */

/** @type {Matrix2D} */
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/**
 * `m` after `n`: the matrix that applies `n` first and then `m`, which is
 * the order a chain composes in — an element's own transform is applied to
 * its geometry before its parent's is.
 *
 * @param {Matrix2D} m
 * @param {Matrix2D} n
 * @returns {Matrix2D}
 */
export function multiply(m, n) {
  const [a1, b1, c1, d1, e1, f1] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/**
 * @param {number} tx
 * @param {number} ty
 * @returns {Matrix2D}
 */
export function translation(tx, ty) {
  return [1, 0, 0, 1, tx, ty];
}

/**
 * @param {number} sx
 * @param {number} sy
 * @returns {Matrix2D}
 */
export function scaling(sx, sy) {
  return [sx, 0, 0, sy, 0, 0];
}

/**
 * @param {number} radians Clockwise on screen, where y runs down.
 * @returns {Matrix2D}
 */
export function rotation(radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
}

/**
 * The transform `m`, applied about the point (ox, oy) rather than about the
 * origin — which is what a CSS `transform` does about its `transform-origin`.
 *
 * @param {Matrix2D} m
 * @param {number} ox
 * @param {number} oy
 * @returns {Matrix2D}
 */
export function aboutOrigin(m, ox, oy) {
  if (ox === 0 && oy === 0) {
    return m;
  }
  return multiply(translation(ox, oy), multiply(m, translation(-ox, -oy)));
}

/**
 * @param {Matrix2D} m
 * @param {number} x
 * @param {number} y
 * @returns {[number, number]}
 */
export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * The matrix that undoes `m`, or null for one that flattens the plane and
 * cannot be undone.
 *
 * @param {Matrix2D} m
 * @returns {Matrix2D | null}
 */
export function invert(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det) {
    return null;
  }
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * An axis-aligned rectangle, the shape of every clip in a portal.
 *
 * @typedef {object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * The smallest axis-aligned rectangle holding `rect` once `m` has moved it.
 * Exact under a scale and a move; around a rotation, the bounding box.
 *
 * A rect with no area, a line or one inverted as `intersectRects` leaves
 * two that share nothing, stays one with no area: the empty rect where its
 * first corner lands. So does any rect under a matrix that flattens the
 * plane. A clip that holds nothing then holds nothing in every frame it is
 * carried to, where the bounding box of its corners would have area under
 * a turn.
 *
 * @param {Matrix2D} m
 * @param {Rect} rect
 * @returns {Rect}
 */
export function transformRect(m, rect) {
  if (rect.right <= rect.left || rect.bottom <= rect.top || m[0] * m[3] === m[1] * m[2]) {
    const [x, y] = apply(m, rect.left, rect.top);
    return { left: x, top: y, right: x, bottom: y };
  }
  const corners = [
    apply(m, rect.left, rect.top),
    apply(m, rect.right, rect.top),
    apply(m, rect.right, rect.bottom),
    apply(m, rect.left, rect.bottom),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

/**
 * The part of two rectangles both hold, either of which may be null for no
 * limit. One with no area is kept as it is: it clips everything.
 *
 * @param {Rect | null} a
 * @param {Rect | null} b
 * @returns {Rect | null}
 */
export function intersectRects(a, b) {
  if (!a || !b) {
    return a ?? b;
  }
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

/**
 * @param {Rect | null} a
 * @param {Rect | null} b
 * @returns {boolean}
 */
export function rectEqual(a, b) {
  if (!a || !b) {
    return a === b;
  }
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/**
 * How much bigger the matrix draws things, as one number: the geometric
 * mean of its two axis scales, which is what decides how finely a curve is
 * worth sampling before it goes through it.
 *
 * @param {Matrix2D} m
 * @returns {number}
 */
export function matrixScale(m) {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

/**
 * @param {Matrix2D} a
 * @param {Matrix2D} b
 * @returns {boolean}
 */
export function matrixEqual(a, b) {
  return (
    a === b ||
    (a[0] === b[0] &&
      a[1] === b[1] &&
      a[2] === b[2] &&
      a[3] === b[3] &&
      a[4] === b[4] &&
      a[5] === b[5])
  );
}

/**
 * Transform a position buffer in place — three floats per vertex, of which
 * the third is left alone: everything a portal draws is flat.
 *
 * @param {Float32Array | number[]} positions
 * @param {Matrix2D} m
 * @returns {void}
 */
export function transformPositions(positions, m) {
  const [a, b, c, d, e, f] = m;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    positions[i] = a * x + c * y + e;
    positions[i + 1] = b * x + d * y + f;
  }
}

/**
 * A CSS `transform` as computed — `matrix(…)` or `matrix3d(…)` — reduced to
 * the plane. The depth terms of a 3D matrix are dropped rather than
 * projected: a shape is flat, and it is kept on the panel's plane even under a
 * `rotateX` on a `<g>`, whose depth is not the SVG's to give. `none`, or
 * anything unreadable, is null.
 *
 * @param {string} value
 * @returns {Matrix2D | null}
 */
export function parseCssMatrix(value) {
  if (!value || value === "none") {
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
    // Column-major 4×4: x is column 0, y column 1, the translation column 3.
    return [values[0], values[1], values[4], values[5], values[12], values[13]];
  }
  if (values.length !== 6) {
    return null;
  }
  return [values[0], values[1], values[2], values[3], values[4], values[5]];
}

/**
 * @typedef {object} ViewBox
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * The `viewBox` attribute, or null for none — including one with no area,
 * which the specification says disables rendering and which is treated here
 * as no `viewBox` at all, the more useful of the two readings for a panel.
 *
 * @param {string | null | undefined} value
 * @returns {ViewBox | null}
 */
export function parseViewBox(value) {
  if (!value) {
    return null;
  }
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part));
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    return null;
  }
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * @typedef {object} PreserveAspectRatio
 * @property {"none" | "xMinYMin" | "xMidYMin" | "xMaxYMin" | "xMinYMid" | "xMidYMid" | "xMaxYMid" | "xMinYMax" | "xMidYMax" | "xMaxYMax"} align
 * @property {boolean} meet `meet` scales the `viewBox` to fit inside the
 *   viewport, `slice` to cover it.
 */

/** @type {PreserveAspectRatio} */
const DEFAULT_ASPECT = Object.freeze({ align: "xMidYMid", meet: true });

/**
 * @param {string | null | undefined} value
 * @returns {PreserveAspectRatio}
 */
export function parsePreserveAspectRatio(value) {
  if (!value) {
    return DEFAULT_ASPECT;
  }
  const parts = value.trim().split(/\s+/);
  const align = /** @type {PreserveAspectRatio["align"]} */ (
    /^(none|x(Min|Mid|Max)Y(Min|Mid|Max))$/.test(parts[0]) ? parts[0] : "xMidYMid"
  );
  return { align, meet: parts[1] !== "slice" };
}

/**
 * Where along an axis the scaled `viewBox` is placed for one third of an
 * alignment keyword: at the start, centred, or at the end of the slack.
 *
 * @param {string} keyword `Min`, `Mid` or `Max`.
 * @param {number} slack How much wider the viewport is than the scaled box.
 * @returns {number}
 */
function alignOffset(keyword, slack) {
  switch (keyword) {
    case "Min":
      return 0;
    case "Max":
      return slack;
    default:
      return slack / 2;
  }
}

/**
 * The matrix from an `<svg>`'s user space to its viewport, in viewport px
 * with the origin at the viewport's top-left corner — the `viewBox` scaled
 * by `preserveAspectRatio` into a viewport of the given size. Without a
 * `viewBox` user units are px and this is the identity.
 *
 * @param {ViewBox | null} viewBox
 * @param {PreserveAspectRatio} aspect
 * @param {number} width The viewport's width, in px.
 * @param {number} height
 * @returns {Matrix2D}
 */
export function viewportMatrix(viewBox, aspect, width, height) {
  if (!viewBox || width <= 0 || height <= 0) {
    return IDENTITY;
  }
  let sx = width / viewBox.width;
  let sy = height / viewBox.height;
  let tx = 0;
  let ty = 0;
  if (aspect.align !== "none") {
    const scale = aspect.meet ? Math.min(sx, sy) : Math.max(sx, sy);
    sx = scale;
    sy = scale;
    const match = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(aspect.align);
    if (match) {
      tx = alignOffset(match[1], width - viewBox.width * scale);
      ty = alignOffset(match[2], height - viewBox.height * scale);
    }
  }
  return [sx, 0, 0, sy, tx - viewBox.x * sx, ty - viewBox.y * sy];
}

/**
 * The matrix as three's 4×4, in the plane: z passes through untouched, so
 * an object carrying it keeps the depth its parent gave it.
 *
 * @param {Matrix2D} m
 * @param {import('three').Matrix4} target
 * @returns {import('three').Matrix4}
 */
export function toMatrix4(m, target) {
  const [a, b, c, d, e, f] = m;
  return target.set(a, c, 0, e, b, d, 0, f, 0, 0, 1, 0, 0, 0, 0, 1);
}

/**
 * The matrix as three's 3×3 in homogeneous 2D coordinates — the shape of the
 * clip patch's `clipMatrix` uniform.
 *
 * @param {Matrix2D} m
 * @param {import('three').Matrix3} target
 * @returns {import('three').Matrix3}
 */
export function toMatrix3(m, target) {
  const [a, b, c, d, e, f] = m;
  return target.set(a, c, e, b, d, f, 0, 0, 1);
}

/**
 * A scale, rounded up to the next rung of a ladder a half-octave apart —
 * one, √2, two, 2√2, … — for deciding how finely to sample curves. Sampled
 * geometry lives in user space and is drawn through a matrix, so a scale
 * that changes every frame (a zoom animated on a `<g>`) must not re-sample
 * every frame; it re-samples when it crosses a rung, and never draws a
 * curve coarser than the exact scale would have.
 *
 * @param {number} scale
 * @returns {number}
 */
export function samplingScale(scale) {
  if (!(scale > 0) || !Number.isFinite(scale)) {
    return 1;
  }
  return 2 ** (Math.ceil(Math.log2(scale) * 2 - 1e-9) / 2);
}
