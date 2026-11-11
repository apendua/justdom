import { acquireImage, releaseImage } from "../elements/controls/image.js";
import {
  getAttributeCached,
  getAttributeNamesCached,
  getChildNodes,
  getComputedStyleCached,
  getTextDataCached,
} from "../elements/mirror/styleReads.js";
import { findSvgElement } from "../elements/plugins.js";
import { invert, matrixScale, multiply } from "./geometry.js";
import { parseUrlReference, readProperty } from "./style.js";

/**
 * A `<pattern>` drawn as a picture of one tile, repeated by the shader.
 *
 * The tile's content is written out as a standalone `<svg>` the size of one
 * tile at the pixel density it is drawn at, and decoded as an image through
 * the texture cache an `<img>` uses (`acquireImage`), keyed by that markup
 * as a `data:` URL. The cache shares one tile between every shape that asks
 * for the same markup at the same size, counts its holders, and disposes
 * of it as it disposes of any picture.
 *
 * The markup carries each element's computed presentation properties inline,
 * so a stylesheet rule or `currentColor` inside the pattern survives the
 * trip out of the document, and copies in every element the content names
 * by `url(#…)` or `href="#…"`, transitively: a gradient inside the pattern,
 * a `<symbol>` a `<use>` draws. It is read through the mirror's cached
 * reads, so an edit inside the pattern makes new markup and a new tile.
 *
 * A tile is a picture, so text in it is drawn in the fonts the image
 * decoder has rather than the page's web fonts, an `<image>` in it draws
 * only from a `data:` URL, and an animation in it is drawn as it stood when
 * the markup was last read.
 *
 * The shape holds its tile through a `TileHold`, which keeps the last tile
 * it drew until the next one is ready, so crossing a sampling rung while
 * zooming does not blink.
 */

/** @typedef {import('./geometry.js').Matrix2D} Matrix2D */
/** @typedef {import('./paintServer.js').PatternServer} PatternServer */
/** @typedef {import('../elements/controls/image.js').ImageEntry} ImageEntry */
/** @typedef {{ x: number, y: number, width: number, height: number }} Box */

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The properties written inline on each element of the content: the ones
 * that decide what an SVG element draws and that a stylesheet can set.
 */
const PRESENTATION = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "visibility",
  "display",
  "color",
  "stop-color",
  "stop-opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "transform",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "paint-order",
  "vector-effect",
];

/** Elements left out of the markup: nothing a picture would draw. */
const SKIPPED = new Set(["script", "style", "title", "desc", "metadata", "foreignObject"]);

/** A `url(#id)` anywhere in a value, or an `href` of `#id`. */
const REFERENCE = /url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g;

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
 * @param {string} value
 * @returns {string}
 */
function escapeText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The markup of a pattern's content: its child nodes, each element with
 * its attributes and its presentation properties inline, followed by a
 * `<defs>` holding whatever the content refers to outside itself. Empty for
 * content that draws nothing.
 *
 * @param {Element} source The pattern whose children are the content.
 * @returns {string}
 */
export function serializePatternContent(source) {
  /** @type {Set<Element>} */
  const written = new Set([source]);
  /** @type {Element[]} */
  const referenced = [];
  /** @param {string} id */
  const refer = (id) => {
    const target = findSvgElement(source, id);
    if (target && !written.has(target) && !referenced.includes(target)) {
      referenced.push(target);
    }
  };

  /**
   * @param {Node} node
   * @returns {string}
   */
  const write = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeText(getTextDataCached(/** @type {Text} */ (node)));
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }
    const element = /** @type {Element} */ (node);
    if (element.namespaceURI !== SVG_NS || SKIPPED.has(element.localName)) {
      return "";
    }
    written.add(element);
    const style = getComputedStyleCached(element);
    let markup = `<${element.localName}`;
    const names = getAttributeNamesCached(element);
    for (const name of names ? names.split(" ") : []) {
      if (name === "style") {
        continue;
      }
      const value = getAttributeCached(element, name) ?? "";
      if (name === "href" || name === "xlink:href") {
        if (value.startsWith("#")) {
          refer(value.slice(1));
        }
      }
      for (const match of value.matchAll(REFERENCE)) {
        const id = parseUrlReference(match[0]);
        if (id) {
          refer(id);
        }
      }
      markup += ` ${name}="${escapeAttribute(value)}"`;
    }
    /** @type {string[]} */
    const declarations = [];
    for (const property of PRESENTATION) {
      const value = readProperty(style, element, property).trim();
      if (value) {
        declarations.push(`${property}: ${value}`);
        for (const match of value.matchAll(REFERENCE)) {
          const id = parseUrlReference(match[0]);
          if (id) {
            refer(id);
          }
        }
      }
    }
    if (declarations.length > 0) {
      markup += ` style="${escapeAttribute(declarations.join("; "))}"`;
    }
    markup += ">";
    for (const child of getChildNodes(element)) {
      markup += write(child);
    }
    return `${markup}</${element.localName}>`;
  };

  let content = "";
  let draws = false;
  for (const child of getChildNodes(source)) {
    const part = write(child);
    draws ||= child.nodeType === Node.ELEMENT_NODE && part !== "";
    content += part;
  }
  if (!draws) {
    return "";
  }
  let defs = "";
  // Grows as it is walked: what a referenced element refers to is written
  // after it.
  for (let i = 0; i < referenced.length; i++) {
    // Written since it was referred to, in the content or inside an
    // element written before it: once is enough.
    if (!written.has(referenced[i])) {
      defs += write(referenced[i]);
    }
  }
  return defs ? `${content}<defs>${defs}</defs>` : content;
}

/** How many tile pixels per px the tile is drawn at, before the cap. */
const TILE_DENSITY = 2;

