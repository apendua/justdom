import * as THREE from "three";
import {
  Derived,
  effects,
  flatMap,
  just,
  observable,
  onCleanup,
  set,
  useEffects,
} from "@apendua/signal";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { $, children, Nothing } from "../operators.js";
import { applyClip, clipRaycast, intersectClipBoxes, UNCLIPPED } from "../elements/clip.js";
import { PortalReadyContext } from "../elements/div.js";
import { forwardPointerEvents, isClickable } from "../elements/pointerForwarding.js";
import { place } from "../elements/place.js";
import { getContentRenderOrder } from "../elements/elevation.js";
import { BOX_BUCKET_BIAS } from "../elements/boxBatch.js";
import {
  getAttributeCached,
  getBorderBoxSize,
  getChildNodes,
  getComputedStyleCached,
  getInteriorClipBox,
  getOpacity,
  getParentElement,
  hidesVisibility,
  isVisibilityHidden,
} from "../elements/mirror.js";
import {
  findSvgElement,
  isSvgElement,
  isSvgRoot,
  readBBox,
  SVG_NAMESPACE,
} from "../elements/plugins.js";
import {
  aboutOrigin,
  apply,
  IDENTITY,
  intersectRects,
  invert,
  matrixEqual,
  matrixScale,
  multiply,
  parseCssMatrix,
  parsePreserveAspectRatio,
  parseViewBox,
  rectEqual,
  samplingScale,
  toMatrix3,
  toMatrix4,
  transformRect,
  translation,
  viewportMatrix,
} from "./geometry.js";
import { dashRuns } from "./dash.js";
import {
  clipsViewport,
  paintEqual,
  isPainted,
  parseDashArray,
  parseFillRule,
  parseLengthIn,
  parseLineCap,
  parseLineJoin,
  parseNumber,
  parsePaint,
  parsePointerEvents,
  parseUrlReference,
  readProperty,
  readShapeGeometry,
  readSize,
  shapeGeometryEqual,
  viewportReferences,
} from "./style.js";

/**
 * @import {EntityEffect, Source} from '@apendua/signal';
 * @import {ShapePath} from 'three';
 * @import {Component, XREventMap} from '../core.js';
 * @import {ClipBox} from '../elements/clip.js';
 * @import {Matrix2D, Rect} from './geometry.js';
 * @import {HitRule, Paint, ShapeGeometry} from './style.js';
 */

/**
 * A shape element — `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`,
 * `<polyline>`, `<polygon>` — projected into the scene: an object carrying
 * a fill mesh, a stroke mesh, or both, each triangulated from the element's
 * geometry and dressed from its computed style.
 *
 * The vertices stay in the shape's own user space, and where they land is
 * the scene graph's business, as it is for a box under a CSS transform: the
 * `<svg>` root's content group carries the viewport matrix, each `<g>` and
 * nested `<svg>` carries its own transform, and the shape's object carries
 * the shape's. Three composes them, so a transform animated on a `<g>` is a
 * matrix write per frame and its descendants' buffers never change.
 *
 * The clip box is still given in the root's frame, which is no longer the
 * frame the vertices are in; the shape tells the clip patch the matrix
 * between the two — the composition of everything above — so the edge stays
 * where the root's overflow puts it.
 *
 * A shape under `cursor: pointer` is a ray target of its own and forwards
 * what happens there to its element as a box does. Its `pointer-events`
 * decides which of its fill and stroke a ray can hit.
 */

/**
 * Round joins and caps are drawn as arcs of this many divisions.
 */
const ARC_DIVISIONS = 12;

/**
 * The most curve segments a single curve is sampled at, however large the
 * shape is drawn — past this the polygon is finer than the antialiasing.
 */
const MAX_SEGMENTS = 128;

/**
 * How a zero-length dash is drawn under a cap that has some length of its
 * own: as a run this fraction of the stroke's width, so that the caps of
 * `stroke-dasharray: 0 8` with `stroke-linecap: round` meet in a circle.
 */
const DOT_LENGTH = 0.05;

/**
 * Parsed paths, by their `d`. A shape's `d` string is the same across a
 * hover, a colour animation and a resize, and parsing it again for each
 * would be the one expensive step on the path that is meant to be cheap.
 * Bounded, and simply emptied when full: the strings a panel uses are few,
 * and re-parsing them once is the whole cost of a miss.
 *
 * @type {Map<string, ShapePath | null>}
 */
const parsed = new Map();

const PARSED_LIMIT = 512;

/** One loader for every path; `parse` keeps no state between calls. */
let loader = /** @type {SVGLoader | null} */ (null);

/**
 * @param {string} value
 * @returns {string}
 */
function escapeAttribute(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A `<path>`'s outline, parsed by three's `SVGLoader` from a one-element
 * document: its `d` parser and its arc handling, without re-implementing
 * either. The loader's parser is local to `parse`, so a document is the
 * only way in.
 *
 * @param {string} d
 * @returns {ShapePath | null}
 */
function parsePath(d) {
  const cached = parsed.get(d);
  if (cached !== undefined) {
    return cached;
  }
  if (parsed.size >= PARSED_LIMIT) {
    parsed.clear();
  }
  loader ??= new SVGLoader();
  const markup = `<path d="${escapeAttribute(d)}"/>`;
  const result = loader.parse(`<svg xmlns="${SVG_NAMESPACE}">${markup}</svg>`);
  const path = result.paths[0] ?? null;
  parsed.set(d, path);
  return path;
}

/**
 * `SVGLoader`'s rounded corner: one minus the bezier approximation of a
 * quarter ellipse, as its `parseRectNode` uses it.
 */
const CORNER = 1 - 0.551915024494;

/**
 * The shape's outline as three's `ShapePath`, the same one `SVGLoader`
 * would build from the element: the same curves, in the same order, with
 * the same closing. Every kind but a `<path>` is built here, from the
 * numbers already read, rather than written out as markup for the loader
 * to parse back; a shape that moves every frame is a few curves a frame and
 * not a document. The one difference is a `points` list written with a
 * comma and a space between the numbers of a pair, which the loader reads
 * with its pairs shifted and `parsePoints` reads as a browser does.
 *
 * A `<path>` goes to the loader, by its `d`. One whose `d` changes every
 * frame still parses a document every frame, and each new `d` takes a
 * place in the cache. A path built here is the shape's own, and one parsed
 * is shared by every shape with the same `d`.
 *
 * @param {ShapeGeometry} geometry
 * @returns {ShapePath | null}
 */
export function buildShapePath(geometry) {
  switch (geometry.kind) {
    case "path":
      return parsePath(geometry.d);
    case "circle":
    case "ellipse": {
      const subPath = new THREE.Path();
      if (geometry.kind === "circle") {
        subPath.absarc(geometry.cx, geometry.cy, geometry.r, 0, Math.PI * 2);
      } else {
        subPath.absellipse(geometry.cx, geometry.cy, geometry.rx, geometry.ry, 0, Math.PI * 2);
      }
      const path = new THREE.ShapePath();
      path.subPaths.push(subPath);
      return path;
    }
    case "line": {
      const path = new THREE.ShapePath();
      path.moveTo(geometry.x1, geometry.y1);
      path.lineTo(geometry.x2, geometry.y2);
      return path;
    }
    case "polyline":
    case "polygon": {
      const { points } = geometry;
      const path = new THREE.ShapePath();
      path.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) {
        path.lineTo(points[i], points[i + 1]);
      }
      if (geometry.kind === "polygon") {
        /** @type {THREE.Path} */ (path.currentPath).autoClose = true;
      }
      return path;
    }
    case "rect": {
      const { x, y, width: w, height: h, rx, ry } = geometry;
      const rounded = rx !== 0 || ry !== 0;
      const path = new THREE.ShapePath();
      path.moveTo(x + rx, y);
      path.lineTo(x + w - rx, y);
      if (rounded) {
        path.bezierCurveTo(x + w - rx * CORNER, y, x + w, y + ry * CORNER, x + w, y + ry);
      }
      path.lineTo(x + w, y + h - ry);
      if (rounded) {
        path.bezierCurveTo(
          x + w,
          y + h - ry * CORNER,
          x + w - rx * CORNER,
          y + h,
          x + w - rx,
          y + h,
        );
      }
      path.lineTo(x + rx, y + h);
      if (rounded) {
        path.bezierCurveTo(x + rx * CORNER, y + h, x, y + h - ry * CORNER, x, y + h - ry);
      }
      path.lineTo(x, y + ry);
      if (rounded) {
        path.bezierCurveTo(x, y + ry * CORNER, x + rx * CORNER, y, x + rx, y);
      }
      return path;
    }
  }
}

