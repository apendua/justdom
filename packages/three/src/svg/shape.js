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
import { applyClip, clipRaycast, UNCLIPPED } from "../elements/clip.js";
import { PortalReadyContext } from "../elements/div.js";
import { forwardPointerEvents, isClickable } from "../elements/pointerForwarding.js";
import { place } from "../elements/place.js";
import { getContentRenderOrder } from "../elements/elevation.js";
import {
  getAttributeCached,
  getBorderBoxSize,
  getChildNodes,
  getComputedStyleCached,
  getInteriorClipBox,
  getParentElement,
  isVisibilityHidden,
} from "../elements/mirror.js";
import { isSvgRoot, SVG_NAMESPACE } from "../elements/plugins.js";
import {
  aboutOrigin,
  IDENTITY,
  matrixEqual,
  matrixScale,
  multiply,
  parseCssMatrix,
  parsePreserveAspectRatio,
  parseViewBox,
  samplingScale,
  toMatrix3,
  toMatrix4,
  translation,
  viewportMatrix,
} from "./geometry.js";
import { dashRuns } from "./dash.js";
import {
  paintEqual,
  isPainted,
  parseDashArray,
  parseFillRule,
  parseLength,
  parseLengthIn,
  parseLineCap,
  parseLineJoin,
  parseNumber,
  parsePaint,
  parsePointerEvents,
  readProperty,
  readShapeMarkup,
} from "./style.js";

/**
 * @import {Source} from '@apendua/signal';
 * @import {ShapePath} from 'three';
 * @import {Component, XREventMap} from '../core.js';
 * @import {ClipBox} from '../elements/clip.js';
 * @import {Matrix2D} from './geometry.js';
 * @import {HitRule, Paint} from './style.js';
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
const MAX_SEGMENTS = 64;

/**
 * How a zero-length dash is drawn under a cap that has some length of its
 * own: as a run this fraction of the stroke's width, so that the caps of
 * `stroke-dasharray: 0 8` with `stroke-linecap: round` meet in a circle.
 */
const DOT_LENGTH = 0.05;

/**
 * Parsed geometry, by the markup it was parsed from. A shape's `d` string
 * is the same across a hover, a colour animation and a resize, and parsing
 * it again for each would be the one expensive step on the path that is
 * meant to be cheap. Bounded, and simply emptied when full: the strings a
 * panel uses are few, and re-parsing them once is the whole cost of a miss.
 *
 * @type {Map<string, ShapePath | null>}
 */
const parsed = new Map();

const PARSED_LIMIT = 512;

/** One loader for every shape; `parse` keeps no state between calls. */
let loader = /** @type {SVGLoader | null} */ (null);

/**
 * @param {string} markup
 * @returns {ShapePath | null}
 */
