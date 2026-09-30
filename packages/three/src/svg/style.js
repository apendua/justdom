import * as THREE from "three";
import { parseColor } from "../elements/VisualProperties.js";
import { normalizeDashArray } from "./dash.js";

/**
 * Reading an SVG element's styling and geometry off its computed style.
 *
 * Computed style, and not the attributes, is the source, because it is what
 * the page's stylesheets resolve to: a class swap, a `[data-xr-hover]` rule
 * on the button around an icon and a CSS keyframe on `stroke-dashoffset` all
 * land there and nowhere else. The attribute is the fallback, for the two
 * places the computed style is empty — a geometry property the browser does
 * not expose as CSS (`x1` on a `<line>`, `points` on a `<polygon>`), and a
 * test runner whose style engine knows none of these properties at all.
 */

/**
 * The computed value of a property, or the presentation attribute of the
 * same name when the computed style has nothing to say.
 *
 * @param {CSSStyleDeclaration} style
 * @param {Element} element
 * @param {string} name
 * @returns {string}
 */
export function readProperty(style, element, name) {
  const computed = style.getPropertyValue(name);
  if (computed !== "") {
    return computed;
  }
  return element.getAttribute(name) ?? "";
}

/**
 * A length in user units. `px` and unitless are the same thing in user
 * space; a percentage would need the viewport to resolve against and is
 * not followed (it reads as the fallback); `auto`, `none` and nothing at
 * all read as the fallback too.
 *
 * @param {string} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function parseLength(value, fallback = 0) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.endsWith("%")) {
    return fallback;
  }
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * @param {string} value
 * @param {number} fallback
 * @returns {number}
 */
export function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A `fill` or `stroke` as the colour to draw and the alpha to draw it with,
 * or null for nothing to draw: `none`, and — until gradients are drawn — a
 * `url(#…)` paint server.
 *
 * @typedef {object} Paint
 * @property {THREE.Color} color
 * @property {number} alpha
 */

/**
 * @param {string} value
 * @returns {Paint | null}
 */
export function parsePaint(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none" || trimmed.startsWith("url(")) {
    return null;
  }
  if (/^rgba?\(/.test(trimmed)) {
    // What a browser's computed style always is. Read as sRGB, the way every
    // other colour in a portal is.
    const [color, alpha] = parseColor(trimmed);
    return { color, alpha };
  }
  if (trimmed === "transparent") {
    return { color: new THREE.Color(0, 0, 0), alpha: 0 };
  }
  // A keyword or a hex value, which is what an attribute says and what a
  // style engine that does not resolve colours hands back.
  const color = new THREE.Color();
  color.setStyle(trimmed, THREE.SRGBColorSpace);
  return { color, alpha: 1 };
}

/**
 * @param {Paint | null} a
 * @param {Paint | null} b
 * @returns {boolean}
 */
export function paintEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.alpha === b.alpha && a.color.equals(b.color);
}

/**
 * Whether a `fill` or `stroke` paints anything, in the sense hit testing
 * uses. Any paint but `none` counts. A `url(#…)` paint server counts though
 * it is not drawn yet, and so does `transparent`, which is how a page makes
 * an invisible shape clickable.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isPainted(value) {
  const trimmed = value.trim();
  return trimmed !== "" && trimmed !== "none";
}

/**
 * When a ray can hit one of a shape's two regions, the fill or the stroke.
 *
 * @typedef {object} HitRule
 * @property {boolean} painted Only while the region's paint is not `none`.
 * @property {boolean} visible Only while `visibility` shows the shape.
 */

/**
 * What a shape's `pointer-events` lets a ray hit. Each region has a rule,
 * or null when no ray hits it.
 *
 * @typedef {object} HitRegions
 * @property {HitRule | null} fill
 * @property {HitRule | null} stroke
 */

/** @type {Record<string, HitRegions>} */
const HIT_REGIONS = (() => {
  const painted = { painted: true, visible: false };
  const visible = { painted: false, visible: true };
  const visiblePainted = { painted: true, visible: true };
  const always = { painted: false, visible: false };
  return {
    visiblePainted: { fill: visiblePainted, stroke: visiblePainted },
    visibleFill: { fill: visible, stroke: null },
    visibleStroke: { fill: null, stroke: visible },
    visible: { fill: visible, stroke: visible },
    painted: { fill: painted, stroke: painted },
    fill: { fill: always, stroke: null },
    stroke: { fill: null, stroke: always },
    all: { fill: always, stroke: always },
    none: { fill: null, stroke: null },
  };
})();

/**
 * `pointer-events` on a shape, as SVG defines it. `auto` and any value this
 * does not know, `bounding-box` among them, read as `visiblePainted`, the
 * initial value.
 *
 * @param {string} value
 * @returns {HitRegions}
 */