/**
 * @param {string} value
 * @returns {number}
 */
function px(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * An element of the SVG namespace read as the HTML-typed element the
 * mirror's caches take. They ask nothing of it an SVG element lacks —
 * computed style, client rects, `parentElement`, `dataset` — and their
 * parameter type says HTML because HTML was all there was.
 *
 * @param {Element} element
 * @returns {HTMLElement}
 */
function asHtml(element) {
  return /** @type {HTMLElement} */ (element);
}

/**
 * The element's own CSS `transform`, about its `transform-origin`, in its
 * user space — or null for none.
 *
 * The origin is the computed one, which the browser resolves to px in the
 * reference box `transform-box` names. For the default `view-box` those px
 * are measured from the nearest viewport's `viewBox` origin, so the
 * `viewBox`'s own offset is added back; for `fill-box` they are measured
 * from the shape's own bounds, which `getBBox` reports where it exists.
 *
 * @param {Element} element
 * @param {CSSStyleDeclaration} style
 * @param {{ x: number, y: number }} viewBoxOrigin
 * @returns {Matrix2D | null}
 */
function ownTransform(element, style, viewBoxOrigin) {
  const matrix = parseCssMatrix(style.transform);
  if (!matrix) {
    return null;
  }
  const origin = style.transformOrigin.split(/\s+/);
  let ox = px(origin[0] ?? "0");
  let oy = px(origin[1] ?? "0");
  if (style.getPropertyValue("transform-box") === "fill-box") {
    const bbox = readBBox(element);
    if (bbox) {
      ox += bbox.x;
      oy += bbox.y;
    }
  } else {
    ox += viewBoxOrigin.x;
    oy += viewBoxOrigin.y;
  }
  return aboutOrigin(matrix, ox, oy);
}

/**
 * A box as `getBBox` gives one: a corner and a size.
 *
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 */

/**
 * @param {Box} box
 * @returns {Rect}
 */
function rectOf(box) {
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
}

/**
 * The elements a `<clipPath>` may hold beside its shapes that are never
 * drawn, so they neither clip nor stop the rect from clipping.
 */
const DESCRIPTIVE_TAGS = new Set(["title", "desc", "metadata"]);

/**
 * What a `clip-path` leaves of an element, as a rectangle in the space the
 * element's own geometry is in, or null for no clip.
 *
 * Followed: `url(#id)` naming a `<clipPath>` whose one element child is a
 * `<rect>`, a `<title>`, `<desc>` or `<metadata>` beside it aside, moved by
 * the transforms on the two and by `clipPathUnits`. Under `userSpaceOnUse`
 * a percentage is of the viewport around the `<clipPath>`, whatever names
 * it, as a browser resolves the rect's lengths. One defined inside a
 * `<symbol>` or a `<marker>` resolves against the viewport above the
 * template, since the walk is not told an instance to stop at. Chrome
 * resolves one in a `<marker>` the same way, and does not take one in a
 * `<symbol>` as a clip at all. Under `objectBoundingBox` the units are
 * `box`, the element's box in the space the rect is in, and an element
 * with none is not clipped. For a template drawn somewhere else, a
 * `<symbol>`, a `<marker>` or an `<svg>` a `<use>` draws, the box is the
 * copy's, the one it is given where it is drawn, and not the template's
 * where it is defined, which a browser never lays out. A rect
 * with no area clips everything away, as a browser's empty clip does, and
 * so does an `objectBoundingBox` clip on an element whose box has no width
 * or height, which flattens the rect. The rect's `rx` and `ry` are not
 * followed, so the corners are square. A turn or a skew, here or anywhere
 * above, clips to the bounding box of the turned rect, as a viewport under
 * a rotation does.
 *
 * Not followed, and so not clipped: any other `<clipPath>`, a basic shape
 * such as `inset()`, and a `clip-path` on the `<clipPath>` or its rect. A
 * `<clipPath>` outside the panel is read as it was first read, as a
 * `<marker>` is (see `readRecordOf` in `mirror.js`). The lookup by id is
 * not a cached read, so a `<clipPath>` added after the element was drawn is
 * found the next time the element's chain is read, such as when the element
 * is restyled.
 *
 * Exported for the templates in `template.js`, whose own `clip-path` the
 * walk in `readChain` stops short of.
 *
 * @param {Element} element
 * @param {CSSStyleDeclaration} style The element's computed style.
 * @param {() => Box | null} box The element's box, for `objectBoundingBox`,
 *   in the space the rect is in. Called only under it, since reading a
 *   `getBBox` forces a layout.
 * @returns {Rect | null}
 */
export function readClipRect(element, style, box) {
  const clipPath = findSvgElement(
    element,
    parseUrlReference(readProperty(style, element, "clip-path")),
    "clipPath",
  );
  if (!clipPath) {
    return null;
  }
  /** @type {Element | null} */
  let rect = null;
  for (const node of getChildNodes(clipPath)) {
    if (
      node.nodeType !== Node.ELEMENT_NODE ||
      DESCRIPTIVE_TAGS.has(/** @type {Element} */ (node).localName)
    ) {
      continue;
    }
    if (rect || !isSvgElement(node) || /** @type {Element} */ (node).localName !== "rect") {
      return null;
    }
    rect = /** @type {Element} */ (node);
  }
  if (!rect) {
    return null;
  }
  /** @type {Matrix2D} */
  let units = IDENTITY;
  /** @type {Record<"width" | "height", number | (() => number | undefined)>} */
  let of = viewportReferences(() => viewportSize(/** @type {Element} */ (rect)));
  if (getAttributeCached(clipPath, "clipPathUnits") === "objectBoundingBox") {
    const bbox = box();
    if (!bbox) {
      return null;
    }
    units = [bbox.width, 0, 0, bbox.height, bbox.x, bbox.y];
    of = { width: 1, height: 1 };
  }
  const matrix = multiply(units, withOwnTransform(clipPath, localMatrix(rect), null));
  const rectStyle = getComputedStyleCached(rect);
  /**
   * @param {string} name
   * @param {"width" | "height"} axis
   */
  const length = (name, axis) => parseLengthIn(readProperty(rectStyle, rect, name), of[axis], 0);
  const x = length("x", "width");
  const y = length("y", "height");
  // One with no area, or flattened by `units`, stays empty (`transformRect`).
  return transformRect(matrix, {
    left: x,
    top: y,
    right: x + length("width", "width"),
    bottom: y + length("height", "height"),
  });
}

/**
 * Everything the element inherits from where it stands: the matrix from its
 * user space to its `<svg>` root's border-box frame — the product of the
 * matrices the objects between the two carry — the opacity of the groups
 * above it folded into one number, and the root itself: null for a shape
 * that is not inside an `<svg>` at all, which the DOM allows and a browser
 * draws nothing for.
 *
 * @typedef {object} Chain
 * @property {Matrix2D} ctm
 * @property {number} opacity The product of the opacities below the root,
 *   the shape's own included and the root's not.
 * @property {Element | null} root
 * @property {Rect | null} clip What the viewports above the element leave of
 *   it, a nested `<svg>`, a `<symbol>` or a `<marker>`, and what the
 *   `clip-path` of the element or of anything above it leaves, in the root's
 *   frame. Null for none. The root's own overflow is not in it: that is a
 *   box's, and the portal's clip chain has it.
 */

/**
 * @param {Chain} a
 * @param {Chain} b
 * @returns {boolean}
 */
export function chainEqual(a, b) {
  return (
    a.root === b.root &&
    a.opacity === b.opacity &&
    matrixEqual(a.ctm, b.ctm) &&
    rectEqual(a.clip, b.clip)
  );
}

/**
 * The `viewBox` origin of the nearest viewport above an element — the
 * offset a `view-box` transform origin is measured from. In template
 * content the walk stops at the template and takes the instance's, as
 * `viewportSize` does.
 *
 * @param {Element} element
 * @param {Instance | null} [instance] The instance the element is part of.
 * @returns {{ x: number, y: number }}
 */
export function nearestViewBoxOrigin(element, instance = null) {
  for (let current = element.parentElement; current; current = current.parentElement) {
    if (instance && current === instance.template) {
      return instance.viewBoxOrigin();
    }
    if (current.localName === "svg" && current.namespaceURI === SVG_NAMESPACE) {
      const viewBox = parseViewBox(getAttributeCached(current, "viewBox"));
      return viewBox ? { x: viewBox.x, y: viewBox.y } : { x: 0, y: 0 };
    }
  }
  return { x: 0, y: 0 };
}

/**
 * The matrix an `<svg>` root's content group carries: from the root's user
 * space to its border-box frame — the `viewBox` fitted into the content
 * box, offset from the border-box corner by the border and padding around
 * it. Every computed style and size read is a dependency, so a root that
 * resizes, or a new `viewBox`, re-runs this and nothing under it.
 *
 * @param {Element} root
 * @returns {Matrix2D}
 */
export function rootMatrix(root) {
  const box = rootContentBox(root);
  const viewport = viewportMatrix(
    parseViewBox(getAttributeCached(root, "viewBox")),
    parsePreserveAspectRatio(getAttributeCached(root, "preserveAspectRatio")),
    box.width,
    box.height,
  );
  return multiply(translation(box.left, box.top), viewport);
}

/**
 * An `<svg>` root's content box, the viewport its `viewBox` is fitted into:
 * where it starts in the border-box frame, past the border and padding, and
 * its size in px.
 *
 * @param {Element} root
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
function rootContentBox(root) {
  const style = getComputedStyleCached(root);
  const size = getBorderBoxSize(asHtml(root));
  const left = px(style.borderLeftWidth) + px(style.paddingLeft);
  const top = px(style.borderTopWidth) + px(style.paddingTop);
  return {
    left,
    top,
    width: size.width - left - px(style.borderRightWidth) - px(style.paddingRight),
    height: size.height - top - px(style.borderBottomWidth) - px(style.paddingBottom),
  };
}

/**
 * The size of the viewport an element is in, in its user units: what a
 * percentage length on it is a percentage of. That is the nearest `<svg>`'s
 * `viewBox`, or without one its own size, which for the root is its
 * content box in px. Null for an element that is in no `<svg>`.
 *
 * In template content the walk stops at the template, whose content is in
 * the viewport the instance gives it: a `<symbol>`'s, a `<marker>`'s, or
 * the one around the `<use>` that draws a `<g>`.
 *
 * @param {Element} element
 * @param {Instance | null} [instance] The instance the element is part of.
 * @returns {{ width: number, height: number } | null}
 */
export function viewportSize(element, instance = null) {
  for (let current = getParentElement(element); current; current = getParentElement(current)) {
    if (instance && current === instance.template) {
      return instance.viewport();
    }
    if (current.localName !== "svg" || current.namespaceURI !== SVG_NAMESPACE) {
      continue;
    }
    const viewBox = parseViewBox(getAttributeCached(current, "viewBox"));
    if (viewBox) {
      return { width: viewBox.width, height: viewBox.height };
    }
    if (isSvgRoot(current)) {
      const box = rootContentBox(current);
      return { width: box.width, height: box.height };
    }
    const box = svgViewport(current, instance);
    return Number.isFinite(box.width) && Number.isFinite(box.height)
      ? { width: box.width, height: box.height }
      : null;
  }
  return null;
}

/**
 * Where a nested `<svg>` puts its viewport, in its parent's user space: its
 * `x`, `y`, `width` and `height`. A size left `auto` is the whole of the
 * viewport around it, as a percentage is a share of it. A size that cannot
 * be known, with no viewport around to measure, is NaN.
 *
 * @param {Element} svg
 * @param {Instance | null} [instance] The instance the `<svg>` is part of.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function svgViewport(svg, instance = null) {
  const style = getComputedStyleCached(svg);
  const outer = viewportSize(svg, instance);
  /**
   * @param {"width" | "height"} name
   * @param {"width" | "height"} axis
   */
  const size = (name, axis) => {
    const value = parseLengthIn(readSize(style, svg, name), outer?.[axis], Number.NaN);
    return Number.isNaN(value) ? (outer?.[axis] ?? Number.NaN) : value;
  };
  return {
    x: parseLengthIn(readProperty(style, svg, "x"), outer?.width, 0),
    y: parseLengthIn(readProperty(style, svg, "y"), outer?.height, 0),
    width: size("width", "width"),
    height: size("height", "height"),
  };
}