function parseShape(markup) {
  const cached = parsed.get(markup);
  if (cached !== undefined) {
    return cached;
  }
  if (parsed.size >= PARSED_LIMIT) {
    parsed.clear();
  }
  loader ??= new SVGLoader();
  const result = loader.parse(`<svg xmlns="${SVG_NAMESPACE}">${markup}</svg>`);
  const path = result.paths[0] ?? null;
  parsed.set(markup, path);
  return path;
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
    const bbox =
      typeof (/** @type {SVGGraphicsElement} */ (element).getBBox) === "function"
        ? /** @type {SVGGraphicsElement} */ (element).getBBox()
        : null;
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
 * Everything the element inherits from where it stands: the matrix from its
 * user space to its `<svg>` root's border-box frame — the product of the
 * matrices the objects between the two carry — the opacity of the groups
 * above it folded into one number, and the root itself: null for a shape
 * that is not inside an `<svg>` at all, which the DOM allows and a browser
 * draws nothing for.
 *
 * @typedef {object} Chain
 * @property {Matrix2D} ctm
 * @property {number} opacity
 * @property {Element | null} root
 */

/**
 * @param {Chain} a
 * @param {Chain} b
 * @returns {boolean}
 */
export function chainEqual(a, b) {
  return a.root === b.root && a.opacity === b.opacity && matrixEqual(a.ctm, b.ctm);
}

/**
 * The `viewBox` origin of the nearest viewport above an element — the
 * offset a `view-box` transform origin is measured from.
 *
 * @param {Element} element
 * @returns {{ x: number, y: number }}
 */
function nearestViewBoxOrigin(element) {
  for (let current = element.parentElement; current; current = current.parentElement) {
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
 * @param {Element} element
 * @returns {{ width: number, height: number } | null}
 */
export function viewportSize(element) {
  for (let current = getParentElement(element); current; current = getParentElement(current)) {
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
    const box = svgViewport(current);
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
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function svgViewport(svg) {
  const style = getComputedStyleCached(svg);
  const outer = viewportSize(svg);
  /**
   * @param {string} name
   * @param {"width" | "height"} axis
   */
  const size = (name, axis) => {
    const value = parseLengthIn(readProperty(style, svg, name), outer?.[axis], Number.NaN);
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
 * The matrix an element below the root carries on its own object: from its
 * user space to its parent's. That is its computed `transform` about its
 * `transform-origin`, and for a nested `<svg>` the viewport it establishes
 * first — placed at its `x`, `y`, its own `viewBox` fitted into the `width`
 * and `height` it names (`svgViewport`). Not yet clipped to that viewport
 * (`docs/freedom-svg-plan.md`, S2b).
 *
 * @param {Element} element
 * @returns {Matrix2D}
 */
export function localMatrix(element) {
  const style = getComputedStyleCached(element);
  /** @type {Matrix2D} */
  let matrix = IDENTITY;
  if (element.localName === "svg") {
    const box = svgViewport(element);
    const viewport = viewportMatrix(
      parseViewBox(getAttributeCached(element, "viewBox")),
      parsePreserveAspectRatio(getAttributeCached(element, "preserveAspectRatio")),
      // A size nobody can know fits no `viewBox`: user units are the
      // parent's, as for a size of 0.
      Number.isFinite(box.width) ? box.width : 0,
      Number.isFinite(box.height) ? box.height : 0,
    );
    matrix = multiply(translation(box.x, box.y), viewport);
  }
  const own = ownTransform(element, style, nearestViewBoxOrigin(element));
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
 * Walk from the element to its root, composing the same matrices the
 * objects on the way carry. Every computed style read on the way is a
 * dependency, so a transform written to a `<g>` three levels up, or the
 * root resizing under a new `viewBox`, re-runs the shapes below it and
 * nothing else — and what a re-run costs is a uniform write and, at most, a
 * new sampling density.
 *
 * @param {Element} element
 * @returns {Chain}
 */
export function readChain(element) {
  /** @type {Matrix2D} */
  let ctm = IDENTITY;
  let opacity = 1;
  /** @type {Element | null} */
  let current = element;
  while (current) {
    const style = getComputedStyleCached(current);
    // The root's own opacity is applied to its box by `div`; the shapes
    // inside are drawn from materials of their own, so it is applied here
    // too, or a faded-out icon would keep its picture at full strength.
    opacity *= parseNumber(style.opacity, 1);
    if (isSvgRoot(current)) {
      return { ctm: multiply(rootMatrix(current), ctm), opacity, root: current };
    }
    ctm = multiply(localMatrix(current), ctm);
    current = getParentElement(current);
  }
  return { ctm, opacity, root: null };
}

/** The elements that draw something, and so take a place in the paint order. */
const PAINTED_TAGS = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "image",
]);

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
 * The document order of the shapes and images under an `<svg>` root — SVG's
 * painter order — as one computation per root that every shape in it reads,
 * rather than a walk per shape. It follows the mirror's child-list signals, so a
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
 * Where an element's meshes belong in the draw order: the root's content
 * order, plus a fraction from the element's place in the root's document
 * order (fill, then stroke, then the next element), which keeps everything
 * one `<svg>` draws strictly inside the root's own step. SVG paints in
 * document order, and this says so explicitly rather than leaning on three's
 * sort falling through to mesh id. That fallback is document order only for
 * the initial build, and a fill switched on by a hover, or a shape inserted
 * before its siblings, would otherwise jump the stack.
 *
 * @param {Element} element
 * @param {Element | null} root The element's `<svg>` root, from its chain.
 * @param {0 | 1} layer 0 for a fill or an image, 1 for a stroke over it.
 * @returns {number}
 */
export function paintRenderOrder(element, root, layer) {
  const base = getContentRenderOrder(asHtml(root ?? element));
  if (!root) {
    return base;
  }
  const { index, count } = getPaintOrder(root);
  const at = index.get(element);
  if (at === undefined) {
    return base;
  }
  return base + (2 * at + layer + 1) / (2 * count + 2);
}

/**
 * How many segments to sample each curve of a shape at, given how large the
 * matrix draws a user unit: three's default of twelve at unit scale, more
 * as the shape is drawn bigger — an icon in a `viewBox` of 24 drawn at 192px
 * would show its polygons at twelve — and never fewer than eight.
 *
 * @param {number} scale
 * @returns {number}
 */
function segmentsFor(scale) {
  return Math.max(8, Math.min(MAX_SEGMENTS, Math.round(12 * Math.sqrt(Math.max(scale, 1e-6)))));
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
 * @param {CSSStyleDeclaration} style
 * @param {Element} element
 * @returns {StrokeSpec}
 */
function readStrokeSpec(style, element) {
  return {
    width: parseLength(readProperty(style, element, "stroke-width"), 1),
    cap: parseLineCap(readProperty(style, element, "stroke-linecap")),
    join: parseLineJoin(readProperty(style, element, "stroke-linejoin")),
    miterLimit: parseNumber(readProperty(style, element, "stroke-miterlimit"), 4),
    dash: parseDashArray(readProperty(style, element, "stroke-dasharray")),
    dashOffset: parseLength(readProperty(style, element, "stroke-dashoffset"), 0),
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
  // `toShapes` reads the fill rule off the path it is called on. The parsed
  // path is shared by every element with the same geometry, so the rule is
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
export const emptyGeometry = new THREE.BufferGeometry();
emptyGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));

/**
 * One of a shape's two meshes: the same material and clip on both, with the
 * geometry and the colour each coming from a computation of its own, so
 * that a colour animation is a uniform write and a geometry change is not
 * also a new material.
 *
 * Being drawn and being hit are separate questions, because
 * `pointer-events` answers the second on its own terms. A region that is
 * not drawn can still be hit, such as `fill: none` under
 * `pointer-events: all` or a hidden shape under `painted`. A region that is
 * drawn can be one no ray finds. The mesh stays in the scene while either
 * answer is yes. It is drawn only for the first and raycast only for the
 * second.
 *
 * @param {object} options
 * @param {() => THREE.BufferGeometry | null} options.geometry Builds the
 *   geometry, reading whatever decides it; re-run, and the previous
 *   geometry disposed, when any of that changes.
 * @param {() => Paint | null} options.paint
 * @param {() => number} options.opacity What multiplies the paint's alpha:
 *   the element's own `opacity` chain and the `fill-opacity` or
 *   `stroke-opacity` that goes with this mesh.
 * @param {() => number} options.renderOrder
 * @param {{ value: THREE.Vector4 }} options.clip
 * @param {{ value: THREE.Matrix3 }} options.clipMatrix
 * @param {() => ClipBox} options.clipBox The box `clip` holds. Three's
 *   raycast reads it, and nothing is tracked there.
 * @param {() => boolean} options.hidden Whether `visibility` hides the
 *   element this mesh paints.
 * @param {() => boolean} options.hit Whether a ray can hit this region.
 * @returns {Source<Component>}
 */
function paintedMesh({
  geometry,
  paint,
  opacity,
  renderOrder,
  clip,
  clipMatrix,
  clipBox,
  hidden,
  hit,
}) {
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
      const material = new THREE.MeshBasicMaterial({
        // On the same terms as everything else a portal draws: two-sided,
        // because the container's flip turns every plane away from the
        // viewer; a single pass, because a flat mesh has no far surface to
        // draw first; and no depth write, so the draw order and not the
        // depth buffer decides what covers what on one plane.
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
    effects((obj) => {
      const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
      const current = paint();
      if (current) {
        material.color.copy(current.color);
        material.opacity = current.alpha * opacity();
      }
    }),
    effects((obj) => {
      const drawn = paint() !== null && !hidden();
      hittable = hit();
      /** @type {THREE.MeshBasicMaterial} */ (obj.material).visible = drawn;
      // The raycaster skips an invisible object, so a mesh that is only hit
      // stays visible, and its material keeps it out of the draw.
      obj.visible = drawn || hittable;
    }),
    effects((obj) => {
      place(obj, 0, 0, 0);
      obj.renderOrder = renderOrder();
    }),
  ]);
}

/**
 * The clip patch's two uniforms for what one element draws, and the effects
 * that keep them current. Both are shared by every mesh the element has.
 *
 * `clip` is what the root's overflow and the scrollers above it leave, in
 * the root's frame, written in an effect of its own so a scroll writes four
 * numbers and nothing else. `clipMatrix` goes from the element's user space,
 * where its vertices are, to that frame: the composition of every matrix
 * above the meshes, written when the chain moves.
 *
 * @param {() => Element | null} root
 * @param {() => Matrix2D} ctm
 */
export function clipUniforms(root, ctm) {
  const clip = { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) };
  const clipMatrix = { value: new THREE.Matrix3() };
  /** What `clip` holds, for the raycast, which reads it untracked. */
  let current = UNCLIPPED;
  return {
    clip,
    clipMatrix,
    clipBox: () => current,
    followClip: [
      effects(() => {
        const at = root();
        const box = at ? getInteriorClipBox(asHtml(at)) : UNCLIPPED;
        clip.value.set(box.left, box.top, box.right, box.bottom);
        current = box;
      }),
      effects(() => {
        toMatrix3(ctm(), clipMatrix.value);
      }),
    ],
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
 *   no ray can hit is not registered, even under `cursor: pointer`.
 */
export function rayTarget(ctx, element, hittable) {
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
 * @param {WeakKey} ctx
 * @param {Element} element
 * @returns {Source<THREE.Object3D>}
 */
export function shape(ctx, element) {
  /** @type {THREE.Object3D<XREventMap>} */
  const object = new THREE.Object3D();

  const style = () => getComputedStyleCached(element);

  /**
   * The geometry as markup — a string, compared as one, so that the parse
   * below runs only when the geometry itself changed and not when the
   * element was restyled.
   */
  const markup = new Derived(() => readShapeMarkup(style(), element));

  /** @type {Derived<ShapePath | null>} */
  const path = new Derived(() => {
    const current = markup.get();
    return current ? parseShape(current) : null;
  });

  /** This shape's own transform, which its object carries. */
  const own = new Derived(() => localMatrix(element), { isEqual: matrixEqual });

  const chain = new Derived(() => readChain(element), { isEqual: chainEqual });

  // What the chain decides, apart, so a transform animated above the shape
  // stops at the clip matrix and reaches neither the draw order, nor the
  // alpha, nor — until it crosses a rung — the geometry.
  const root = new Derived(() => chain.get().root);
  const opacity = new Derived(() => chain.get().opacity);
  const scale = new Derived(() => samplingScale(matrixScale(chain.get().ctm)));

  const fillPaint = new Derived(() => parsePaint(readProperty(style(), element, "fill")), {
    isEqual: paintEqual,
  });
  const strokePaint = new Derived(() => parsePaint(readProperty(style(), element, "stroke")), {
    isEqual: paintEqual,
  });
  const fillRule = new Derived(() => parseFillRule(readProperty(style(), element, "fill-rule")));
  const strokeSpec = new Derived(() => readStrokeSpec(style(), element), {
    isEqual: strokeSpecEqual,
  });

  /**
   * @param {0 | 1} layer 0 for the fill, 1 for the stroke drawn over it.
   * @returns {() => number}
   */
  const renderOrderOf = (layer) => () => paintRenderOrder(element, root.get(), layer);

  const { clip, clipMatrix, clipBox, followClip } = clipUniforms(
    () => root.get(),
    () => chain.get().ctm,
  );

  /**
   * Whether `visibility` hides this shape, as a box's `hidden` does: its
   * meshes go out of the draw, and nothing else. Inherited like any
   * `visibility`, so a hidden `<g>` hides the shapes under it through their
   * own computed style, and a shape that says `visible` for itself is drawn
   * under it — the reason this is asked per shape and never turned into a
   * group's `visible`, which would prune the subtree.
   */
  const hidden = new Derived(() => isVisibilityHidden(element));

  /**
   * Which regions a ray can hit, from `pointer-events`. Every shape asks,
   * not only a clickable one, because a ray walks the meshes below whatever
   * is registered. A shape inside a clickable `<svg>` or `<a>` decides by
   * this whether a press on it reaches that ancestor or goes through to
   * what is behind, as it does on a page.
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
    rule !== null &&
    (!rule.painted || isPainted(readProperty(style(), element, name))) &&
    (!rule.visible || !hidden.get());
  const fillHit = new Derived(() => hits(hitRegions.get().fill, "fill"));
  const strokeHit = new Derived(() => hits(hitRegions.get().stroke, "stroke"));

  /**
   * Whether a ray can hit any of the shape. One that no ray can hit is not
   * registered, even under `cursor: pointer`: a hidden shape under the
   * default `visiblePainted`, or one that paints nothing. `isClickable`
   * already says no under `pointer-events: none`.
   */
  const hittable = new Derived(() => fillHit.get() || strokeHit.get());

  return just(object, [
    effects((obj) => {
      commitMatrix(obj, own.get());
    }),
    rayTarget(ctx, element, () => hittable.get()),
    effects((obj) => {
      // `display: none` takes the shape out; `visibility` is the meshes'
      // business, below, the way it is a box's quad and not its object.
      obj.visible = style().display !== "none";
    }),
    ...followClip,
    children(
      // Fill before stroke: with equal render order and depth the sort
      // falls back to mesh id, and the stroke has to cover the fill's edge.
      flatMap((/** @type {boolean} */ filled) =>
        filled
          ? paintedMesh({
              geometry: () => {
                const current = path.get();
                return current ? buildFillGeometry(current, fillRule.get(), scale.get()) : null;
              },
              paint: () => fillPaint.get(),
              hidden: () => hidden.get(),
              hit: () => fillHit.get(),
              opacity: () =>
                opacity.get() * parseNumber(readProperty(style(), element, "fill-opacity"), 1),
              renderOrder: renderOrderOf(0),
              clip,
              clipMatrix,
              clipBox,
            })
          : Nothing(),
      )(observable(() => fillPaint.get() !== null || fillHit.get())),
      flatMap((/** @type {boolean} */ stroked) =>
        stroked
          ? paintedMesh({
              geometry: () => {
                const current = path.get();
                return current ? buildStrokeGeometry(current, strokeSpec.get(), scale.get()) : null;
              },
              paint: () => strokePaint.get(),
              hidden: () => hidden.get(),
              hit: () => strokeHit.get(),
              opacity: () =>
                opacity.get() * parseNumber(readProperty(style(), element, "stroke-opacity"), 1),
              renderOrder: renderOrderOf(1),
              clip,
              clipMatrix,
              clipBox,
            })
          : Nothing(),
      )(observable(() => strokePaint.get() !== null || strokeHit.get())),
    ),
  ]);
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
 * @param {WeakKey} ctx
 * @param {Element} element
 * @returns {Source<THREE.Object3D>}
 */
export function group(ctx, element) {
  const object = new THREE.Object3D();
  const matrix = new Derived(() => localMatrix(element), { isEqual: matrixEqual });
  return just(object, [
    effects((obj) => {
      commitMatrix(obj, matrix.get());
    }),
    effects((obj) => {
      obj.visible = getComputedStyleCached(element).display !== "none";
    }),
  ]);
}