/** The longest side of a tile, in pixels. */
const MAX_TILE = 1024;

/**
 * Where a pattern's tile is on a shape, and the picture of it to draw.
 *
 * @typedef {object} PatternLayout
 * @property {Matrix2D} matrix From the shape's user space to tile space,
 *   where one tile spans 0 to 1 on each axis.
 * @property {string} url The tile's picture, as a `data:` URL.
 */

/**
 * Lay a pattern over a shape: the tile in user units, the matrix into it,
 * and the markup of one tile at the density the shape is drawn at. Null for
 * a pattern that draws nothing on this shape: one in `objectBoundingBox`
 * units over a box with no width or no height, or one whose
 * `patternTransform` cannot be inverted.
 *
 * @param {PatternServer} pattern
 * @param {() => Box | null} box The shape's fill bounding box, read only
 *   when the tile or the content is a share of it.
 * @param {number} scale How large the shape is drawn, per user unit
 *   (`samplingScale`), which decides how many pixels a tile gets.
 * @returns {PatternLayout | null}
 */
export function patternLayout(pattern, box, scale) {
  let [x, y, width, height] = pattern.tile;
  let content = pattern.content;
  if (pattern.objectBox || (pattern.contentObjectBox && pattern.viewBox === null)) {
    const bounds = box();
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) {
      return null;
    }
    if (pattern.objectBox) {
      x = bounds.x + x * bounds.width;
      y = bounds.y + y * bounds.height;
      width *= bounds.width;
      height *= bounds.height;
    }
    if (pattern.contentObjectBox && pattern.viewBox === null) {
      content = `<g transform="scale(${bounds.width} ${bounds.height})">${content}</g>`;
    }
  }
  /** @type {Matrix2D} */
  let matrix = [1 / width, 0, 0, 1 / height, -x / width, -y / height];
  let drawn = scale;
  if (pattern.transform) {
    const inverse = invert(pattern.transform);
    if (!inverse) {
      return null;
    }
    matrix = multiply(matrix, inverse);
    drawn *= matrixScale(pattern.transform);
  }
  const density = Math.min(drawn * TILE_DENSITY, MAX_TILE / width, MAX_TILE / height);
  const pixelWidth = Math.max(1, Math.round(width * density));
  const pixelHeight = Math.max(1, Math.round(height * density));
  const viewBox = pattern.viewBox ?? `0 0 ${width} ${height}`;
  const aspect =
    pattern.viewBox !== null && pattern.preserveAspectRatio !== null
      ? ` preserveAspectRatio="${escapeAttribute(pattern.preserveAspectRatio)}"`
      : "";
  const markup =
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink"` +
    ` width="${pixelWidth}" height="${pixelHeight}"` +
    ` viewBox="${escapeAttribute(viewBox)}"${aspect}>${content}</svg>`;
  return { matrix, url: `data:image/svg+xml,${encodeURIComponent(markup)}` };
}

/**
 * One shape region's hold on its tile pictures. It holds a share in at most
 * two: the one it wants, and the one it last drew, until the one it wants
 * is ready. The rules:
 *
 * - **Want.** Asking for a URL takes a share in it at once, which starts
 *   its load if no one else holds it. A share in what was wanted before is
 *   given back, unless it is the one still drawn.
 * - **Pending.** While the wanted tile loads, the tile last drawn is drawn,
 *   or none.
 * - **Ready.** When it lands, it is drawn, and the share in the tile drawn
 *   before is given back.
 * - **Failed.** A tile that fails draws none, and the tile drawn before is
 *   given back too: the shape draws its fallback, or nothing.
 * - **Released.** `release` gives back every share it holds. A tile still
 *   on its way is then the texture cache's to drop when it lands.
 *
 * Shares are taken before they are given back, so a shape going back and
 * forth between two tiles never lets the cache throw away one it is about
 * to want again.
 */
export class TileHold {
  /** @type {Map<string, ImageEntry>} */
  #held = new Map();
  /** @type {string | null} */
  #wanted = null;
  /** @type {string | null} */
  #shown = null;

  /**
   * Want the tile at `url`, or none, and say which texture to draw. Reads
   * the tiles' load states, so a computation that calls it runs again when
   * the wanted one lands.
   *
   * @param {string | null} url
   * @returns {import('three').Texture | null}
   */
  texture(url) {
    const before = this.#wanted === null ? null : this.#held.get(this.#wanted);
    if (url !== this.#wanted && before?.state.peek().status === "loaded") {
      // Landed since it was last asked about: it is the one last drawn.
      this.#shown = this.#wanted;
    }
    this.#wanted = url;
    this.#keep();
    if (url === null) {
      this.#shown = null;
      this.#keep();
      return null;
    }
    const state = /** @type {ImageEntry} */ (this.#held.get(url)).state.get();
    if (state.status === "loaded") {
      this.#shown = url;
      this.#keep();
      return state.texture;
    }
    if (state.status === "error") {
      this.#shown = null;
      this.#keep();
      return null;
    }
    const shown = this.#shown === null ? null : this.#held.get(this.#shown);
    return shown?.state.get().texture ?? null;
  }

  /**
   * @returns {void}
   */
  release() {
    this.#wanted = null;
    this.#shown = null;
    this.#keep();
  }

  /**
   * Hold a share in exactly the tiles wanted and shown: take the missing
   * ones first, then give back the rest.
   */
  #keep() {
    for (const url of [this.#wanted, this.#shown]) {
      if (url !== null && !this.#held.has(url)) {
        this.#held.set(url, acquireImage(url));
      }
    }
    for (const url of [...this.#held.keys()]) {
      if (url !== this.#wanted && url !== this.#shown) {
        this.#held.delete(url);
        releaseImage(url);
      }
    }
  }
}