/**
 * The matrix a nested `<svg>`'s viewport puts its content under: its own
 * `viewBox` fitted into its `width` and `height`, placed at its `x`, `y`.
 * Its `transform`, if it has one, applies on top of this.
 *
 * @param {Element} svg
 * @param {{ x: number, y: number, width: number, height: number }} box Its
 *   `svgViewport`, read once by the caller.
 * @returns {Matrix2D}
 */
function svgViewportMatrix(svg, box) {
  const viewport = viewportMatrix(
    parseViewBox(getAttributeCached(svg, "viewBox")),
    parsePreserveAspectRatio(getAttributeCached(svg, "preserveAspectRatio")),
    // A size nobody can know fits no `viewBox`: user units are the
    // parent's, as for a size of 0.
    Number.isFinite(box.width) ? box.width : 0,
    Number.isFinite(box.height) ? box.height : 0,
  );
  return multiply(translation(box.x, box.y), viewport);
}

/**
 * The matrix an element below the root carries on its own object: from its
 * user space to its parent's. That is its computed `transform` about its
 * `transform-origin`, and for a nested `<svg>` the viewport it establishes
 * first — placed at its `x`, `y`, its own `viewBox` fitted into the `width`
 * and `height` it names (`svgViewport`). What the viewport clips is the
 * chain's business, in `readChain`.
 *
 * @param {Element} element
 * @param {Instance | null} [instance] The instance the element is part of.
 * @returns {Matrix2D}
 */
export function localMatrix(element, instance = null) {
  return withOwnTransform(
    element,
    element.localName === "svg"
      ? svgViewportMatrix(element, svgViewport(element, instance))
      : IDENTITY,
    instance,
  );
}

/**
 * An element's own `transform`, about its origin, on top of `matrix`.
 *
 * @param {Element} element
 * @param {Matrix2D} matrix What applies first: a nested `<svg>`'s viewport.
 * @param {Instance | null} instance
 * @returns {Matrix2D}
 */
function withOwnTransform(element, matrix, instance) {
  const style = getComputedStyleCached(element);
  const own = ownTransform(element, style, nearestViewBoxOrigin(element, instance));
  return own ? multiply(own, matrix) : matrix;
}

/**
 * Commit a 2D matrix as an object's local matrix, the way `place` commits a
 * position: the object stops recomposing its own, and its world matrix is
 * marked stale so the next walk carries the change to what is below it.
 *
 * @param {THREE.Object3D} object
 * @param {Matrix2D} matrix
 * @returns {void}
 */
export function commitMatrix(object, matrix) {
  object.matrixAutoUpdate = false;
  toMatrix4(matrix, object.matrix);
  object.matrixWorldNeedsUpdate = true;
}

/**
 * A copy of a template's content drawn somewhere else: one instance of a
 * `<marker>` at a vertex of a path. What is inside the template is drawn by
 * the same `shape`, `group` and `image` as anything else, told by this where
 * it stands. Its chain stops at the template and continues from the place
 * the instance is drawn, and its draw order is a share of the slot the
 * instance was given.
 *
 * @typedef {object} Instance
 * @property {Element} template The element the walk up from the content
 *   stops at: the `<marker>` or `<symbol>` whose children are drawn, or the
 *   parent of an element a `<use>` draws.
 * @property {() => Chain} chain The matrix from the template's user space to
 *   the root's frame at this instance, the opacity above it, and the root.
 * @property {() => PaintSlot} slot The range of render orders the instance
 *   draws its content in.
 * @property {() => { width: number, height: number } | null} viewport The
 *   size of the viewport the template's content is in, in the template's
 *   user units: what a percentage length there is a percentage of.
 * @property {() => { x: number, y: number }} viewBoxOrigin Where that
 *   viewport's `viewBox` starts, which a `view-box` transform origin is
 *   measured from.
 * @property {Inheritance | null} inherit Where the content inherits from, for
 *   a copy that inherits from where it is drawn: a `<use>`'s, and not a
 *   marker's.
 * @property {ReadonlySet<Element>} expanding The templates whose content
 *   this instance is inside, its own included. A template named again from
 *   inside itself, a marker by its own content or a `<use>` by a symbol it
 *   draws, is a cycle, which a browser draws nothing more for, and so is not
 *   expanded again.
 */

