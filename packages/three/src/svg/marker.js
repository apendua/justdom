import { LineCurve } from "three";
import { SVG_NAMESPACE } from "../elements/plugins.js";
import {
  apply,
  multiply,
  parsePreserveAspectRatio,
  parseViewBox,
  rotation,
  scaling,
  translation,
  viewportMatrix,
} from "./geometry.js";

/**
 * Where the markers on a path go, as arithmetic.
 *
 * A marker is drawn at a vertex of a `<path>`, `<line>`, `<polyline>` or
 * `<polygon>`: `marker-start` at the first, `marker-end` at the last and
 * `marker-mid` at every one between. Each is a copy of the `<marker>`'s
 * content, placed by one matrix. The matrix takes the marker's `viewBox`
 * into a box `markerWidth` by `markerHeight`, moves its `refX`, `refY` onto
 * the vertex, scales it by the stroke width under the default
 * `markerUnits`, and turns it to the path's direction there under
 * `orient="auto"`.
 *
 * Everything here is pure except `findMarker`, which looks the `<marker>` up
 * by id. What reads the element and draws the copies is `svg/template.js`.
 *
 * @import {Curve, ShapePath, Vector2} from 'three';
 * @import {Matrix2D, PreserveAspectRatio, ViewBox} from './geometry.js';
 */

/** The elements markers are drawn on. */
export const MARKABLE_TAGS = new Set(["path", "line", "polyline", "polygon"]);

/**
 * A vertex a marker can be drawn at.
 *
 * @typedef {object} MarkerVertex
 * @property {number} x
 * @property {number} y
 * @property {number} angle The path's direction there, in radians, clockwise
 *   from the x axis: the direction it leaves in, arrives in, or halfway
 *   between the two where it does both.
 * @property {"start" | "mid" | "end"} position
 */

/**
 * The direction of a curve at `t`, in radians.
 *
 * @param {Curve<Vector2>} curve
 * @param {number} t
 * @returns {number}
 */
function direction(curve, t) {
  const tangent = curve.getTangent(t);
  return Math.atan2(tangent.y, tangent.x);
}

/**
 * The direction halfway between arriving at `into` and leaving at `out`,
 * which is where SVG points a marker at a corner. A path that doubles back
 * has no halfway, and keeps the direction it arrived in.
 *
 * @param {number} into
 * @param {number} out
 * @returns {number}
 */
export function bisect(into, out) {
  const x = Math.cos(into) + Math.cos(out);
  const y = Math.sin(into) + Math.sin(out);
  return Math.hypot(x, y) < 1e-9 ? into : Math.atan2(y, x);
}

/**
 * Every vertex of a parsed path, in order: the start of each subpath and the
 * end of each of its segments. A closed subpath ends where it began, with a
 * vertex there for each end, and both point halfway between the closing
 * segment and the first one.
 *
 * @param {ShapePath} path
 * @returns {MarkerVertex[]}
 */
export function markerVertices(path) {
  /** @type {{ x: number, y: number, angle: number }[]} */
  const vertices = [];
  for (const subPath of path.subPaths) {
    /** @type {Curve<Vector2>[]} */
    const curves = [...subPath.curves];
    if (!curves.length) {
      continue;
    }
    const first = curves[0].getPoint(0);
    const last = curves[curves.length - 1].getPoint(1);
    const closed = subPath.autoClose;
    if (closed && !first.equals(last)) {
      // Three draws the closing segment of a `Z` or a `<polygon>` without a
      // curve of its own. It is a segment all the same, with a vertex at
      // each end.
      curves.push(new LineCurve(last, first));
    }
    const count = curves.length;
    const leaves = curves.map((curve) => direction(curve, 0));
    const arrives = curves.map((curve) => direction(curve, 1));
    for (let i = 0; i <= count; i++) {
      const point = i === 0 ? first : curves[i - 1].getPoint(1);
      const into = i > 0 ? arrives[i - 1] : closed ? arrives[count - 1] : null;
      const out = i < count ? leaves[i] : closed ? leaves[0] : null;
      vertices.push({
        x: point.x,
        y: point.y,
        angle: into === null ? (out ?? 0) : out === null ? into : bisect(into, out),
      });
    }
  }
  return vertices.map((vertex, index) => ({
    ...vertex,
    position: index === 0 ? "start" : index === vertices.length - 1 ? "end" : "mid",
  }));
}

/**
 * `orient`: along the path, along it but reversed at the start (for a line
 * with an arrowhead at each end), or a fixed angle.
 *
 * @typedef {object} MarkerOrient
 * @property {"auto" | "auto-start-reverse" | "angle"} kind
 * @property {number} angle In radians, for `angle`.
 */

/** @type {Record<string, number>} */
const ANGLE_UNITS = { deg: Math.PI / 180, rad: 1, grad: Math.PI / 200, turn: 2 * Math.PI };

/**
 * @param {string | null} value
 * @returns {MarkerOrient}
 */
