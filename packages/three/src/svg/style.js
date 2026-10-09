import * as THREE from "three";
import { parseColor } from "../elements/VisualProperties.js";
import { getAttributeCached } from "../elements/mirror.js";
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
  return getAttributeCached(element, name) ?? "";
}

/**
 * The id a `url()` reference names, as `marker-start`, `marker-mid`,
 * `marker-end` and `clip-path` name one, or null for `none` and anything
 * else. A computed value is `url("#id")`, an attribute `url(#id)`.
 *
 * @param {string} value
 * @returns {string | null}
 */
export function parseUrlReference(value) {
  const match = /^url\(\s*(["']?)(.*)\1\s*\)$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const hash = match[2].lastIndexOf("#");
  return hash >= 0 && hash < match[2].length - 1 ? match[2].slice(hash + 1) : null;
}

/**
 * A length in user units. `px` and unitless are the same thing in user
 * space; a percentage would need the viewport to resolve against and reads
 * as the fallback here (`parseLengthIn` is the reader that has a viewport);
 * `auto`, `none` and nothing at all read as the fallback too.
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
 * A length in user units that may be a percentage of `reference`: the
 * viewport's width or height, or for a length on neither axis its diagonal
 * over root two (`viewportReferences`). Anything else reads as `parseLength`
 * reads it.
 *
 * @param {string} value
 * @param {number | undefined | (() => number | undefined)} reference What
 *   100% is, or undefined when there is no viewport to measure against,
 *   which reads a percentage as the fallback. A function is called only for
 *   a percentage, so a length that is none reads no viewport.
 * @param {number} [fallback]
 * @returns {number}
 */
export function parseLengthIn(value, reference, fallback = 0) {
  const trimmed = value.trim();
  if (!trimmed.endsWith("%")) {
    return parseLength(trimmed, fallback);
  }
  const base = typeof reference === "function" ? reference() : reference;
  const percent = Number.parseFloat(trimmed);
  return base !== undefined && Number.isFinite(percent) ? (base * percent) / 100 : fallback;
}

/**
 * What a percentage length is of: the viewport's width for a length along x,
 * its height along y, and for one along neither, such as a circle's `r` or a
 * `stroke-width`, its diagonal over root two, as SVG defines it.
 *
 * @typedef {"width" | "height" | "diagonal"} ViewportAxis
 */

/**
 * The three references a percentage can be of, for `parseLengthIn`, over a
 * viewport read at most once, on the first percentage that asks for it.
 *
 * @param {() => { width: number, height: number } | null} viewport
 * @returns {Record<ViewportAxis, () => number | undefined>} Each undefined
 *   with no viewport.
 */
export function viewportReferences(viewport) {
  /** @type {{ width: number, height: number } | null | undefined} */
  let size;
  const read = () => {
    if (size === undefined) {
      size = viewport();
    }
    return size;
  };
  return {
    width: () => read()?.width,
    height: () => read()?.height,
    diagonal: () => {
      const current = read();
      return current ? Math.hypot(current.width, current.height) / Math.SQRT2 : undefined;
    },
  };
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
 * Whether a viewport's `overflow` clips its content: a nested `<svg>`, a
 * `<symbol>` or a `<marker>`, all `hidden` by the browser's own stylesheet.
 * Not the mirror's `clipsOverflow`, because in SVG `auto` means `visible`.
 *
 * @param {string} value Computed `overflow`.
 * @returns {boolean}
 */
export function clipsViewport(value) {
  const first = value.trim().split(/\s+/)[0];
  return first === "hidden" || first === "scroll" || first === "clip";
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
 * @param {() => number | undefined} [reference] What a percentage dash is
 *   of, the viewport's diagonal over root two; without one a percentage
 *   reads as no dash.
 * @returns {number[] | null}
 */
export function parseDashArray(value, reference) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none") {
    return null;
  }
  const values = trimmed.split(/[\s,]+/).map((part) => parseLengthIn(part, reference, Number.NaN));
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
 * `<path>`'s `d` as `path("…")` — and from the attribute otherwise. Both
 * reads are dependencies of the computation this runs in: the portal
 * observes every attribute, and a write to one invalidates the element's
 * computed style and its cached attribute reads alike.
 *
 * A percentage, which the computed style keeps as one, is a share of the
 * viewport the shape is in. The viewport is read once, and only for a length
 * that is a percentage, so a shape with none does not depend on its size.
 *
 * @param {CSSStyleDeclaration} style
 * @param {Element} element
 * @param {() => { width: number, height: number } | null} viewport The
 *   viewport the shape is in, `viewportSize` in `shape.js`.
 * @returns {string | null}
 */
export function readShapeMarkup(style, element, viewport) {
  const of = viewportReferences(viewport);
  /**
   * @param {string} name
   * @param {ViewportAxis} axis What a percentage of it is of.
   * @param {number} [fallback]
   */
  const length = (name, axis, fallback = 0) =>
    parseLengthIn(readProperty(style, element, name), of[axis], fallback);
  /**
   * @param {Record<string, number | string>} attributes
   */
  const tag = (attributes) =>
    `<${element.localName}${Object.entries(attributes)
      .map(([name, value]) => ` ${name}="${escapeAttribute(String(value))}"`)
      .join("")}/>`;

  switch (element.localName) {
    case "rect": {
      const width = length("width", "width");
      const height = length("height", "height");
      if (width <= 0 || height <= 0) {
        return null;
      }
      // `auto` on one radius means "the other one"; on both, square corners.
      let rx = length("rx", "width", Number.NaN);
      let ry = length("ry", "height", Number.NaN);
      if (Number.isNaN(rx) && Number.isNaN(ry)) {
        rx = 0;
        ry = 0;
      } else if (Number.isNaN(rx)) {
        rx = ry;
      } else if (Number.isNaN(ry)) {
        ry = rx;
      }
      return tag({ x: length("x", "width"), y: length("y", "height"), width, height, rx, ry });
    }
    case "circle": {
      const r = length("r", "diagonal");
      if (r <= 0) {
        return null;
      }
      return tag({ cx: length("cx", "width"), cy: length("cy", "height"), r });
    }
    case "ellipse": {
      let rx = length("rx", "width", Number.NaN);
      let ry = length("ry", "height", Number.NaN);
      if (Number.isNaN(rx)) {
        rx = ry;
      }
      if (Number.isNaN(ry)) {
        ry = rx;
      }
      if (!(rx > 0) || !(ry > 0)) {
        return null;
      }
      return tag({ cx: length("cx", "width"), cy: length("cy", "height"), rx, ry });
    }
    case "line": {
      return tag({
        x1: length("x1", "width"),
        y1: length("y1", "height"),
        x2: length("x2", "width"),
        y2: length("y2", "height"),
      });
    }
    case "polyline":
    case "polygon": {
      const points = readProperty(style, element, "points").trim();
      return points ? tag({ points }) : null;
    }
    case "path": {
      const computed = style.getPropertyValue("d").trim();
      const match = /^path\((["'])([\s\S]*)\1\)$/.exec(computed);
      const d = (match ? match[2] : (getAttributeCached(element, "d") ?? "")).trim();
      return d ? tag({ d }) : null;
    }
    default:
      return null;
  }
}