/**
 * A clip in a frame of the template's outer user space: the matrix from
 * the frame to that space, and the rect in the frame.
 *
 * @typedef {object} FramedClip
 * @property {Matrix2D} [frame] Absent for a rect already in that space.
 * @property {Rect} rect
 */

/**
 * @typedef {object} InstanceSpec
 * @property {Element} template See `Instance.template`.
 * @property {() => Chain} outer The chain of the element that draws the
 *   copy, a marked shape or a `<use>`, in whose user space it is placed.
 * @property {() => Matrix2D} placement From the template's user space to
 *   that one.
 * @property {Element | null} container The element in the copy that is a
 *   container its content is drawn in, a `<marker>`, a `<symbol>` or an
 *   `<svg>`, whose own opacity fades the copy, since the walk up from the
 *   content stops below it. Null when the copy has none: the parent of an
 *   element a `<use>` draws whole is not in the copy.
 * @property {() => FramedClip | null} clip What the copy is clipped to, or
 *   null for no clip of its own.
 * @property {Instance["slot"]} slot
 * @property {Instance["viewport"]} viewport
 * @property {Instance["viewBoxOrigin"]} viewBoxOrigin
 * @property {Inheritance | null} inherit
 * @property {ReadonlySet<Element>} expanding
 */

/**
 * An instance of a template, its chain composed from the chain of what
 * draws it, in one place for a marker and a `<use>` alike: the placement
 * after the outer matrix, the container's opacity times the outer opacity,
 * and its clip, moved into the root's frame, cut out of the outer clip.
 *
 * @param {InstanceSpec} spec
 * @returns {Instance}
 */
export function createInstance({ template, outer, placement, container, clip, ...rest }) {
  return {
    template,
    chain: () => {
      const at = outer();
      const own = clip();
      return {
        ctm: multiply(at.ctm, placement()),
        opacity: container
          ? at.opacity * parseNumber(getComputedStyleCached(container).opacity, 1)
          : at.opacity,
        root: at.root,
        clip: own
          ? clipThrough(at.clip, own.frame ? multiply(at.ctm, own.frame) : at.ctm, own.rect)
          : at.clip,
      };
    },
    ...rest,
  };
}

/**
 * A clip rect given in some frame, taken to the root's frame by `toRoot`
 * and cut out of the clip already there. Where a rotation or a skew turns
 * the rect, it clips to the box around it.
 *
 * @param {Rect | null} clip
 * @param {Matrix2D} toRoot
 * @param {Rect} rect
 * @returns {Rect | null}
 */
function clipThrough(clip, toRoot, rect) {
  return intersectRects(clip, transformRect(toRoot, rect));
}

/**
 * @typedef {object} Inheritance
 * @property {Element} boundary The element just above the copied content.
 *   A property no element between the content and this one changes is
 *   inherited from outside the copy.
 * @property {(name: string) => string} read The value there, at the `<use>`.
 */

/**
 * The inherited properties a shape reads. Anything else a copy reads from
 * its own element as it stands in the template.
 */
const INHERITED = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "marker-start",
  "marker-mid",
  "marker-end",
  "color",
  "visibility",
  // What a `<text>` is laid out and drawn with.
  "font-family",
  "font-size",
  "font-style",
  "font-variant-caps",
  "font-weight",
  "letter-spacing",
  "word-spacing",
  "text-anchor",
]);

/**
 * The CSS-wide keywords that, on the inherited properties read here, take
 * the parent's value. They name the property but set nothing, so in a copy
 * the value still comes from the `<use>`.
 */
const INHERITING_KEYWORDS = new Set(["inherit", "unset", "revert", "revert-layer"]);

/** The properties whose value may be `currentColor`, the element's `color`. */
const COLOR_VALUED = new Set(["fill", "stroke"]);

/**
 * What an element says about a property itself, through its presentation
 * attribute or its `style` attribute, or null for nothing. A stylesheet rule
 * is not seen here; the computed value comparison below catches those.
 *
 * @param {Element} element
 * @param {string} name
 * @returns {string | null}
 */
function declaredValue(element, name) {
  const inline = /** @type {ElementCSSInlineStyle} */ (/** @type {unknown} */ (element)).style;
  const value = inline?.getPropertyValue(name) || element.getAttribute(name);
  return value ? value.trim() : null;
}

/**
 * A property of an element as it is drawn: its own computed value, or, in a
 * copy made by a `<use>`, the `<use>`'s where the copy inherits it.
 *
 * A browser draws a `<use>` from a clone of the referenced content placed
 * under the `<use>`, so the clone inherits the `<use>`'s styles. The mirror
 * sees only the original, which inherits from wherever it is defined. What
 * it can see is whether anything in the copied content sets the property:
 * where each element's value is the same as its parent's all the way up to
 * the boundary, the value was inherited from outside, and the `<use>`'s is
 * taken instead. An element whose attribute or `style` names the property
 * sets it, whatever the value, unless the value is `inherit` or another of
 * the `INHERITING_KEYWORDS`, which pass the walk on to its parent. One that
 * sets it through a stylesheet rule to exactly the value it would have
 * inherited reads as not setting it, which is the one case this gets wrong.
 *
 * A `fill` or `stroke` of `currentColor` is resolved against the copy's
 * `color`, which is inherited from the `<use>` in turn. The computed value
 * the mirror sees was resolved where the symbol is defined, against a
 * `color` the drawing never has.
 *
 * @param {Element} element
 * @param {string} name
 * @param {Instance | null} instance
 * @returns {string}
 */
export function readDrawnProperty(element, name, instance) {
  const value = readProperty(getComputedStyleCached(element), element, name);
  const inherit = instance?.inherit;
  if (!inherit || !INHERITED.has(name)) {
    return value;
  }
  let current = element;
  let currentValue = value;
  while (current !== inherit.boundary) {
    const declared = declaredValue(current, name)?.toLowerCase() ?? null;
    const inherits = declared !== null && INHERITING_KEYWORDS.has(declared);
    if (declared !== null && !inherits) {
      return COLOR_VALUED.has(name) && declared === "currentcolor"
        ? readDrawnProperty(current, "color", instance)
        : value;
    }
    const parent = getParentElement(current);
    if (!parent) {
      return value;
    }
    const parentValue = readProperty(getComputedStyleCached(parent), parent, name);
    // A keyword takes the parent's value, whatever was computed for it
    // where the content is defined.
    if (!inherits && parentValue !== currentValue) {
      return value;
    }
    current = parent;
    currentValue = parentValue;
  }
  return inherit.read(name);
}

/**
 * Whether `visibility` hides what an element draws, as the element is drawn.
 * In a copy made by a `<use>` that follows `readDrawnProperty`, so a hidden
 * `<use>`, or one under a hidden `<g>`, hides its copy as a browser does.
 *
 * @param {Element} element
 * @param {Instance | null} instance
 * @returns {boolean}
 */
export function isDrawnHidden(element, instance) {
  return instance?.inherit
    ? hidesVisibility(readDrawnProperty(element, "visibility", instance))
    : isVisibilityHidden(element);
}

/**
 * Walk from the element to its root, composing the same matrices the
 * objects on the way carry. Every computed style read on the way is a
 * dependency, so a transform written to a `<g>` three levels up, or the
 * root resizing under a new `viewBox`, re-runs the shapes below it and
 * nothing else — and what a re-run costs is a uniform write and, at most, a
 * new sampling density.
 *
 * Inside an instance the walk stops at the template, which is not drawn
 * where it stands, and goes on from the instance's own chain.
 *
 * @param {Element} element
 * @param {Instance | null} [instance]
 * @returns {Chain}
 */
