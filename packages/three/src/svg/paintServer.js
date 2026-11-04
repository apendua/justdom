import * as THREE from "three";
import { colorAt } from "../elements/gradient.js";
import { getAttributeCached, getChildNodes, getComputedStyleCached } from "../elements/mirror.js";
import { findSvgElement } from "../elements/plugins.js";
import { matrixEqual, parseTransformList } from "./geometry.js";
import {
  paintEqual,
  parseNumber,
  parsePaint,
  parseUrlReference,
  readProperty,
  splitPaintServer,
} from "./style.js";

/**
 * A `fill` or `stroke` as what draws it: a flat colour, or the paint server
 * a `url(#…)` names. Only the gradients are servers here so far; a pattern,
 * or a reference to nothing a server can be, draws its fallback colour, or
 * nothing without one, as a browser draws a server it cannot use.
 *
 * A gradient is read as SVG defines it:
 *
 * - Any attribute it does not set, and its stops when it has none, come
 *   from the gradient its `href` (or `xlink:href`) names, and so on down the
 *   chain. A linear gradient takes `x1` to `y2` only from a linear one, a
 *   radial one `cx` to `fr` only from a radial one; the rest from either. A
 *   chain that comes back on itself ends where it would repeat.
 * - Its coordinates are in `gradientUnits`: fractions of the shape's fill
 *   bounding box (`objectBoundingBox`, the default), or the user space the
 *   shape is drawn in (`userSpaceOnUse`), where a percentage is of the
 *   viewport. `gradientTransform` applies after them.
 * - A stop's `offset` is a number or a percentage, clamped to between 0 and
 *   1 and to no less than the offset before it. Its colour and opacity are
 *   its computed `stop-color` and `stop-opacity`.
 *
 * Every read goes through the mirror's cached reads, so a stop recoloured by
 * a stylesheet or an attribute animated on the gradient reaches the drawing,
 * and a restyle that leaves the server as it was is equal to it
 * (`paintServerEqual`) and rebuilds nothing.
 */

/** @typedef {import('./style.js').Paint} Paint */
/** @typedef {import('./geometry.js').Matrix2D} Matrix2D */
/** @typedef {import('../elements/gradient.js').ResolvedRamp} ResolvedRamp */

/** How a gradient carries on past its ends, as the shader numbers it. */
export const SPREAD_PAD = 0;
export const SPREAD_REFLECT = 1;
export const SPREAD_REPEAT = 2;

/**
 * @typedef {object} ColorServer
 * @property {"color"} kind
 * @property {Paint} paint
 */

/**
 * A gradient, resolved against everything but the shape's bounding box.
 *
 * @typedef {object} GradientServer
 * @property {"linear" | "radial"} kind
 * @property {boolean} objectBox Whether the coordinates are fractions of
 *   the shape's fill bounding box (`objectBoundingBox`).
 * @property {Matrix2D | null} transform `gradientTransform`, from gradient
 *   space to the units' space.
 * @property {0 | 1 | 2} spread `SPREAD_PAD`, `SPREAD_REFLECT` or
 *   `SPREAD_REPEAT`.
 * @property {number[]} coords Linear: `x1 y1 x2 y2`. Radial: `cx cy r fx fy
 *   fr`.
 * @property {ResolvedRamp} ramp The stops, in straight alpha.
 */

/** @typedef {ColorServer | GradientServer} PaintServer */

const GRADIENT_TAGS = new Set(["linearGradient", "radialGradient"]);

/** The longest `href` chain followed. A longer one is surely a mistake. */
const MAX_CHAIN = 32;

/**
 * What draws a `fill` or `stroke`, or null for nothing.
 *
 * @param {Element} element The shape, against whose document the reference
 *   is resolved.
 * @param {string} value The property's value, as drawn (`readDrawnProperty`).
 * @param {() => { width: number, height: number } | null} viewport The
 *   viewport a `userSpaceOnUse` percentage is of. Read only for one, a
 *   default included.
 * @returns {PaintServer | null}
 */