export function parsePointerEvents(value) {
  return Object.hasOwn(HIT_REGIONS, value.trim())
    ? HIT_REGIONS[value.trim()]
    : HIT_REGIONS.visiblePainted;
}

/**
 * @param {string} value
 * @returns {"nonzero" | "evenodd"}
 */
export function parseFillRule(value) {
  return value.trim() === "evenodd" ? "evenodd" : "nonzero";
}

/**
 * `stroke-dasharray`, as the pattern the dash cutter wants or null for a
 * solid line. Computed style spells it `4px, 2px`; an attribute `4 2` or
 * `4,2`; both are read.
 *
 * @param {string} value
 * @returns {number[] | null}
 */
export function parseDashArray(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none") {
    return null;
  }
  const values = trimmed.split(/[\s,]+/).map((part) => parseLength(part, Number.NaN));
  return normalizeDashArray(values);
}

/**
 * @param {string} value
 * @returns {"butt" | "round" | "square"}
 */
export function parseLineCap(value) {
  const trimmed = value.trim();
  return trimmed === "round" || trimmed === "square" ? trimmed : "butt";
}

/**
 * @param {string} value
 * @returns {"miter" | "round" | "bevel"}
 */
export function parseLineJoin(value) {
  const trimmed = value.trim();
  return trimmed === "round" || trimmed === "bevel" ? trimmed : "miter";
}

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
 * The shape's geometry as a one-element document for three's `SVGLoader` to
 * parse — its `d` parser, its arc handling and its rounded-rect
 * construction, without re-implementing any of them — or null for a shape
 * with nothing to draw. Nothing about the element's styling goes in; the
 * loader is handed geometry and nothing else, and the styling is read from
 * the live element by the code that draws it.
 *
 * Geometry comes from the computed style where the browser exposes it as
 * CSS — Chromium reports `cx`, `r`, `x`, `width` and the rest in px, and a
 * `<path>`'s `d` as `path("…")` — and from the attribute otherwise. Reading
 * the computed style first is also what makes the attribute reactive: the
 * style is invalidated by every attribute mutation on the element, and this
 * runs inside a computation that reads it.
 *
 * @param {CSSStyleDeclaration} style
 * @param {Element} element
 * @returns {string | null}
 */
export function readShapeMarkup(style, element) {
  /**
   * @param {string} name
   * @param {number} [fallback]
   */
  const length = (name, fallback = 0) => parseLength(readProperty(style, element, name), fallback);
  /**
   * @param {Record<string, number | string>} attributes
   */
  const tag = (attributes) =>
    `<${element.localName}${Object.entries(attributes)
      .map(([name, value]) => ` ${name}="${escapeAttribute(String(value))}"`)
      .join("")}/>`;

  switch (element.localName) {
    case "rect": {
      const width = length("width");
      const height = length("height");
      if (width <= 0 || height <= 0) {
        return null;
      }
      // `auto` on one radius means "the other one"; on both, square corners.
      let rx = length("rx", Number.NaN);
      let ry = length("ry", Number.NaN);
      if (Number.isNaN(rx) && Number.isNaN(ry)) {
        rx = 0;
        ry = 0;
      } else if (Number.isNaN(rx)) {
        rx = ry;
      } else if (Number.isNaN(ry)) {
        ry = rx;
      }
      return tag({ x: length("x"), y: length("y"), width, height, rx, ry });
    }
    case "circle": {
      const r = length("r");
      if (r <= 0) {
        return null;
      }
      return tag({ cx: length("cx"), cy: length("cy"), r });
    }
    case "ellipse": {
      let rx = length("rx", Number.NaN);
      let ry = length("ry", Number.NaN);
      if (Number.isNaN(rx)) {
        rx = ry;
      }
      if (Number.isNaN(ry)) {
        ry = rx;
      }
      if (!(rx > 0) || !(ry > 0)) {
        return null;
      }
      return tag({ cx: length("cx"), cy: length("cy"), rx, ry });
    }
    case "line": {
      return tag({ x1: length("x1"), y1: length("y1"), x2: length("x2"), y2: length("y2") });
    }
    case "polyline":
    case "polygon": {
      const points = readProperty(style, element, "points").trim();
      return points ? tag({ points }) : null;
    }
    case "path": {
      const computed = style.getPropertyValue("d").trim();
      const match = /^path\((["'])([\s\S]*)\1\)$/.exec(computed);
      const d = (match ? match[2] : (element.getAttribute("d") ?? "")).trim();
      return d ? tag({ d }) : null;
    }
    default:
      return null;
  }
}