export function readChain(element, instance = null) {
  /** @type {Matrix2D} */
  let ctm = IDENTITY;
  let opacity = 1;
  /**
   * Each clip passed on the way, a viewport or a `clip-path`, in the space
   * it is given in, with the matrix from the element's user space to there.
   * Where that space lands in the root's frame is known only at the top.
   *
   * @type {{ rect: Rect, below: Matrix2D }[]}
   */
  const viewports = [];
  /**
   * @param {Chain} top
   * @returns {Chain}
   */
  const finish = (top) => {
    let clip = top.clip;
    for (const { rect, below } of viewports) {
      const back = invert(below);
      if (back) {
        clip = clipThrough(clip, multiply(top.ctm, back), rect);
      }
    }
    return { ...top, clip };
  };
  /** @type {Element | null} */
  let current = element;
  while (current) {
    if (instance && current === instance.template) {
      const at = instance.chain();
      return finish({
        ctm: multiply(at.ctm, ctm),
        opacity: opacity * at.opacity,
        root: at.root,
        clip: at.clip,
      });
    }
    if (isSvgRoot(current)) {
      // The opacity from the root up is not the chain's: see
      // `drawnOpacity`, which multiplies it in.
      return finish({
        ctm: multiply(rootMatrix(current), ctm),
        opacity,
        root: current,
        clip: null,
      });
    }
    const style = getComputedStyleCached(current);
    opacity *= parseNumber(style.opacity, 1);
    /** @type {Matrix2D} */
    let fit = IDENTITY;
    if (current.localName === "svg") {
      // Read once, for the matrix and the clip both.
      const box = svgViewport(current, instance);
      fit = svgViewportMatrix(current, box);
      // The viewport is in the space the `<svg>`'s own `transform` then
      // moves, so its clip moves with the content. A size nobody can know
      // clips nothing.
      if (
        current !== element &&
        clipsViewport(style.overflow) &&
        Number.isFinite(box.width) &&
        Number.isFinite(box.height)
      ) {
        viewports.push({
          rect: rectOf(box),
          below: multiply(fit, ctm),
        });
      }
    }
    // In the space the element's own geometry is in, which its `transform`
    // then moves. For a nested `<svg>` that is the space its `x`, `y`,
    // `width` and `height` are in, before its `viewBox`, and its `getBBox`,
    // which is in its own user space after them, is carried out by `fit`.
    const at = current;
    const inner = fit;
    const clipRect = readClipRect(current, style, () => {
      const bbox = readBBox(at);
      if (!bbox || at.localName !== "svg") {
        return bbox;
      }
      // `fit` is a scale and a move, so the box maps corner and size alike,
      // and one with no area keeps none.
      const [x, y] = apply(inner, bbox.x, bbox.y);
      return { x, y, width: inner[0] * bbox.width, height: inner[3] * bbox.height };
    });
    if (clipRect) {
      viewports.push({ rect: clipRect, below: multiply(fit, ctm) });
    }
    ctm = multiply(withOwnTransform(current, fit, instance), ctm);
    current = getParentElement(current);
  }
  return { ctm, opacity, root: null, clip: null };
}

/**
 * The opacity an element of the picture is drawn at: the chain's, inside the
 * picture, times the root's own and every element's around it (see
 * `getOpacity`). The root's own is applied to its box by `div`, but what is
 * inside is drawn from materials of its own, so it is applied here too, or a
 * faded-out icon would keep its picture at full strength. Multiplied here
 * rather than in the chain, so an opacity animated on a button around the
 * icon re-runs this and not a walk of the matrices, which allocates at
 * every level.
 *
 * @param {Chain} chain
 * @returns {number}
 */
function drawnOpacity({ root, opacity }) {
  return root ? opacity * getOpacity(root) : opacity;
}

/**
 * Whether a ray hits a region of an element under the rule `pointer-events`
 * gives it: a region it names at all, painted where the rule asks for paint,
 * and shown where it asks for visibility. Each is read only when the rule
 * asks, so a shape under `pointer-events: all` follows neither.
 *
 * @param {HitRule | null} rule
 * @param {() => string} paint The region's `fill` or `stroke`, as drawn.
 * @param {() => boolean} hidden Whether `visibility` hides the element.
 * @returns {boolean}
 */
export function regionHits(rule, paint, hidden) {
  return rule !== null && (!rule.painted || isPainted(paint())) && (!rule.visible || !hidden());
}

/** The elements `shape` draws. */
export const SHAPE_TAGS = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
]);

/** The elements that draw something, and so take a place in the paint order. */
const PAINTED_TAGS = new Set([...SHAPE_TAGS, "image", "use", "text"]);

/**
 * @typedef {object} PaintOrder
 * @property {Map<Element, number>} index Each shape's place in the root's
 *   document order, counting shapes only.
 * @property {number} count How many there are.
 */

/**
 * @param {PaintOrder} a
 * @param {PaintOrder} b
 * @returns {boolean}
 */
function paintOrderEqual(a, b) {
  if (a.count !== b.count) {
    return false;
  }
  for (const [element, at] of a.index) {
    if (b.index.get(element) !== at) {
      return false;
    }
  }
  return true;
}

/** @type {WeakMap<Element, Derived<PaintOrder>>} */
const paintOrders = new WeakMap();

/**
 * The document order of the shapes and images under an `<svg>` root, or
 * under a template — SVG's painter order — as one computation per root that
 * every shape in it reads, rather than a walk per shape. It follows the mirror's child-list signals, so a
 * shape arriving or leaving anywhere under the root renumbers the root once,
 * and the shapes whose place did not change stop there.
 *
 * @param {Element} root
 * @returns {PaintOrder}
 */
function getPaintOrder(root) {
  let signal = paintOrders.get(root);
  if (!signal) {
    signal = new Derived(
      () => {
        /** @type {Map<Element, number>} */
        const index = new Map();
        /** @param {Node} node */
        const walk = (node) => {
          for (const child of getChildNodes(node)) {
            if (child.nodeType !== Node.ELEMENT_NODE) {
              continue;
            }
            const element = /** @type {Element} */ (child);
            if (PAINTED_TAGS.has(element.localName)) {
              index.set(element, index.size);
            }
            walk(element);
          }
        };
        walk(root);
        return { index, count: index.size };
      },
      { isEqual: paintOrderEqual },
    );
    paintOrders.set(root, signal);
  }
  return signal.get();
}

/**
 * A range of render orders: where something starts drawing, and how far it
 * may go before the next thing in the draw order.
 *
 * @typedef {object} PaintSlot
 * @property {number} start
 * @property {number} span
 */

/**
 * The layers an element draws in, in SVG's order: the fill, the stroke over
 * it, and the markers over both. A shape without markers leaves the third
 * one empty.
 */
const LAYERS = 3;

/**
 * Where one layer of an element belongs in the draw order. SVG paints in
 * document order, and this says so explicitly rather than leaning on three's
 * sort falling through to mesh id. That fallback is document order only for
 * the initial build, and a fill switched on by a hover, or a shape inserted
 * before its siblings, would otherwise jump the stack.
 *
 * An `<svg>` root's slot is the first half of its content level: from its
 * content render order R up to R + `BOX_BUCKET_BIAS`, where HTML text of
 * that order draws. A box drawn at the `<svg>`'s content level draws at that
 * bias, so every element of the `<svg>` draws before the box, whatever its
 * place in the document order. A slot that ran up to R + 1 drew the later
 * elements after the box, which writes depth, and a box in front of the
 * `<svg>` hid them. Each element in the slot gets an equal share of it by its
 * place in the root's document order, split into its three layers. The
 * content of an instance shares out the instance's slot the same way, by its
 * place in the template, so the arrowheads on a path are drawn over its
 * stroke and under whatever comes after it.
 *
 * @param {Element} element
 * @param {Element | null} root The element's `<svg>` root, from its chain.
 * @param {Instance | null} instance
 * @param {0 | 1 | 2} layer 0 for a fill or an image, 1 for a stroke, 2 for
 *   markers.
 * @returns {PaintSlot} Where the layer starts, which is the render order of
 *   what it draws, and its span, which an instance drawn there shares out.
 */
export function paintSlot(element, root, instance, layer) {
  const scope = instance ? instance.template : root;
  if (!scope) {
    return { start: getContentRenderOrder(asHtml(element)), span: 0 };
  }
  const slot = instance
    ? instance.slot()
    : { start: getContentRenderOrder(asHtml(scope)), span: BOX_BUCKET_BIAS };
  const { index, count } = getPaintOrder(scope);
  const at = index.get(element);
  if (at === undefined) {
    return { start: slot.start, span: 0 };
  }
  // One step more than there are layers, so the last one ends short of the
  // next slot rather than on it.
  const step = slot.span / (LAYERS * count + 1);
  return { start: slot.start + step * (LAYERS * at + layer + 1), span: step };
}

/**
 * How many segments to sample each curve of a shape at, given how large the
 * matrix draws a user unit: twice three's default of twelve at unit scale,
 * more as the shape is drawn bigger — an icon in a `viewBox` of 24 drawn at
 * 192px would show its polygons at any fixed count — and never fewer than
 * sixteen.
 * Twelve left a circle a few centimetres across on a panel, a point in a
 * drawing held at arm's length, visibly a polygon.
 *
 * @param {number} scale
 * @returns {number}
 */
