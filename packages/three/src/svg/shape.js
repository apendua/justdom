import * as THREE from "three";
import { Derived, effects, flatMap, just, observable, onCleanup, set } from "@apendua/signal";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { $, children, Nothing } from "../operators.js";
import { applyClip, UNCLIPPED } from "../elements/clip.js";
import { place } from "../elements/place.js";
import { getContentRenderOrder } from "../elements/elevation.js";
import {
  getBorderBoxSize,
  getComputedStyleCached,
  getInteriorClipBox,
  getParentElement,
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
  transformPositions,
  translation,
  viewportMatrix,
} from "./geometry.js";
import { dashRuns } from "./dash.js";
import {
  paintEqual,
  parseDashArray,
  parseFillRule,
  parseLength,
  parseLineCap,
  parseLineJoin,
  parseNumber,
  parsePaint,
  readProperty,
  readShapeMarkup,
} from "./style.js";

/**
 * @import {Source} from '@apendua/signal';
 * @import {ShapePath} from 'three';
 * @import {Component} from '../core.js';
 * @import {Matrix2D} from './geometry.js';
 * @import {Paint} from './style.js';
 */

/**
 * A shape element — `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`,
 * `<polyline>`, `<polygon>` — projected into the scene: an object carrying
 * a fill mesh, a stroke mesh, or both, each triangulated from the element's
 * geometry and dressed from its computed style.
 *
 * Where the vertices land is decided here and not in the scene graph. Every
 * shape is baked into the frame of the `<svg>` root it sits in — its user
 * space taken through its own transform, its ancestors' transforms and the
 * root's viewport transform, on the CPU — and its object sits at the root's
 * origin with an identity matrix. That is the one frame the portal already
 * knows how to clip and order content in: the clip patch tests the mesh's
 * own `position.xy` against a box in the element's frame, so a shape whose
 * vertices are in that frame is clipped by the same four numbers the root's
 * text would be. The price is that a transform animation on a `<g>` rewrites
 * its descendants' vertex buffers each frame; the plan's S4 moves transforms
 * onto matrices once the clip can follow them there.
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
 * user space to its `<svg>` root's border-box frame, the opacity of the
 * groups above it folded into one number, and the root itself — null for a
 * shape that is not inside an `<svg>` at all, which the DOM allows and a
 * browser draws nothing for.
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
function chainEqual(a, b) {
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
      const viewBox = parseViewBox(current.getAttribute("viewBox"));
      return viewBox ? { x: viewBox.x, y: viewBox.y } : { x: 0, y: 0 };
    }
  }
  return { x: 0, y: 0 };
}

/**
 * Walk from the element to its root, composing as it goes. Every computed
 * style read on the way is a dependency, so a transform written to a `<g>`
 * three levels up, or the root resizing under a new `viewBox`, re-runs the
 * shapes below it and nothing else.
 *
 * @param {Element} element
 * @returns {Chain}
 */
function readChain(element) {
  /** @type {Matrix2D} */
  let ctm = IDENTITY;
  let opacity = 1;
  /** @type {Element | null} */
  let current = element;
  while (current) {
    const style = getComputedStyleCached(current);
    if (isSvgRoot(current)) {
      // The viewport: the root's content box, which is where the `viewBox`
      // is fitted, offset from the border-box corner the frame is measured
      // from by the border and padding around it.
      const size = getBorderBoxSize(asHtml(current));
      const borderLeft = px(style.borderLeftWidth);
      const borderTop = px(style.borderTopWidth);
      const paddingLeft = px(style.paddingLeft);
      const paddingTop = px(style.paddingTop);
      const width =
        size.width - borderLeft - px(style.borderRightWidth) - paddingLeft - px(style.paddingRight);
      const height =
        size.height -
        borderTop -
        px(style.borderBottomWidth) -
        paddingTop -
        px(style.paddingBottom);
      const viewport = viewportMatrix(
        parseViewBox(current.getAttribute("viewBox")),
        parsePreserveAspectRatio(current.getAttribute("preserveAspectRatio")),
        width,
        height,
      );
      ctm = multiply(
        translation(borderLeft + paddingLeft, borderTop + paddingTop),
        multiply(viewport, ctm),
      );
      // The root's own opacity is applied to its box by `div`; the shapes
      // inside are drawn from materials of their own, so it is applied here
      // too, or a faded-out icon would keep its picture at full strength.
      opacity *= parseNumber(style.opacity, 1);
      return { ctm, opacity, root: current };
    }
    if (current.localName === "svg") {
      // A nested viewport: placed at its `x`, `y`, with its own `viewBox`
      // fitted into the `width` and `height` it names. Not yet clipped to
      // that viewport (`docs/freedom-svg-plan.md`, S2).
      const width = parseLength(readProperty(style, current, "width"), 0);
      const height = parseLength(readProperty(style, current, "height"), 0);
      const viewport = viewportMatrix(
        parseViewBox(current.getAttribute("viewBox")),
        parsePreserveAspectRatio(current.getAttribute("preserveAspectRatio")),
        width,
        height,
      );
      const x = parseLength(readProperty(style, current, "x"), 0);
      const y = parseLength(readProperty(style, current, "y"), 0);
      ctm = multiply(translation(x, y), multiply(viewport, ctm));
    }
    const own = ownTransform(current, style, nearestViewBoxOrigin(current));
    if (own) {
      ctm = multiply(own, ctm);
    }
    opacity *= parseNumber(style.opacity, 1);
    current = getParentElement(current);
  }
  return { ctm, opacity, root: null };
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
 * The fill's triangles, in the root's frame — or null for a shape that
 * encloses no area.
 *
 * @param {ShapePath} path
 * @param {"nonzero" | "evenodd"} fillRule
 * @param {Matrix2D} ctm
 * @returns {THREE.BufferGeometry | null}
 */
export function buildFillGeometry(path, fillRule, ctm) {
  // `toShapes` reads the fill rule off the path it is called on. The parsed
  // path is shared by every element with the same geometry, so the rule is
  // written just before the call and read nowhere after it.
  path.userData = { style: { fillRule } };
  const shapes = path.toShapes();
  if (!shapes.length) {
    return null;
  }
  const geometry = new THREE.ShapeGeometry(shapes, segmentsFor(matrixScale(ctm)));
  const position = geometry.getAttribute("position");
  if (!position.count) {
    geometry.dispose();
    return null;
  }
  transformPositions(/** @type {Float32Array} */ (position.array), ctm);
  // Drawn flat and unlit, and clipped in the position varying alone: the
  // normals and uvs `ShapeGeometry` writes are dead weight on the GPU.
  geometry.deleteAttribute("normal");
  geometry.deleteAttribute("uv");
  return geometry;
}

/**
 * The stroke's triangles, in the root's frame — the element's subpaths
 * sampled, cut into dashes where there are any, and each run given width,
 * joins and caps by three's stroker in user space before the whole is taken
 * through the matrix, so that a `viewBox` that stretches one axis stretches
 * the stroke with it, as the browser does. Null for nothing to draw.
 *
 * @param {ShapePath} path
 * @param {StrokeSpec} spec
 * @param {Matrix2D} ctm
 * @returns {THREE.BufferGeometry | null}
 */
export function buildStrokeGeometry(path, spec, ctm) {
  if (!(spec.width > 0)) {
    return null;
  }
  const scale = matrixScale(ctm);
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
  const positions = new Float32Array(vertices);
  transformPositions(positions, ctm);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
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
 * One of a shape's two meshes: the same material and clip on both, with the
 * geometry and the colour each coming from a computation of its own, so
 * that a colour animation is a uniform write and a geometry change is not
 * also a new material.
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
 * @returns {Source<Component>}
 */
function paintedMesh({ geometry, paint, opacity, renderOrder, clip }) {
  const mesh = new THREE.Mesh();
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
      applyClip(material, clip);
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
      obj.visible = current !== null;
    }),
    effects((obj) => {
      place(obj, 0, 0, 0);
      obj.renderOrder = renderOrder();
    }),
  ]);
}