export function parseOrient(value) {
  const trimmed = (value ?? "").trim();
  if (trimmed === "auto" || trimmed === "auto-start-reverse") {
    return { kind: trimmed, angle: 0 };
  }
  const match = /^([+-]?[\d.]+(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(trimmed);
  const angle = match ? Number.parseFloat(match[1]) * ANGLE_UNITS[match[2] ?? "deg"] : 0;
  return { kind: "angle", angle: Number.isFinite(angle) ? angle : 0 };
}

/**
 * Everything a `<marker>` says about where its content goes.
 *
 * @typedef {object} MarkerSpec
 * @property {ViewBox | null} viewBox
 * @property {PreserveAspectRatio} aspect
 * @property {number} width `markerWidth`, 3 by default.
 * @property {number} height `markerHeight`, 3 by default.
 * @property {number} refX In the marker's own user space.
 * @property {number} refY
 * @property {boolean} strokeUnits Whether `markerUnits` is `strokeWidth`,
 *   the default, which scales the marker by the path's stroke width.
 * @property {MarkerOrient} orient
 */

/**
 * @param {string | null} value
 * @param {number} fallback
 * @returns {number}
 */
function number(value, fallback) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * `refX` or `refY`: a number in the marker's user space, or one of the
 * keywords SVG 2 adds, which name an edge or the middle of the `viewBox`.
 *
 * @param {string | null} value
 * @param {"left" | "top"} start The keyword for the near edge.
 * @param {"right" | "bottom"} end
 * @param {number} origin The `viewBox`'s near edge on this axis.
 * @param {number} length Its length on this axis.
 * @returns {number}
 */
function parseReference(value, start, end, origin, length) {
  switch ((value ?? "").trim()) {
    case start:
      return origin;
    case "center":
      return origin + length / 2;
    case end:
      return origin + length;
    default:
      return number(value, 0);
  }
}

/**
 * The `<marker>`'s attributes as a `MarkerSpec`. None of them is a CSS
 * property, so they are read as attributes.
 *
 * @param {Element} marker
 * @returns {MarkerSpec}
 */
export function readMarkerSpec(marker) {
  const viewBox = parseViewBox(marker.getAttribute("viewBox"));
  const width = number(marker.getAttribute("markerWidth"), 3);
  const height = number(marker.getAttribute("markerHeight"), 3);
  return {
    viewBox,
    aspect: parsePreserveAspectRatio(marker.getAttribute("preserveAspectRatio")),
    width,
    height,
    refX: parseReference(
      marker.getAttribute("refX"),
      "left",
      "right",
      viewBox?.x ?? 0,
      viewBox?.width ?? width,
    ),
    refY: parseReference(
      marker.getAttribute("refY"),
      "top",
      "bottom",
      viewBox?.y ?? 0,
      viewBox?.height ?? height,
    ),
    strokeUnits: marker.getAttribute("markerUnits") !== "userSpaceOnUse",
    orient: parseOrient(marker.getAttribute("orient")),
  };
}

/**
 * The matrix from a marker's viewport, the box `markerWidth` by
 * `markerHeight` with its origin at the top-left corner, to the user space
 * of the path it is drawn on, for one vertex. The box is what the marker
 * clips its content to.
 *
 * @param {MarkerSpec} spec
 * @param {MarkerVertex} vertex
 * @param {number} strokeWidth The path's.
 * @returns {Matrix2D}
 */
export function markerFrame(spec, vertex, strokeWidth) {
  let angle = spec.orient.angle;
  if (spec.orient.kind !== "angle") {
    angle = vertex.angle;
    if (spec.orient.kind === "auto-start-reverse" && vertex.position === "start") {
      angle += Math.PI;
    }
  }
  const [refX, refY] = apply(markerViewport(spec), spec.refX, spec.refY);
  const scale = spec.strokeUnits ? strokeWidth : 1;
  return multiply(
    translation(vertex.x, vertex.y),
    multiply(rotation(angle), multiply(scaling(scale, scale), translation(-refX, -refY))),
  );
}

/**
 * The marker's `viewBox` fitted into its box.
 *
 * @param {MarkerSpec} spec
 * @returns {Matrix2D}
 */
function markerViewport(spec) {
  return viewportMatrix(spec.viewBox, spec.aspect, spec.width, spec.height);
}

/**
 * The matrix from a marker's user space to the user space of the path it
 * is drawn on, for one vertex.
 *
 * @param {MarkerSpec} spec
 * @param {MarkerVertex} vertex
 * @param {number} strokeWidth The path's.
 * @returns {Matrix2D}
 */
export function markerMatrix(spec, vertex, strokeWidth) {
  return multiply(markerFrame(spec, vertex, strokeWidth), markerViewport(spec));
}

/**
 * The id a `marker-start`, `marker-mid` or `marker-end` names, or null for
 * `none`. A computed value is `url("#id")`, an attribute `url(#id)`.
 *
 * @param {string} value
 * @returns {string | null}
 */
export function parseMarkerReference(value) {
  const match = /^url\(\s*(["']?)(.*)\1\s*\)$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const hash = match[2].lastIndexOf("#");
  return hash >= 0 && hash < match[2].length - 1 ? match[2].slice(hash + 1) : null;
}

/**
 * The `<marker>` an id names in the element's document, or null for one
 * that is missing or is something other than a marker.
 *
 * @param {Element} element
 * @param {string | null} id
 * @returns {Element | null}
 */
export function findMarker(element, id) {
  if (!id) {
    return null;
  }
  const found = element.ownerDocument.getElementById(id);
  return found && found.localName === "marker" && found.namespaceURI === SVG_NAMESPACE
    ? found
    : null;
}