function segmentsFor(scale) {
  return Math.max(16, Math.min(MAX_SEGMENTS, Math.round(24 * Math.sqrt(Math.max(scale, 1e-6)))));
}

/**
 * The stroke's whole description, gathered into one value with a structural
 * equality so that the geometry it decides is rebuilt when one of these
 * changes and not when the element is restyled in some way that touches
 * none of them.
 *
 * @typedef {object} StrokeSpec
 * @property {number} width
 * @property {"butt" | "round" | "square"} cap
 * @property {"miter" | "round" | "bevel"} join
 * @property {number} miterLimit
 * @property {number[] | null} dash
 * @property {number} dashOffset
 */

/**
 * @param {StrokeSpec} a
 * @param {StrokeSpec} b
 * @returns {boolean}
 */
function strokeSpecEqual(a, b) {
  if (
    a.width !== b.width ||
    a.cap !== b.cap ||
    a.join !== b.join ||
    a.miterLimit !== b.miterLimit ||
    a.dashOffset !== b.dashOffset
  ) {
    return false;
  }
  if (a.dash === b.dash) {
    return true;
  }
  if (!a.dash || !b.dash || a.dash.length !== b.dash.length) {
    return false;
  }
  return a.dash.every((value, index) => value === b.dash?.[index]);
}

/**
 * The stroke as drawn. Its width, dashes and dash offset may be percentages,
 * each a share of the viewport's diagonal over root two.
 *
 * @param {(name: string) => string} read The element's value for a
 *   property.
 * @param {() => { width: number, height: number } | null} viewport The
 *   viewport the shape is in, read only for a percentage.
 * @returns {StrokeSpec}
 */
function readStrokeSpec(read, viewport) {
  const { diagonal } = viewportReferences(viewport);
  return {
    width: parseLengthIn(read("stroke-width"), diagonal, 1),
    cap: parseLineCap(read("stroke-linecap")),
    join: parseLineJoin(read("stroke-linejoin")),
    miterLimit: parseNumber(read("stroke-miterlimit"), 4),
    dash: parseDashArray(read("stroke-dasharray"), diagonal),
    dashOffset: parseLengthIn(read("stroke-dashoffset"), diagonal, 0),
  };
}

/**
 * The fill's triangles, in user space — or null for a shape that encloses
 * no area.
 *
 * @param {ShapePath} path
 * @param {"nonzero" | "evenodd"} fillRule
 * @param {number} scale How large the shape is drawn, per user unit, which
 *   decides how finely its curves are sampled.
 * @returns {THREE.BufferGeometry | null}
 */
export function buildFillGeometry(path, fillRule, scale) {
  // `toShapes` reads the fill rule off the path it is called on. A parsed
  // path is shared by every `<path>` with the same `d`, so the rule is
  // written just before the call and read nowhere after it.
  path.userData = { style: { fillRule } };
  const shapes = path.toShapes();
  if (!shapes.length) {
    return null;
  }
  const geometry = new THREE.ShapeGeometry(shapes, segmentsFor(scale));
  if (!geometry.getAttribute("position").count) {
    geometry.dispose();
    return null;
  }
  // Drawn flat and unlit, and clipped in the position varying alone: the
  // normals and uvs `ShapeGeometry` writes are dead weight on the GPU.
  geometry.deleteAttribute("normal");
  geometry.deleteAttribute("uv");
  return geometry;
}

/**
 * The stroke's triangles, in user space — the element's subpaths sampled,
 * cut into dashes where there are any, and each run given width, joins and
 * caps by three's stroker. The matrices above take the stroke where the
 * shape goes, so a `viewBox` that stretches one axis stretches the stroke
 * with it, as the browser does. Null for nothing to draw.
 *
 * @param {ShapePath} path
 * @param {StrokeSpec} spec
 * @param {number} scale How large the shape is drawn, per user unit.
 * @returns {THREE.BufferGeometry | null}
 */
export function buildStrokeGeometry(path, spec, scale) {
  if (!(spec.width > 0)) {
    return null;
  }
  const segments = segmentsFor(scale);
  const style = SVGLoader.getStrokeStyle(spec.width, "#000", spec.join, spec.cap, spec.miterLimit);
  // In user units: what the stroker merges as one point has to be small
  // against the shape, whatever size the `viewBox` measures it in.
  const minDistance = 1e-4 / Math.max(scale, 1e-6);
  const dotLength = spec.cap === "butt" ? 0 : spec.width * DOT_LENGTH;
  /** @type {number[]} */
  const vertices = [];
  for (const subPath of path.subPaths) {
    const points = subPath.getPoints(segments);
    const runs = spec.dash ? dashRuns(points, spec.dash, spec.dashOffset, dotLength) : [points];
    for (const run of runs) {
      // Fresh buffers per run, and a uv buffer even though nothing reads
      // it: the stroker's square caps rewrite the first and last vertices
      // by absolute index and consult a uv on the way, so a run written at
      // an offset into a shared buffer would cap the wrong run, and one
      // written without uvs throws.
      /** @type {number[]} */
      const runVertices = [];
      SVGLoader.pointsToStrokeWithBuffers(
        run,
        style,
        ARC_DIVISIONS,
        minDistance,
        runVertices,
        undefined,
        [],
      );
      for (let i = 0; i < runVertices.length; i++) {
        vertices.push(runVertices[i]);
      }
    }
  }
  if (!vertices.length) {
    return null;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices), 3));
  return geometry;
}

/**
 * A stand-in for a geometry that came out empty: a mesh has to have one, and
 * an empty buffer draws nothing and costs nothing. Shared and never
 * disposed, like the rect quad.
 */
const emptyGeometry = new THREE.BufferGeometry();
emptyGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));

/**
 * What a mesh of an element draws: its geometry, whether and how it paints,
 * and whether a ray can hit it.
 *
 * @typedef {object} MeshOptions
 * @property {() => THREE.BufferGeometry | null} geometry Builds the
 *   geometry, reading whatever decides it; re-run, and the previous geometry
 *   disposed, when any of that changes.
 * @property {() => boolean} paints Whether the region paints anything: a
 *   fill or a stroke that is not `none`, a picture that has loaded.
 * @property {EntityEffect<THREE.Mesh>[]} paint The effects that write the
 *   material's colour, map and opacity.
 * @property {() => boolean} hidden Whether `visibility` hides the element
 *   this mesh paints.
 * @property {() => boolean} hit Whether a ray can hit this region.
 * @property {0 | 1} layer Which of the element's layers in its paint slot
 *   the mesh draws in: 0 for a fill, a picture or a run of text, 1 for the
 *   stroke over a fill.
 */

/**
 * One mesh of an element: a shape's fill or stroke, a picture, a run of
 * text. Every mesh of one element shares the element's clip, and each takes
 * its geometry and its paint from computations of its own, so that a colour
 * animation is a uniform write and a geometry change is not also a new
 * material.
 *
 * Being drawn and being hit are separate questions, because
 * `pointer-events` answers the second on its own terms. A region that is
 * not drawn can still be hit, such as `fill: none` under
 * `pointer-events: all` or a hidden shape under `painted`. A region that is
 * drawn can be one no ray finds. The mesh stays in the scene while either
 * answer is yes. It is drawn only for the first and raycast only for the
 * second.
 *
 * @param {MeshOptions} options
 * @param {(layer: 0 | 1 | 2) => PaintSlot} slot The element's paint slot,
 *   which `options.layer` picks the mesh's render order from.
 * @param {ReturnType<typeof clipUniforms>} uniforms
 * @returns {Source<Component>}
 */
