import * as THREE from "three";
import { colorAt } from "../elements/gradient.js";
import { getAttributeCached, getChildNodes, getComputedStyleCached } from "../elements/mirror.js";
import { serializePatternContent } from "./patternTile.js";
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
 * a `url(#…)` names, a gradient or a pattern. A reference to nothing a
 * server can be draws its fallback colour, or nothing without one, as a
 * browser draws a server it cannot use.
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
 * A pattern is read the same way, `href` lending attributes from any
 * pattern and the content of the first along the chain that has any. Its
 * tile, `x y width height`, is in `patternUnits` (`objectBoundingBox` by
 * default), its content in `patternContentUnits` (`userSpaceOnUse` by
 * default) unless it has a `viewBox`, and `patternTransform` applies after
 * them. A tile with no width or no height, or no content, paints nothing.
 * The content is kept as markup (`serializePatternContent`), drawn into a
 * picture of one tile where the shape is drawn (`svg/patternTile.js`).
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

/**
 * A pattern, resolved against everything but the shape's bounding box.
 *
 * @typedef {object} PatternServer
 * @property {"pattern"} kind
 * @property {boolean} objectBox Whether the tile is in fractions of the
 *   shape's fill bounding box (`patternUnits="objectBoundingBox"`).
 * @property {boolean} contentObjectBox Whether the content is in fractions
 *   of it (`patternContentUnits`), which a `viewBox` overrides.
 * @property {string | null} viewBox
 * @property {string | null} preserveAspectRatio
 * @property {Matrix2D | null} transform `patternTransform`.
 * @property {number[]} tile `x y width height`, in the tile's units.
 * @property {string} content The content's markup.
 * @property {Paint | null} fallback The colour the paint names after the
 *   reference, drawn while the tile is on its way or when it fails.
 */

/** @typedef {ColorServer | GradientServer | PatternServer} PaintServer */

const GRADIENT_TAGS = new Set(["linearGradient", "radialGradient"]);
const PATTERN_TAGS = new Set(["pattern"]);

/** The longest `href` chain followed. A longer one is surely a mistake. */
const MAX_CHAIN = 32;

/**
 * What draws a `fill` or `stroke`, or null for nothing.
 *
 * @param {Element} element The shape, against whose document the reference
 *   is resolved.
 * @param {string} value The property's value, as drawn (`readDrawnProperty`).
 * @param {() => { width: number, height: number } | null} viewport The
 *   viewport a `userSpaceOnUse` percentage is of. Read only for one.
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
    if (server && PATTERN_TAGS.has(server.localName)) {
      return readPattern(server, viewport, parsePaint(split.fallback));
    }
  }
  const paint = parsePaint(value);
  return paint ? { kind: "color", paint } : null;
}

/**
 * The servers `server` inherits from, itself first: the elements its
 * `href` chain names, for as long as each is one of `tags`.
 *
 * @param {Element} server
 * @param {Set<string>} tags
 * @returns {Element[]}
 */
function hrefChain(server, tags) {
  /** @type {Element[]} */
  const chain = [];
  /** @type {Element | null} */
  let at = server;
  while (at && tags.has(at.localName) && !chain.includes(at) && chain.length < MAX_CHAIN) {
    chain.push(at);
    /** @type {string} */
    const href = getAttributeCached(at, "href") ?? getAttributeCached(at, "xlink:href") ?? "";
    at = href.startsWith("#") && href.length > 1 ? findSvgElement(at, href.slice(1)) : null;
  }
  return chain;
}

/**
 * The first value of `name` along the chain, from an element whose tag is
 * `tag` (any when null).
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
  const chain = hrefChain(gradient, GRADIENT_TAGS);
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

  const coord = coordinates(chain, gradient.localName, objectBox, viewport);

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
    const fx = inherited(chain, "fx", "radialGradient");
    const fy = inherited(chain, "fy", "radialGradient");
    coords = [
      cx,
      cy,
      coord("r", "50%", "diagonal"),
      fx === null ? cx : coord("fx", "50%", "width"),
      fy === null ? cy : coord("fy", "50%", "height"),
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
 * @typedef {(name: string, fallback: string, axis: "width" | "height" | "diagonal") => number} CoordinateReader
 */