/**
 * @param {WeakKey} ctx
 * @param {Element} element
 * @returns {Source<THREE.Object3D>}
 */
export function shape(ctx, element) {
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

  const chain = new Derived(() => readChain(element), { isEqual: chainEqual });

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
   * Where the shapes of this root belong in the draw order: the root's own
   * content order, the same for every shape in it, at the same depth — so
   * that three's stable sort falls through to mesh id, and meshes are made
   * in document order, which is SVG's painter order.
   */
  const renderOrder = () => {
    const root = chain.get().root;
    return getContentRenderOrder(asHtml(root ?? element));
  };

  /**
   * What the root's overflow and the scrollers above it leave of the shape,
   * in the root's frame — which is the frame the vertices are in. One
   * uniform, shared by both meshes, written in an effect of its own so a
   * scroll writes four numbers here and nothing else.
   */
  const clip = { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) };

  const opacity = () => chain.get().opacity;

  return just(object, [
    effects((obj) => {
      place(obj, 0, 0, 0);
      // `display` and not `visibility`: the portal's own container is
      // `visibility: hidden`, which every element inside it inherits, so a
      // shape cannot tell an authored `hidden` from the panel's. A box does
      // not follow `visibility` either.
      obj.visible = style().display !== "none";
    }),
    effects(() => {
      const root = chain.get().root;
      const box = root ? getInteriorClipBox(asHtml(root)) : UNCLIPPED;
      clip.value.set(box.left, box.top, box.right, box.bottom);
    }),
    children(
      // Fill before stroke: with equal render order and depth the sort
      // falls back to mesh id, and the stroke has to cover the fill's edge.
      flatMap((/** @type {boolean} */ filled) =>
        filled
          ? paintedMesh({
              geometry: () => {
                const current = path.get();
                return current ? buildFillGeometry(current, fillRule.get(), chain.get().ctm) : null;
              },
              paint: () => fillPaint.get(),
              opacity: () =>
                opacity() * parseNumber(readProperty(style(), element, "fill-opacity"), 1),
              renderOrder,
              clip,
            })
          : Nothing(),
      )(observable(() => fillPaint.get() !== null)),
      flatMap((/** @type {boolean} */ stroked) =>
        stroked
          ? paintedMesh({
              geometry: () => {
                const current = path.get();
                return current
                  ? buildStrokeGeometry(current, strokeSpec.get(), chain.get().ctm)
                  : null;
              },
              paint: () => strokePaint.get(),
              opacity: () =>
                opacity() * parseNumber(readProperty(style(), element, "stroke-opacity"), 1),
              renderOrder,
              clip,
            })
          : Nothing(),
      )(observable(() => strokePaint.get() !== null)),
    ),
  ]);
}

/**
 * A `<g>` (or anything else that only groups): an object with nothing of
 * its own, so that the object tree keeps the DOM's shape and the portal has
 * somewhere to attach the children. Its transform and opacity are not
 * applied here — every shape below folds its ancestors' into its own
 * vertices and alpha — but `display: none` is, since a hidden group's
 * shapes still compute a `display` of their own.
 *
 * @param {WeakKey} ctx
 * @param {Element} element
 * @returns {Source<THREE.Object3D>}
 */
export function group(ctx, element) {
  const object = new THREE.Object3D();
  return just(object, [
    effects((obj) => {
      place(obj, 0, 0, 0);
      obj.visible = getComputedStyleCached(element).display !== "none";
    }),
  ]);
}