function paintedMesh({ geometry, paints, paint, hidden, hit, layer }, slot, uniforms) {
  const { clip, clipMatrix, clipBox } = uniforms;
  const mesh = new THREE.Mesh();
  // Trimmed once, for the life of the mesh, to the part the clip patch
  // leaves drawn, with the same box, frame and matrix the shader uses. A
  // region no ray may hit skips the raycast entirely.
  clipRaycast(mesh, clipBox, mesh, clipMatrix);
  const clipped = mesh.raycast;
  let hittable = false;
  mesh.raycast = (raycaster, intersects) => {
    if (hittable) {
      clipped(raycaster, intersects);
    }
  };
  return $(mesh, [
    set("material", () => {
      // One material for the life of the mesh, whatever it shows, so the
      // effects below that write to it are never undone by a new one. On
      // the same terms as everything else a portal draws: two-sided,
      // because the container's flip turns every plane away from the
      // viewer; a single pass, because a flat mesh has no far surface to
      // draw first; and no depth write, so the draw order and not the depth
      // buffer decides what covers what on one plane.
      const material = new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        forceSinglePass: true,
        transparent: true,
        depthWrite: false,
      });
      applyClip(material, clip, clipMatrix);
      onCleanup(() => {
        material.dispose();
      });
      return material;
    }),
    set("geometry", () => {
      const built = geometry();
      if (!built) {
        return emptyGeometry;
      }
      onCleanup(() => {
        built.dispose();
      });
      return built;
    }),
    ...paint,
    effects((obj) => {
      const drawn = paints() && !hidden();
      hittable = hit();
      /** @type {THREE.MeshBasicMaterial} */ (obj.material).visible = drawn;
      // The raycaster skips an invisible object, so a mesh that is only hit
      // stays visible, and its material keeps it out of the draw.
      obj.visible = drawn || hittable;
    }),
    effects((obj) => {
      place(obj, 0, 0, 0);
      obj.renderOrder = slot(layer).start;
    }),
  ]);
}

/**
 * The clip patch's two uniforms for what one element draws, and the write
 * that keeps them current. Both are shared by every mesh the element has.
 *
 * `clip` is what the root's overflow, the scrollers above it and the
 * viewports in the chain leave, in the root's frame. `clipMatrix` goes from
 * the element's user space, where its vertices are, to that frame: the
 * composition of every matrix above the meshes, the element's own included.
 *
 * `follow` writes both, and is called from the effect that writes the
 * element's own matrix (see `svgNode`), not from effects of its own. The
 * three describe one picture: a transform on the element moves its object,
 * its `clipMatrix` and, when the `clip-path` is its own, its clip, and a
 * channel that runs effects under a budget can stop between any two
 * effects. Split, a frame could draw the new matrix through the old clip,
 * which for a sprite sheet shifted under a frame-sized clip is a sliver of
 * the next frame. The box itself is a `Derived`, so a transform that leaves
 * it where it was copies it again and computes nothing, and a scroll costs
 * the two matrix copies besides the four numbers.
 *
 * @param {() => Chain} chain
 * @param {Derived<Element | null>} root The chain's root, apart from the
 *   matrix, so a transform animated above the element leaves the box alone.
 *   The element's own, which its paint slot reads as well.
 */
function clipUniforms(chain, root) {
  const clip = { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) };
  const clipMatrix = { value: new THREE.Matrix3() };
  const viewports = new Derived(() => chain().clip, { isEqual: rectEqual });
  const interior = new Derived(() => {
    const at = root.get();
    const box = at ? getInteriorClipBox(asHtml(at)) : UNCLIPPED;
    const rect = viewports.get();
    if (!rect) {
      return box;
    }
    return intersectClipBoxes(box, {
      ...rect,
      topLeft: 0,
      topRight: 0,
      bottomRight: 0,
      bottomLeft: 0,
    });
  });
  /** What `clip` holds, for the raycast, which reads it untracked. */
  let current = UNCLIPPED;
  return {
    clip,
    clipMatrix,
    clipBox: () => current,
    follow() {
      const box = interior.get();
      clip.value.set(box.left, box.top, box.right, box.bottom);
      current = box;
      toMatrix3(chain().ctm, clipMatrix.value);
    },
  };
}

/**
 * Make an element's object a ray target of its own while it is clickable, by
 * the rule a box follows, and a ray can hit some part of it.
 *
 * Whether it is clickable is a signal of its own for the reason a box's is.
 * The handlers write `data-xr-*` onto the element, which invalidates its
 * computed style, and a re-read must not remount them.
 *
 * @param {WeakKey} ctx
 * @param {Element} element
 * @param {() => boolean} hittable Whether a ray can hit any of it. One that
 *   no ray can hit is not registered, even under `cursor: pointer`. A group
 *   passes true: it is registered on `cursor` alone, whatever it holds, and
 *   its walk is the one its shapes would otherwise have had (the manager
 *   casts a registered object under a registered ancestor once, from the
 *   ancestor), so a group with nothing a ray can hit costs no more than
 *   its shapes would have cost on their own.
 */
function rayTarget(ctx, element, hittable) {
  const clickable = new Derived(() => isClickable(asHtml(element)));
  return effects((/** @type {THREE.Object3D<XREventMap>} */ obj) => {
    if (!clickable.get() || !hittable()) {
      return;
    }
    // Built here and not up front, so that elements nobody can click, which
    // is most of them, pay nothing for it.
    useEffects(
      obj,
      forwardPointerEvents(ctx, asHtml(element), obj, { enabled: PortalReadyContext.get(ctx) }),
    );
  });
}

/**
 * What an element that draws is handed to draw with, by `svgNode`.
 *
 * @typedef {object} SvgNode
 * @property {() => Chain} chain The element's chain, compared by value.
 * @property {() => number} opacity The opacity it is drawn at
 *   (`drawnOpacity`).
 * @property {(layer: 0 | 1 | 2) => PaintSlot} slot Where in the draw order a
 *   layer of its paint goes (`paintSlot`).
 * @property {(options: MeshOptions) => Source<Component>} mesh One of its
 *   meshes, clipped by its clip and drawn in its slot. Template content is
 *   never hit, whatever `options.hit` says.
 */

/**
 * What an element that draws hands back to `svgNode`.
 *
 * @typedef {object} SvgDrawing
 * @property {() => boolean} hittable Whether a ray can hit any of it, which
 *   decides whether a clickable element is a ray target.
 * @property {EntityEffect<THREE.Object3D>[]} content Its meshes, as
 *   children, and whatever else hangs off its object.
 */

/**
 * The object every SVG element the portal builds is drawn by, a shape, a
 * picture, a `<text>` and a `<g>` alike: its own transform as the object's
 * matrix, taken out of the scene by `display: none`, and, outside a
 * template, a ray target while it is clickable.
 *
 * An element that draws passes `draw`, and is given its chain, its opacity
 * and its paint slot, and the meshes it asks for share the element's clip,
 * written in the effect that writes its matrix. The chain is read apart
 * from what it decides, so a transform animated above the element stops at
 * the clip matrix and reaches neither the draw order nor the alpha. A `<g>`
 * passes null: it draws nothing, reads no chain, and is a ray target on
 * `cursor` alone, since a hit on it is a hit on one of the shapes under it.
 *
 * Template content is drawn and never hit. The element a press on it would
 * be forwarded to is the one in the template, which is nowhere on the page,
 * so a copy is no ray target, and its meshes no ray finds, and it does not
 * read the template's style to find that out.
 *
 * @param {WeakKey} ctx
 * @param {Element} element
 * @param {Instance | null} instance The instance the element is part of,
 *   when it is template content drawn somewhere else.
 * @param {((node: SvgNode) => SvgDrawing) | null} draw
 * @param {EntityEffect<THREE.Object3D>[]} [decorate] More to hang off the
 *   object.
 * @returns {Source<THREE.Object3D>}
 */
export function svgNode(ctx, element, instance, draw, decorate = []) {
  /** @type {THREE.Object3D<XREventMap>} */
  const object = new THREE.Object3D();
  const own = new Derived(() => localMatrix(element, instance), { isEqual: matrixEqual });
  /** @type {() => boolean} */
  let hittable = () => true;
  /** @type {EntityEffect<THREE.Object3D>[]} */
  let drawing = [];
  /** Writes the clip uniforms; nothing for a `<g>`, which has none. */
  let followClip = () => {};
  if (draw) {
    const chain = new Derived(() => readChain(element, instance), { isEqual: chainEqual });
    const root = new Derived(() => chain.get().root);
    const opacity = new Derived(() => drawnOpacity(chain.get()));
    const uniforms = clipUniforms(() => chain.get(), root);
    followClip = uniforms.follow;
    /** @param {0 | 1 | 2} layer */
    const slot = (layer) => paintSlot(element, root.get(), instance, layer);
    const drawn = draw({
      chain: () => chain.get(),
      opacity: () => opacity.get(),
      slot,
      mesh: (options) =>
        paintedMesh({ ...options, hit: () => instance === null && options.hit() }, slot, uniforms),
    });
    // Gated by value: the ray target's handlers are mounted while this is
    // true, and a region switching on beside one already hit must not
    // remount them, which would drop the flags they wrote.
    const hit = new Derived(drawn.hittable);
    hittable = () => hit.get();
    drawing = drawn.content;
  }
  return just(object, [
    effects((obj) => {
      commitMatrix(obj, own.get());
      // In the same effect, so the clip can never lag the matrix it is
      // drawn through (see `clipUniforms`).
      followClip();
    }),
    ...(instance === null ? [rayTarget(ctx, element, hittable)] : []),
    effects((obj) => {
      // `display: none` takes the element out; `visibility` is the meshes'
      // business, the way it is a box's quad and not its object.
      obj.visible = getComputedStyleCached(element).display !== "none";
    }),
    ...drawing,
    ...decorate,
  ]);
}