export function readPaintServer(element, value, viewport) {
  const split = splitPaintServer(value);
  if (split) {
    const id = parseUrlReference(split.reference);
    const server = id ? findSvgElement(element, id) : null;
    if (server && GRADIENT_TAGS.has(server.localName)) {
      return readGradient(server, viewport);
    }
  }
  const paint = parsePaint(value);
  return paint ? { kind: "color", paint } : null;
}

/**
 * The gradient elements `gradient` inherits from, itself first.
 *
 * @param {Element} gradient
 * @returns {Element[]}
 */
function hrefChain(gradient) {
  /** @type {Element[]} */
  const chain = [];
  /** @type {Element | null} */
  let at = gradient;
  while (at && GRADIENT_TAGS.has(at.localName) && !chain.includes(at) && chain.length < MAX_CHAIN) {
    chain.push(at);
    /** @type {string} */
    const href = getAttributeCached(at, "href") ?? getAttributeCached(at, "xlink:href") ?? "";
    at = href.startsWith("#") && href.length > 1 ? findSvgElement(at, href.slice(1)) : null;
  }
  return chain;
}

/**
 * The first value of `name` along the chain, from an element whose tag is
 * one of `tags` (any gradient when null).
 *
 * @param {Element[]} chain
 * @param {string} name
 * @param {string | null} tag
 * @returns {string | null}
 */