/**
 * A reader of the server's coordinates along its chain, each in the
 * server's units, falling back to the default SVG gives it.
 *
 * @param {Element[]} chain
 * @param {string} tag The kind of server a coordinate is taken from.
 * @param {boolean} objectBox
 * @param {() => { width: number, height: number } | null} viewport
 * @returns {CoordinateReader}
 */
function coordinates(chain, tag, objectBox, viewport) {
  /** @type {Record<"width" | "height" | "diagonal", () => number | undefined>} */
  const reference = {
    width: () => viewport()?.width,
    height: () => viewport()?.height,
    diagonal: () => {
      const size = viewport();
      return size ? Math.hypot(size.width, size.height) / Math.SQRT2 : undefined;
    },
  };
  return (name, fallback, axis) => {
    const value = (inherited(chain, name, tag) ?? fallback).trim();
    const fallbackNumber = readCoordinate(fallback, objectBox, reference[axis]);
    return readCoordinate(value, objectBox, reference[axis]) ?? fallbackNumber ?? 0;
  };
}

/**
 * A pattern, or null for one that paints nothing: a tile with no width or
 * no height, or no content.
 *
 * @param {Element} pattern
 * @param {() => { width: number, height: number } | null} viewport
 * @param {Paint | null} fallback
 * @returns {PatternServer | null}
 */
function readPattern(pattern, viewport, fallback) {
  const chain = hrefChain(pattern, PATTERN_TAGS);
  const objectBox = inherited(chain, "patternUnits") !== "userSpaceOnUse";
  const coord = coordinates(chain, "pattern", objectBox, viewport);
  const tile = [
    coord("x", "0", "width"),
    coord("y", "0", "height"),
    coord("width", "0", "width"),
    coord("height", "0", "height"),
  ];
  if (!(tile[2] > 0) || !(tile[3] > 0)) {
    return null;
  }
  const source = chain.find((element) =>
    getChildNodes(element).some((node) => node.nodeType === Node.ELEMENT_NODE),
  );
  const content = source ? serializePatternContent(source) : "";
  if (!content) {
    return null;
  }
  return {
    kind: "pattern",
    objectBox,
    contentObjectBox: inherited(chain, "patternContentUnits") === "objectBoundingBox",
    viewBox: inherited(chain, "viewBox"),
    preserveAspectRatio: inherited(chain, "preserveAspectRatio"),
    transform: parseTransformList(inherited(chain, "patternTransform")),
    tile,
    content,
    fallback,
  };
}

/**
 * One coordinate in the server's units, or null for one that does not
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
  if (a.kind === "pattern") {
    const other = /** @type {PatternServer} */ (b);
    return (
      a.objectBox === other.objectBox &&
      a.contentObjectBox === other.contentObjectBox &&
      a.viewBox === other.viewBox &&
      a.preserveAspectRatio === other.preserveAspectRatio &&
      transformEqual(a.transform, other.transform) &&
      numbersEqual(a.tile, other.tile) &&
      a.content === other.content &&
      paintEqual(a.fallback, other.fallback)
    );
  }
  const other = /** @type {GradientServer} */ (b);
  return (
    a.objectBox === other.objectBox &&
    a.spread === other.spread &&
    transformEqual(a.transform, other.transform) &&
    numbersEqual(a.coords, other.coords) &&
    rampEqual(a.ramp, other.ramp)
  );
}

/**
 * @param {Matrix2D | null} a
 * @param {Matrix2D | null} b
 * @returns {boolean}
 */
function transformEqual(a, b) {
  return a === b || (!!a && !!b && matrixEqual(a, b));
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {boolean}
 */
function numbersEqual(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
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