/**
 * What a shape shows of itself to what decorates it: the markers drawn on
 * its vertices need its geometry, its stroke width, where it stands and
 * where in the draw order its marker layer is.
 *
 * @typedef {object} ShapeHost
 * @property {(name: string) => string} read The shape's value for a
 *   property, as `readDrawnProperty` gives it.
 * @property {() => ShapePath | null} path
 * @property {() => number} strokeWidth
 * @property {() => Chain} chain
 * @property {() => PaintSlot} markerSlot
 * @property {() => boolean} hidden Whether `visibility` hides the shape, which
 *   hides its markers too, as it does in a browser.
 */

/**
 * @typedef {object} ShapeOptions
 * @property {Instance | null} [instance] The instance this shape is part of,
 *   when it is template content drawn somewhere else.
 * @property {(host: ShapeHost) => EntityEffect<THREE.Object3D>[]} [decorate]
 *   More to hang off the shape's object. It is how `svg/template.js` adds
 *   markers without this module knowing about templates.
 */

/**
 * @param {WeakKey} ctx
 * @param {Element} element
 * @param {ShapeOptions} [options]
 * @returns {Source<THREE.Object3D>}
 */
export function shape(ctx, element, { instance = null, decorate } = {}) {
  const style = () => getComputedStyleCached(element);

  /**
   * The viewport the shape is in. Read by `readShapeGeometry` and
   * `readStrokeSpec` only for a length that is a percentage, so a shape
   * with none does not depend on the viewport's size.
   */
  const viewport = () => viewportSize(element, instance);

  /**
   * The geometry's numbers, compared field by field, so that the outline
   * below is built only when the geometry itself changed and not when the
   * element was restyled.
   */
  const geometry = new Derived(() => readShapeGeometry(style(), element, viewport), {
    isEqual: shapeGeometryEqual,
  });

  /** @type {Derived<ShapePath | null>} */
  const path = new Derived(() => {
    const current = geometry.get();
    return current ? buildShapePath(current) : null;
  });

  /** @param {string} name */
  const read = (name) => readDrawnProperty(element, name, instance);

  const fillPaint = new Derived(() => parsePaint(read("fill")), { isEqual: paintEqual });
  const strokePaint = new Derived(() => parsePaint(read("stroke")), { isEqual: paintEqual });
  const fillRule = new Derived(() => parseFillRule(read("fill-rule")));
  const strokeSpec = new Derived(() => readStrokeSpec(read, viewport), {
    isEqual: strokeSpecEqual,
  });

  /**
   * Whether `visibility` hides this shape, as a box's `hidden` does: its
   * meshes go out of the draw, and nothing else. Inherited like any
   * `visibility`, so a hidden `<g>` hides the shapes under it through their
   * own computed style, and a shape that says `visible` for itself is drawn
   * under it — the reason this is asked per shape and never turned into a
   * group's `visible`, which would prune the subtree.
   */
  const hidden = new Derived(() => isDrawnHidden(element, instance));

  /**
   * Which regions a ray can hit, from `pointer-events`. Every shape asks,
   * not only a clickable one, because a ray walks the meshes below whatever
   * is registered. A shape inside a clickable `<svg>`, `<g>` or `<a>`
   * decides by this whether a press on it reaches that ancestor or goes
   * through to what is behind, as it does on a page.
   */
  const hitRegions = new Derived(() =>
    parsePointerEvents(readProperty(style(), element, "pointer-events")),
  );

  /**
   * @param {HitRule | null} rule
   * @param {string} name `fill` or `stroke`, whichever paints the region.
   * @returns {boolean}
   */
  const hits = (rule, name) =>
    regionHits(
      rule,
      () => read(name),
      () => hidden.get(),
    );
  const fillHit = new Derived(() => hits(hitRegions.get().fill, "fill"));
  const strokeHit = new Derived(() => hits(hitRegions.get().stroke, "stroke"));

  return svgNode(ctx, element, instance, (node) => {
    // Apart from the chain, so a transform animated above the shape
    // reaches the geometry only when it crosses a rung.
    const scale = new Derived(() => samplingScale(matrixScale(node.chain().ctm)));

    /**
     * @param {Derived<Paint | null>} paint
     * @param {string} opacityName `fill-opacity` or `stroke-opacity`.
     * @returns {EntityEffect<THREE.Mesh>}
     */
    const tint = (paint, opacityName) =>
      effects((obj) => {
        const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
        const current = paint.get();
        if (current) {
          material.color.copy(current.color);
          material.opacity = current.alpha * (node.opacity() * parseNumber(read(opacityName), 1));
        }
      });

    return {
      /**
       * Whether a ray can hit any of the shape. One that no ray can hit is
       * not registered, even under `cursor: pointer`: a hidden shape under
       * the default `visiblePainted`, or one that paints nothing.
       * `isClickable` already says no under `pointer-events: none`.
       */
      hittable: () => fillHit.get() || strokeHit.get(),
      content: [
        children(
          // Fill before stroke: with equal render order and depth the sort
          // falls back to mesh id, and the stroke has to cover the fill's
          // edge.
          flatMap((/** @type {boolean} */ filled) =>
            filled
              ? node.mesh({
                  geometry: () => {
                    const current = path.get();
                    return current ? buildFillGeometry(current, fillRule.get(), scale.get()) : null;
                  },
                  paints: () => fillPaint.get() !== null,
                  paint: [tint(fillPaint, "fill-opacity")],
                  hidden: () => hidden.get(),
                  hit: () => fillHit.get(),
                  layer: 0,
                })
              : Nothing(),
          )(observable(() => fillPaint.get() !== null || fillHit.get())),
          flatMap((/** @type {boolean} */ stroked) =>
            stroked
              ? node.mesh({
                  geometry: () => {
                    const current = path.get();
                    return current
                      ? buildStrokeGeometry(current, strokeSpec.get(), scale.get())
                      : null;
                  },
                  paints: () => strokePaint.get() !== null,
                  paint: [tint(strokePaint, "stroke-opacity")],
                  hidden: () => hidden.get(),
                  hit: () => strokeHit.get(),
                  layer: 1,
                })
              : Nothing(),
          )(observable(() => strokePaint.get() !== null || strokeHit.get())),
        ),
        ...(decorate?.({
          read,
          path: () => path.get(),
          strokeWidth: () => strokeSpec.get().width,
          chain: node.chain,
          markerSlot: () => node.slot(2),
          hidden: () => hidden.get(),
        }) ?? []),
      ],
    };
  });
}

/**
 * A `<g>` (or anything else that only groups, a nested `<svg>` included):
 * an object with nothing to draw of its own, so that the object tree keeps
 * the DOM's shape and the portal has somewhere to attach the children. It
 * carries its transform — and a nested `<svg>` its viewport — as its matrix,
 * so moving it moves everything below without touching their geometry.
 * Its opacity is not applied here: every shape below folds its ancestors'
 * into its own alpha. `display: none` is, since a hidden group's shapes
 * still compute a `display` of their own.
 *
 * Under `cursor: pointer` it is a ray target, as a clickable box is, so a
 * `.node[data-xr-hover] rect` rule restyles the shape under the ray. A hit
 * on it is a hit on one of its shapes, and each shape keeps its own
 * `pointer-events`. A shape that is not clickable itself, a label under
 * `cursor: default`, is reached through the group. Template content is not
 * a ray target.
 *
 * @param {WeakKey} ctx
 * @param {Element} element
 * @param {object} [options]
 * @param {Instance | null} [options.instance] The instance the group is part
 *   of, when it is template content drawn somewhere else.
 * @param {EntityEffect<THREE.Object3D>[]} [options.decorate] More to hang off
 *   the group's object: in a template, its children, which the portal does
 *   not build there.
 * @returns {Source<THREE.Object3D>}
 */
export function group(ctx, element, { instance = null, decorate = [] } = {}) {
  return svgNode(ctx, element, instance, null, decorate);
}