function inherited(chain, name, tag = null) {
  for (const element of chain) {
    if (tag !== null && element.localName !== tag) {
      continue;
    }
    const value = getAttributeCached(element, name);
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

/**
 * A gradient, or null for one with no stops, which paints nothing. One with
 * no extent, a linear one whose vector has no length or a radial one with
 * no radius, paints its last stop's colour all over, as SVG says.
 *
 * @param {Element} gradient
 * @param {() => { width: number, height: number } | null} viewport
 * @returns {PaintServer | null}
 */
function readGradient(gradient, viewport) {
  const chain = hrefChain(gradient);
  const kind = gradient.localName === "linearGradient" ? "linear" : "radial";
  const objectBox = inherited(chain, "gradientUnits") !== "userSpaceOnUse";
  const transform = parseTransformList(inherited(chain, "gradientTransform"));
  const spreadValue = inherited(chain, "spreadMethod");
  const spread =
    spreadValue === "reflect"
      ? SPREAD_REFLECT
      : spreadValue === "repeat"
        ? SPREAD_REPEAT
        : SPREAD_PAD;

  /** @type {Record<"width" | "height" | "diagonal", () => number | undefined>} */
  const reference = {
    width: () => viewport()?.width,
    height: () => viewport()?.height,
    diagonal: () => {
      const size = viewport();
      return size ? Math.hypot(size.width, size.height) / Math.SQRT2 : undefined;
    },
  };
  /**
   * A coordinate along the chain, or its default when no gradient of the
   * kind sets it or the value does not parse, as SVG treats an invalid
   * attribute as unspecified. The default is read only when it is used, so
   * a coordinate the gradient gives in numbers reads no viewport.
   *
   * @param {string} name
   * @param {string | number} fallback A default to read in the units, or
   *   one already read.
   * @param {"width" | "height" | "diagonal"} axis
   * @returns {number}
   */
  const coord = (name, fallback, axis) => {
    const value = inherited(chain, name, gradient.localName);
    return (
      (value === null ? null : readCoordinate(value.trim(), objectBox, reference[axis])) ??
      (typeof fallback === "number"
        ? fallback
        : readCoordinate(fallback, objectBox, reference[axis])) ??
      0
    );
  };

  /** @type {number[]} */
  let coords;
  if (kind === "linear") {
    coords = [
      coord("x1", "0%", "width"),
      coord("y1", "0%", "height"),
      coord("x2", "100%", "width"),
      coord("y2", "0%", "height"),
    ];
  } else {
    const cx = coord("cx", "50%", "width");
    const cy = coord("cy", "50%", "height");
    coords = [
      cx,
      cy,
      coord("r", "50%", "diagonal"),
      coord("fx", cx, "width"),
      coord("fy", cy, "height"),
      coord("fr", "0%", "diagonal"),
    ];
  }

  const ramp = readStops(chain);
  if (!ramp) {
    return null;
  }
  const flat =
    kind === "linear" ? coords[0] === coords[2] && coords[1] === coords[3] : !(coords[2] > 0);
  if (flat) {
    const [r, g, b, alpha] = colorAt(ramp, 1);
    return {
      kind: "color",
      paint: { color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace), alpha },
    };
  }
  return { kind, objectBox, transform, spread, coords, ramp };
}

/**
 * One coordinate in the gradient's units, or null for one that does not
 * parse. Under `objectBoundingBox` a percentage is a fraction and a number
 * is one already; under `userSpaceOnUse` a percentage is of the viewport.
 *
 * @param {string} value
 * @param {boolean} objectBox
 * @param {() => number | undefined} reference
 * @returns {number | null}
 */
function readCoordinate(value, objectBox, reference) {
  const percent = value.endsWith("%");
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  if (!percent) {
    return number;
  }
  if (objectBox) {
    return number / 100;
  }
  const base = reference();
  return base === undefined ? null : (base * number) / 100;
}

/**
 * The stops of the first gradient along the chain that has any, as a ramp,
 * or null for none.
 *
 * @param {Element[]} chain
 * @returns {ResolvedRamp | null}
 */
function readStops(chain) {
  for (const element of chain) {
    const stops = getChildNodes(element).filter(
      (node) =>
        node.nodeType === Node.ELEMENT_NODE && /** @type {Element} */ (node).localName === "stop",
    );
    if (stops.length === 0) {
      continue;
    }
    /** @type {ResolvedRamp["stops"]} */
    const resolved = [];
    let floor = 0;
    for (const node of stops) {
      const stop = /** @type {Element} */ (node);
      const style = getComputedStyleCached(stop);
      const offsetText = (getAttributeCached(stop, "offset") ?? "0").trim();
      let offset = Number.parseFloat(offsetText);
      if (!Number.isFinite(offset)) {
        offset = 0;
      } else if (offsetText.endsWith("%")) {
        offset /= 100;
      }
      floor = Math.max(floor, Math.min(Math.max(offset, 0), 1));
      resolved.push({ color: stopColor(stop, style), position: floor });
    }
    return {
      repeating: false,
      start: 0,
      period: 1,
      stops: resolved,
      hints: resolved.map(() => null),
      straight: true,
    };
  }
  return null;
}

const SRGB = new THREE.Color();

/**
 * A stop's colour in sRGB channels with its opacity folded into the alpha.
 *
 * @param {Element} stop
 * @param {CSSStyleDeclaration} style
 * @returns {[number, number, number, number]}
 */
function stopColor(stop, style) {
  let value = readProperty(style, stop, "stop-color").trim() || "black";
  if (value.toLowerCase() === "currentcolor") {
    value = style.color || "black";
  }
  const paint = parsePaint(value) ?? { color: new THREE.Color(0, 0, 0), alpha: 1 };
  paint.color.getRGB(SRGB, THREE.SRGBColorSpace);
  const opacity = Math.min(
    Math.max(parseNumber(readProperty(style, stop, "stop-opacity"), 1), 0),
    1,
  );
  return [SRGB.r, SRGB.g, SRGB.b, paint.alpha * opacity];
}

/**
 * @param {PaintServer | null} a
 * @param {PaintServer | null} b
 * @returns {boolean}
 */
export function paintServerEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "color") {
    return paintEqual(a.paint, /** @type {ColorServer} */ (b).paint);
  }
  const other = /** @type {GradientServer} */ (b);
  return (
    a.objectBox === other.objectBox &&
    a.spread === other.spread &&
    (a.transform === other.transform ||
      (!!a.transform && !!other.transform && matrixEqual(a.transform, other.transform))) &&
    a.coords.length === other.coords.length &&
    a.coords.every((value, i) => value === other.coords[i]) &&
    rampEqual(a.ramp, other.ramp)
  );
}

/**
 * @param {ResolvedRamp} a
 * @param {ResolvedRamp} b
 * @returns {boolean}
 */
function rampEqual(a, b) {
  return (
    a.stops.length === b.stops.length &&
    a.stops.every(
      (stop, i) =>
        stop.position === b.stops[i].position &&
        stop.color.every((channel, c) => channel === b.stops[i].color[c]),
    )
  );
}
