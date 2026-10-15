import * as THREE from "three";

/**
 * CSS gradients as a background layer, drawn by the same quad and shader as
 * the rest of a box.
 *
 * What a gradient costs is decided by where its description lives. Stops are
 * a list of any length, and a list has no place in a per-instance attribute:
 * a batched box has sixteen attribute slots to its name, and the box spends
 * all of them, counting the `normal` and `uv` three declares (see the comment
 * above `instancedVertex` in `boxBatch.js`). So the list is spent on the CPU
 * instead. Each distinct run of
 * stops is baked, once, into one row of a shared texture — the *ramp* — and
 * what a box carries is which row, plus the handful of numbers that say how
 * its pixels map onto that row: a direction for a linear gradient, a centre
 * and radii for a radial one, a centre and a starting angle for a conic one,
 * and the tile the whole image is laid out in. A box with a gradient is still
 * one instance in its panel's batch; nothing about it costs a draw call.
 *
 * The file is in three parts, each a stage the one after it depends on:
 *
 *   - **Parsing** turns the computed `background-*` strings into a
 *     description that does not depend on the element's size. It runs when
 *     the style changes and at no other time.
 *   - **Layout** resolves that description against a box — the tile from
 *     `background-size`, `-position`, `-repeat` and `-origin`, the gradient's
 *     geometry within the tile, and the stops' positions along it. It runs
 *     when the size does.
 *   - **The ramp atlas** turns resolved stops into texels and hands out rows.
 *     A row is keyed by what is in it, so fifty menu rows wearing one
 *     gradient share one row, and a resize that leaves percentage stops where
 *     they were bakes nothing.
 *
 * Conventions are the portal's: element px, origin at the top-left corner of
 * the border box, y running down.
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * A length-percentage as CSS computes it: some percentage of a reference
 * length plus some px. `calc(100% - 10px)` and `right 10px` both land here as
 * `{ percent: 100, px: -10 }`, which is what lets one resolver serve all of
 * them.
 *
 * @typedef {object} LengthPercentage
 * @property {number} percent
 * @property {number} px
 */

/**
 * A colour in sRGB channels, 0–1, straight (not premultiplied) alpha.
 *
 * @typedef {[number, number, number, number]} RGBA
 */

/**
 * One entry of a gradient's stop list before layout. A colour stop has a
 * colour and a position, or none yet; a hint is a position alone, and moves
 * the midpoint of the transition it sits in.
 *
 * @typedef {{ color: RGBA, position: LengthPercentage | null } | { color: null, position: LengthPercentage }} StopEntry
 */

/**
 * @typedef {"closest-side" | "farthest-side" | "closest-corner" | "farthest-corner"} RadialExtent
 */

/**
 * @typedef {object} LinearGradient
 * @property {"linear"} kind
 * @property {boolean} repeating
 * @property {StopEntry[]} stops
 * @property {number} angle In turns, CSS convention: 0 points up, clockwise.
 * @property {[number, number] | null} corner For `to top right` and the like,
 *   whose angle depends on the tile's shape: the x (-1 left, 1 right) and y
 *   (-1 top, 1 bottom) of the corner pointed at. `null` for an explicit angle
 *   or a side.
 */

/**
 * @typedef {object} RadialGradient
 * @property {"radial"} kind
 * @property {boolean} repeating
 * @property {StopEntry[]} stops
 * @property {"circle" | "ellipse"} shape
 * @property {RadialExtent | [LengthPercentage, LengthPercentage]} size For an
 *   explicit circle both lanes carry the one radius.
 * @property {{ x: LengthPercentage, y: LengthPercentage }} center
 */

/**
 * @typedef {object} ConicGradient
 * @property {"conic"} kind
 * @property {boolean} repeating
 * @property {StopEntry[]} stops Positions in `percent` only: an angle is read
 *   as the percentage of a turn it is, and a px position invalidates the
 *   gradient.
 * @property {number} from In turns.
 * @property {{ x: LengthPercentage, y: LengthPercentage }} center
 */

/**
 * @typedef {LinearGradient | RadialGradient | ConicGradient} Gradient
 */

/**
 * @typedef {"auto" | LengthPercentage} SizeComponent
 */

/**
 * @typedef {"repeat" | "no-repeat" | "round" | "space"} RepeatStyle
 */

/**
 * A gradient background layer: the image and the four properties that lay it
 * out. What `parseBackground` produces, and what depends on nothing but the
 * element's computed style.
 *
 * @typedef {object} Background
 * @property {Gradient} gradient
 * @property {"cover" | "contain" | [SizeComponent, SizeComponent]} size
 * @property {{ x: LengthPercentage, y: LengthPercentage }} position
 * @property {[RepeatStyle, RepeatStyle]} repeat
 * @property {"border-box" | "padding-box" | "content-box"} origin
 */

/**
 * The computed-style strings `parseBackground` reads. Each can hold a comma
 * separated list, one entry per layer; a list shorter than the image list
 * repeats, the way CSS says it does.
 *
 * @typedef {object} BackgroundStyle
 * @property {string} image
 * @property {string} [size]
 * @property {string} [positionX]
 * @property {string} [positionY]
 * @property {string} [position] The shorthand, for engines that do not
 *   compute the per-axis longhands. Only read when both of those are empty.
 * @property {string} [repeat]
 * @property {string} [origin]
 * @property {string} [currentColor] What `currentcolor` resolves to.
 */

const FULL = /** @type {LengthPercentage} */ ({ percent: 100, px: 0 });
const HALF = /** @type {LengthPercentage} */ ({ percent: 50, px: 0 });
const ZERO = /** @type {LengthPercentage} */ ({ percent: 0, px: 0 });

/**
 * Split on a separator that is not inside parentheses. Everything in a
 * computed background is nested — a gradient's colours are `rgb(…)` inside
 * `linear-gradient(…)` inside a comma separated list of layers — and every
 * level is split the same way.
 *
 * @param {string} value
 * @param {"," | " "} separator
 * @returns {string[]}
 */
export function splitTopLevel(value, separator) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (depth === 0 && (separator === " " ? /\s/.test(char) : char === separator)) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * The colours a gradient in a computed style can hold. Browsers compute every
 * colour they can to `rgb()`/`rgba()` — `transparent` included — so that is
 * the case that matters; hex and the handful of keywords below are for
 * engines that hand back what was authored, jsdom among them. A colour this
 * cannot read makes the gradient unreadable too, which leaves the box drawing
 * its background colour alone: what it did before gradients were drawn at
 * all.
 *
 * @type {Record<string, RGBA>}
 */
const NAMED_COLORS = {
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  white: [1, 1, 1, 1],
  red: [1, 0, 0, 1],
  lime: [0, 1, 0, 1],
  blue: [0, 0, 1, 1],
};

/**
 * @param {string} value
 * @param {string} [currentColor]
 * @returns {RGBA | null}
 */
export function parseCssColor(value, currentColor) {
  const text = value.trim().toLowerCase();
  if (text === "currentcolor") {
    return currentColor && currentColor.toLowerCase() !== "currentcolor"
      ? parseCssColor(currentColor)
      : null;
  }
  if (text in NAMED_COLORS) {
    return /** @type {RGBA} */ ([...NAMED_COLORS[text]]);
  }
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) {
      return null;
    }
    const digits =
      hex.length === 3 || hex.length === 4
        ? hex.split("").map((digit) => parseInt(digit + digit, 16))
        : hex.length === 6 || hex.length === 8
          ? (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16))
          : null;
    if (!digits) {
      return null;
    }
    return [digits[0] / 255, digits[1] / 255, digits[2] / 255, (digits[3] ?? 255) / 255];
  }
  const match = text.match(/^rgba?\((.*)\)$/);
  if (!match) {
    return null;
  }
  // Both syntaxes: `rgb(1, 2, 3, 0.5)` and `rgb(1 2 3 / 50%)`.
  const [channelText, alphaText] = match[1].includes("/")
    ? match[1].split("/")
    : [match[1], undefined];
  const channels = channelText
    .split(/[\s,]+/)
    .filter((part) => part.length > 0)
    .map((part) => (part.endsWith("%") ? (parseFloat(part) / 100) * 255 : parseFloat(part)));
  const alphaPart = alphaText ?? (channels.length === 4 ? String(channels.pop()) : "1");
  const alpha = alphaPart.trim().endsWith("%")
    ? parseFloat(alphaPart) / 100
    : parseFloat(alphaPart);
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    return null;
  }
  if (!Number.isFinite(alpha)) {
    return null;
  }
  const clamp = (/** @type {number} */ x) => Math.min(Math.max(x, 0), 1);
  return [
    clamp(channels[0] / 255),
    clamp(channels[1] / 255),
    clamp(channels[2] / 255),
    clamp(alpha),
  ];
}

/**
 * A length-percentage, or `null` for anything else. Computed values arrive in
 * px and %, and anything mixing the two as a `calc()` of a sum of them — which
 * is as far as this goes, and as far as a computed position needs to.
 *
 * @param {string} value
 * @returns {LengthPercentage | null}
 */
export function parseLengthPercentage(value) {
  const text = value.trim().toLowerCase();
  const calc = text.match(/^calc\((.*)\)$/);
  if (calc) {
    // A sum of terms: `100% - 10px`, `50% + -4px`. The operators want spaces
    // around them in CSS, which is what makes this split safe.
    const tokens = calc[1].split(/\s+/).filter((token) => token.length > 0);
    const result = { percent: 0, px: 0 };
    let sign = 1;
    for (const token of tokens) {
      if (token === "+") {
        sign = 1;
        continue;
      }
      if (token === "-") {
        sign = -1;
        continue;
      }
      const term = parseLengthPercentage(token);
      if (!term) {
        return null;
      }
      result.percent += sign * term.percent;
      result.px += sign * term.px;
      sign = 1;
    }
    return result;
  }
  const match = text.match(/^(-?[\d.]+(?:e-?\d+)?)(px|%)?$/);
  if (!match) {
    return null;
  }
  const number = parseFloat(match[1]);
  if (!Number.isFinite(number)) {
    return null;
  }
  if (match[2] === "%") {
    return { percent: number, px: 0 };
  }
  // A bare number is only a length when it is zero.
  if (match[2] === undefined && number !== 0) {
    return null;
  }
  return { percent: 0, px: number };
}

/**
 * @param {string} value
 * @returns {number | null} In turns.
 */
export function parseAngle(value) {
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(-?[\d.]+(?:e-?\d+)?)(deg|turn|rad|grad)?$/);
  if (!match) {
    return null;
  }
  const number = parseFloat(match[1]);
  if (!Number.isFinite(number)) {
    return null;
  }
  switch (match[2]) {
    case "deg":
      return number / 360;
    case "turn":
      return number;
    case "rad":
      return number / (2 * Math.PI);
    case "grad":
      return number / 400;
    default:
      // A unitless angle is only an angle when it is zero.
      return number === 0 ? 0 : null;
  }
}

/**
 * `<position>`, in one to four tokens, as `background-position` and a
 * gradient's `at …` both write it. Keywords become percentages; an offset
 * after an edge keyword counts from that edge, so `right 10px` is
 * `calc(100% - 10px)`.
 *
 * @param {string[]} tokens
 * @returns {{ x: LengthPercentage, y: LengthPercentage } | null}
 */
export function parsePosition(tokens) {
  /** @type {Record<string, LengthPercentage>} */
  const edges = { left: ZERO, top: ZERO, center: HALF, right: FULL, bottom: FULL };
  const words = tokens.map((token) => token.toLowerCase());
  const horizontal = (/** @type {string} */ word) => word === "left" || word === "right";
  const vertical = (/** @type {string} */ word) => word === "top" || word === "bottom";

  if (words.length === 1) {
    const [word] = words;
    if (vertical(word)) {
      return { x: HALF, y: edges[word] };
    }
    const x = edges[word] ?? parseLengthPercentage(word);
    return x ? { x, y: HALF } : null;
  }
  if (words.length === 2) {
    let [first, second] = words;
    // Keywords can come in either order; a length cannot.
    if (vertical(first) || horizontal(second)) {
      [first, second] = [second, first];
    }
    if (vertical(first) || horizontal(second)) {
      return null;
    }
    const x = edges[first] ?? parseLengthPercentage(first);
    const y = edges[second] ?? parseLengthPercentage(second);
    return x && y ? { x, y } : null;
  }
  // Three or four tokens: edge keywords, each optionally followed by an
  // offset from that edge.
  /** @type {{ x: LengthPercentage | null, y: LengthPercentage | null }} */
  const result = { x: null, y: null };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!(word in edges)) {
      return null;
    }
    const next = words[i + 1];
    const offset = next !== undefined && !(next in edges) ? parseLengthPercentage(next) : null;
    if (offset) {
      i += 1;
    }
    /** @type {LengthPercentage} */
    let value = edges[word];
    if (offset && word !== "center") {
      value =
        word === "right" || word === "bottom"
          ? { percent: 100 - offset.percent, px: -offset.px }
          : offset;
    }
    const axis = horizontal(word) ? "x" : vertical(word) ? "y" : result.x ? "y" : "x";
    if (result[axis]) {
      return null;
    }
    result[axis] = value;
  }
  return { x: result.x ?? HALF, y: result.y ?? HALF };
}

/**
 * The stop list of a gradient: every argument after the one that says how it
 * is shaped. Double-position stops (`red 10% 20%`) become the two stops they
 * abbreviate.
 *
 * @param {string[]} parts
 * @param {"length" | "angle"} positions
 * @param {string} [currentColor]
 * @returns {StopEntry[] | null}
 */
function parseStops(parts, positions, currentColor) {
  /** @type {StopEntry[]} */
  const stops = [];
  for (const part of parts) {
    const tokens = splitTopLevel(part, " ");
    /** @type {LengthPercentage[]} */
    const places = [];
    /** @type {RGBA | null} */
    let color = null;
    for (const token of tokens) {
      const place = positions === "angle" ? anglePosition(token) : parseLengthPercentage(token);
      if (place) {
        places.push(place);
        continue;
      }
      if (color) {
        return null;
      }
      color = parseCssColor(token, currentColor);
      if (!color) {
        return null;
      }
    }
    if (!color) {
      // A hint: a position alone, between two colour stops.
      if (places.length !== 1) {
        return null;
      }
      stops.push({ color: null, position: places[0] });
      continue;
    }
    if (places.length > 2) {
      return null;
    }
    if (places.length === 0) {
      stops.push({ color, position: null });
    }
    for (const place of places) {
      stops.push({ color, position: place });
    }
  }
  const colors = stops.filter((stop) => stop.color);
  if (colors.length === 0) {
    return null;
  }
  // A hint has to sit between two colour stops.
  for (let i = 0; i < stops.length; i++) {
    if (
      !stops[i].color &&
      (i === 0 || i === stops.length - 1 || !stops[i - 1].color || !stops[i + 1].color)
    ) {
      return null;
    }
  }
  return stops;
}

/**
 * A conic stop's position: an angle, read as the percentage of a turn it is,
 * or a percentage. Length positions have no meaning around a point.
 *
 * @param {string} token
 * @returns {LengthPercentage | null}
 */
function anglePosition(token) {
  const turns = parseAngle(token);
  if (turns !== null && /[a-z]$/i.test(token.trim())) {
    return { percent: turns * 100, px: 0 };
  }
  const value = parseLengthPercentage(token);
  if (value && value.px === 0) {
    return value;
  }
  // `0` is both, and both mean the same thing.
  return turns === 0 ? { percent: 0, px: 0 } : null;
}

/**
 * The part of a prelude that says which colour space to interpolate in. Read
 * past rather than honoured: the ramp is interpolated in sRGB whatever the
 * gradient asked for, which is the CSS default for gradients written with
 * legacy colours — every gradient in this repository — and a close
 * approximation otherwise.
 *
 * @param {string[]} words
 * @returns {string[]}
 */
function withoutInterpolation(words) {
  const at = words.indexOf("in");
  if (at < 0) {
    return words;
  }
  // `in <space> [<hue-method> hue]`
  let end = at + 2;
  if (words[end + 1] === "hue") {
    end += 2;
  }
  return [...words.slice(0, at), ...words.slice(end)];
}

/**
 * One `*-gradient(…)` function, or `null` if it is not one this can draw.
 *
 * @param {string} value
 * @param {string} [currentColor]
 * @returns {Gradient | null}
 */
export function parseGradient(value, currentColor) {
  const match = value.trim().match(/^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/i);
  if (!match) {
    return null;
  }
  const repeating = Boolean(match[1]);
  const kind = /** @type {"linear" | "radial" | "conic"} */ (match[2].toLowerCase());
  const parts = splitTopLevel(match[3], ",");
  if (parts.length === 0) {
    return null;
  }
  const first = withoutInterpolation(splitTopLevel(parts[0].toLowerCase(), " "));
  // Whether the first argument describes the shape or is already a stop.
  const firstIsStop = parseStops([parts[0]], kind === "conic" ? "angle" : "length", currentColor);
  const prelude = firstIsStop ? [] : first;
  const stopParts = firstIsStop ? parts : parts.slice(1);
  const stops = parseStops(stopParts, kind === "conic" ? "angle" : "length", currentColor);
  if (!stops) {
    return null;
  }

  if (kind === "linear") {
    /** @type {LinearGradient} */
    const gradient = { kind, repeating, stops, angle: 0.5, corner: null };
    if (prelude.length === 0) {
      return gradient;
    }
    if (prelude[0] === "to") {
      const sides = prelude.slice(1);
      let x = 0;
      let y = 0;
      for (const side of sides) {
        if (side === "left" && x === 0) x = -1;
        else if (side === "right" && x === 0) x = 1;
        else if (side === "top" && y === 0) y = -1;
        else if (side === "bottom" && y === 0) y = 1;
        else return null;
      }
      if (sides.length === 1) {
        // A side is an angle that does not depend on the box.
        gradient.angle = x === 1 ? 0.25 : x === -1 ? 0.75 : y === -1 ? 0 : 0.5;
      } else if (sides.length === 2 && x !== 0 && y !== 0) {
        gradient.corner = [x, y];
      } else {
        return null;
      }
      return gradient;
    }
    if (prelude.length !== 1) {
      return null;
    }
    const angle = parseAngle(prelude[0]);
    if (angle === null) {
      return null;
    }
    gradient.angle = angle;
    return gradient;
  }

  const at = prelude.indexOf("at");
  const shapeWords = at < 0 ? prelude : prelude.slice(0, at);
  const center = at < 0 ? { x: HALF, y: HALF } : parsePosition(prelude.slice(at + 1));
  if (!center) {
    return null;
  }

  if (kind === "conic") {
    let from = 0;
    if (shapeWords.length > 0) {
      if (shapeWords.length !== 2 || shapeWords[0] !== "from") {
        return null;
      }
      const angle = parseAngle(shapeWords[1]);
      if (angle === null) {
        return null;
      }
      from = angle;
    }
    return { kind, repeating, stops, from, center };
  }

  /** @type {"circle" | "ellipse" | null} */
  let shape = null;
  /** @type {RadialExtent | null} */
  let extent = null;
  /** @type {LengthPercentage[]} */
  const lengths = [];
  for (const word of shapeWords) {
    if (word === "circle" || word === "ellipse") {
      if (shape) return null;
      shape = word;
    } else if (
      word === "closest-side" ||
      word === "farthest-side" ||
      word === "closest-corner" ||
      word === "farthest-corner"
    ) {
      if (extent || lengths.length) return null;
      extent = word;
    } else {
      const length = parseLengthPercentage(word);
      if (!length || extent) return null;
      lengths.push(length);
    }
  }
  if (lengths.length > 2) {
    return null;
  }
  // One length is a circle's radius; two are an ellipse's.
  const resolvedShape = shape ?? (lengths.length === 1 ? "circle" : "ellipse");
  if (resolvedShape === "circle" && (lengths.length > 1 || lengths.some((l) => l.percent !== 0))) {
    return null;
  }
  if (resolvedShape === "ellipse" && lengths.length === 1) {
    return null;
  }
  /** @type {RadialGradient["size"]} */
  const size =
    lengths.length === 0 ? (extent ?? "farthest-corner") : [lengths[0], lengths[1] ?? lengths[0]];
  return { kind, repeating, stops, shape: resolvedShape, size, center };
}

/**
 * @param {string} value One layer's `background-size`.
 * @returns {Background["size"] | null}
 */
function parseSizeLayer(value) {
  const words = splitTopLevel(value.toLowerCase(), " ");
  if (words.length === 1 && (words[0] === "cover" || words[0] === "contain")) {
    return words[0];
  }
  if (words.length < 1 || words.length > 2) {
    return null;
  }
  /** @type {SizeComponent[]} */
  const components = [];
  for (const word of words) {
    const component = word === "auto" ? "auto" : parseLengthPercentage(word);
    if (!component) {
      return null;
    }
    components.push(component);
  }
  return [components[0], components[1] ?? "auto"];
}

/**
 * @param {string} value One layer's `background-repeat`.
 * @returns {[RepeatStyle, RepeatStyle] | null}
 */
function parseRepeatLayer(value) {
  const words = splitTopLevel(value.toLowerCase(), " ");
  /** @param {string} word @returns {word is RepeatStyle} */
  const isStyle = (word) =>
    word === "repeat" || word === "no-repeat" || word === "round" || word === "space";
  if (words.length === 1) {
    if (words[0] === "repeat-x") return ["repeat", "no-repeat"];
    if (words[0] === "repeat-y") return ["no-repeat", "repeat"];
    if (isStyle(words[0])) return [words[0], words[0]];
    return null;
  }
  if (words.length === 2 && isStyle(words[0]) && isStyle(words[1])) {
    return [words[0], words[1]];
  }
  return null;
}

/**
 * The layer-`index` entry of a comma separated list, cycling a short list the
 * way CSS does, or `fallback` when the list is empty.
 *
 * @param {string | undefined} list
 * @param {number} index
 * @param {string} fallback
 * @returns {string}
 */
function layerOf(list, index, fallback) {
  const layers = list ? splitTopLevel(list, ",") : [];
  return layers.length === 0 ? fallback : layers[index % layers.length];
}

/**
 * The background layer to draw, or `null` if there is no gradient among the
 * element's background images.
 *
 * One layer, and the topmost gradient of them: an instance has room for one
 * set of gradient numbers, and a background that stacks several is drawn as
 * its uppermost gradient over its background colour.
 *
 * @param {BackgroundStyle} style
 * @returns {Background | null}
 */
export function parseBackground(style) {
  if (!style.image || style.image === "none") {
    return null;
  }
  const images = splitTopLevel(style.image, ",");
  for (let index = 0; index < images.length; index++) {
    const gradient = parseGradient(images[index], style.currentColor);
    if (!gradient) {
      continue;
    }
    const size = parseSizeLayer(layerOf(style.size, index, "auto"));
    const repeat = parseRepeatLayer(layerOf(style.repeat, index, "repeat"));
    const originWord = layerOf(style.origin, index, "padding-box").toLowerCase();
    const origin =
      originWord === "border-box" || originWord === "content-box" ? originWord : "padding-box";
    // The per-axis longhands where the engine computes them — they are what
    // keeps `right 10px` intact — and the shorthand where it does not.
    const x =
      style.positionX || style.positionY
        ? axisPosition(layerOf(style.positionX, index, "0%"), "x")
        : null;
    const y =
      style.positionX || style.positionY
        ? axisPosition(layerOf(style.positionY, index, "0%"), "y")
        : null;
    const position =
      x && y
        ? { x, y }
        : parsePosition(splitTopLevel(layerOf(style.position, index, "0% 0%"), " "));
    if (!size || !repeat || !position) {
      return null;
    }
    return { gradient, size, position, repeat, origin };
  }
  return null;
}

/**
 * One axis of `background-position-x`/`-y`: a length-percentage, an edge
 * keyword, or an edge keyword and an offset from it.
 *
 * @param {string} value
 * @param {"x" | "y"} axis
 * @returns {LengthPercentage | null}
 */
function axisPosition(value, axis) {
  const words = splitTopLevel(value.toLowerCase(), " ");
  const near = axis === "x" ? "left" : "top";
  const far = axis === "x" ? "right" : "bottom";
  if (words.length === 1) {
    if (words[0] === near) return ZERO;
    if (words[0] === "center") return HALF;
    if (words[0] === far) return FULL;
    return parseLengthPercentage(words[0]);
  }
  if (words.length === 2) {
    const offset = parseLengthPercentage(words[1]);
    if (!offset) return null;
    if (words[0] === near) return offset;
    if (words[0] === far) return { percent: 100 - offset.percent, px: -offset.px };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The edges a background is laid out between: the element's size and its
 * border and padding widths, in px.
 *
 * @typedef {object} BackgroundBox
 * @property {number} width
 * @property {number} height
 * @property {[number, number, number, number]} border Top, right, bottom, left.
 * @property {[number, number, number, number]} padding Top, right, bottom, left.
 */

/** @typedef {0 | 1 | 2 | 3} GradientKind None, linear, radial, conic. */

export const GRADIENT_NONE = 0;
export const GRADIENT_LINEAR = 1;
export const GRADIENT_RADIAL = 2;
export const GRADIENT_CONIC = 3;

/**
 * A run of stops laid out along a gradient's own line, as fractions of it, and
 * ready to bake. For a repeating gradient `start` and `period` are the part of
 * the line one repetition covers; for any other they are 0 and 1.
 *
 * @typedef {object} ResolvedRamp
 * @property {boolean} repeating
 * @property {number} start
 * @property {number} period
 * @property {{ color: RGBA, position: number }[]} stops
 * @property {(number | null)[]} hints `hints[i]` is the hint between stop `i`
 *   and stop `i + 1`, if there is one.
 */

/**
 * Everything the shader needs to draw one element's gradient layer, in the
 * lanes it wants them in.
 *
 * - `geometry` — linear: the gradient's direction scaled to one period per
 *   unit, and the offset that puts the line's midpoint at the tile's centre;
 *   radial: centre and radii; conic: centre, starting angle in turns, and
 *   periods per turn.
 * - `tile` — where one tile of the image sits, in element px: left, top,
 *   width, height.
 *
 * @typedef {object} GradientLayout
 * @property {GradientKind} kind
 * @property {boolean} repeating
 * @property {boolean} repeatX
 * @property {boolean} repeatY
 * @property {[number, number, number, number]} geometry
 * @property {[number, number, number, number]} tile
 * @property {ResolvedRamp} ramp
 * @property {string} rampKey What is in the ramp, as a string. Two layouts
 *   with the same key bake the same texels.
 */

/**
 * @param {LengthPercentage} value
 * @param {number} reference
 * @returns {number}
 */
function resolve(value, reference) {
  return (value.percent / 100) * reference + value.px;
}

/**
 * The tile a background image is drawn in: the positioning area that
 * `background-origin` picks, a size from `background-size`, adjusted by
 * `round`, and placed by `background-position`.
 *
 * A gradient has no size of its own, so `auto`, `cover` and `contain` all mean
 * the positioning area. `space` is drawn as `repeat`: the gaps it would put
 * between tiles need two more numbers than an instance has room for.
 *
 * @param {Background} background
 * @param {BackgroundBox} box
 * @returns {[number, number, number, number] | null}
 */
function layoutTile(background, box) {
  const [bt, br, bb, bl] = box.border;
  const [pt, pr, pb, pl] = box.padding;
  let left = 0;
  let top = 0;
  let width = box.width;
  let height = box.height;
  if (background.origin !== "border-box") {
    left += bl;
    top += bt;
    width -= bl + br;
    height -= bt + bb;
  }
  if (background.origin === "content-box") {
    left += pl;
    top += pt;
    width -= pl + pr;
    height -= pt + pb;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }
  let tileWidth = width;
  let tileHeight = height;
  const size = background.size;
  const autoWidth = typeof size === "string" || size[0] === "auto";
  const autoHeight = typeof size === "string" || size[1] === "auto";
  if (typeof size !== "string") {
    if (size[0] !== "auto") tileWidth = resolve(size[0], width);
    if (size[1] !== "auto") tileHeight = resolve(size[1], height);
  }
  if (tileWidth <= 0 || tileHeight <= 0) {
    return null;
  }
  const [repeatX, repeatY] = background.repeat;
  if (repeatX === "round") {
    const rounded = width / Math.max(1, Math.round(width / tileWidth));
    if (repeatY !== "round" && autoHeight) {
      tileHeight *= rounded / tileWidth;
    }
    tileWidth = rounded;
  }
  if (repeatY === "round") {
    const rounded = height / Math.max(1, Math.round(height / tileHeight));
    if (repeatX !== "round" && autoWidth) {
      tileWidth *= rounded / tileHeight;
    }
    tileHeight = rounded;
  }
  const x = left + resolve(background.position.x, width - tileWidth);
  const y = top + resolve(background.position.y, height - tileHeight);
  return [x, y, tileWidth, tileHeight];
}

/**
 * Stop positions as fractions of the gradient line, fixed up the way CSS
 * fixes them: an unplaced first and last stop go to the ends, a stop placed
 * before one already met moves up to it, and runs of unplaced stops share the
 * space between their placed neighbours evenly.
 *
 * @param {StopEntry[]} entries
 * @param {number} length The gradient line's length in px, which is what a px
 *   position is a fraction of.
 * @returns {{ stops: { color: RGBA, position: number }[], hints: (number | null)[] }}
 */
export function resolveStops(entries, length) {
  const fraction = (/** @type {LengthPercentage} */ place) =>
    place.percent / 100 + (length > 0 ? place.px / length : 0);

  /** @type {{ color: RGBA, position: number | null }[]} */
  const stops = [];
  /** @type {(number | null)[]} */
  const hints = [];
  for (const entry of entries) {
    if (entry.color) {
      stops.push({
        color: entry.color,
        position: entry.position ? fraction(entry.position) : null,
      });
      hints.push(null);
    } else {
      hints[stops.length - 1] = fraction(entry.position);
    }
  }
  if (stops[0].position === null) {
    stops[0].position = 0;
  }
  const last = stops[stops.length - 1];
  if (last.position === null) {
    last.position = stops.length === 1 ? 0 : 1;
  }
  let highest = -Infinity;
  for (let i = 0; i < stops.length; i++) {
    const position = stops[i].position;
    if (position !== null) {
      highest = Math.max(highest, position);
      stops[i].position = highest;
    }
    // A hint is clamped between its two stops once both are known, below.
  }
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].position !== null) {
      continue;
    }
    let j = i;
    while (stops[j].position === null) {
      j += 1;
    }
    const before = /** @type {number} */ (stops[i - 1].position);
    const after = /** @type {number} */ (stops[j].position);
    for (let k = i; k < j; k++) {
      stops[k].position = before + ((after - before) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
  const placed = /** @type {{ color: RGBA, position: number }[]} */ (stops);
  hints.length = Math.max(placed.length - 1, 0);
  for (let i = 0; i < hints.length; i++) {
    const hint = hints[i];
    if (hint !== null && hint !== undefined) {
      hints[i] = Math.min(Math.max(hint, placed[i].position), placed[i + 1].position);
    } else {
      hints[i] = null;
    }
  }
  return { stops: placed, hints };
}

/**
 * The part of a gradient line one repetition covers, and the ramp for it.
 *
 * A repeating gradient whose stops all sit at one point has no period to
 * repeat. CSS draws it as a solid colour, the average of the gradient it
 * would have been with its stops spread out; that is what this bakes.
 *
 * @param {Gradient} gradient
 * @param {number} length
 * @returns {ResolvedRamp}
 */
function resolveRamp(gradient, length) {
  const { stops, hints } = resolveStops(gradient.stops, length);
  if (!gradient.repeating) {
    return { repeating: false, start: 0, period: 1, stops, hints };
  }
  const start = stops[0].position;
  const period = stops[stops.length - 1].position - start;
  if (period > 1e-6) {
    return { repeating: true, start, period, stops, hints };
  }
  const spread = stops.map((stop, i) => ({
    color: stop.color,
    position: stops.length === 1 ? 0 : i / (stops.length - 1),
  }));
  const average = averageColor({ repeating: false, start: 0, period: 1, stops: spread, hints });
  return {
    repeating: false,
    start: 0,
    period: 1,
    stops: [{ color: average, position: 0 }],
    hints: [],
  };
}

/**
 * The gradient layer of an element, laid out against its box, or `null` when
 * there is nothing to draw — no gradient, or a tile with no area.
 *
 * @param {Background | null} background
 * @param {BackgroundBox} box
 * @returns {GradientLayout | null}
 */
export function layoutGradient(background, box) {
  if (!background) {
    return null;
  }
  const tile = layoutTile(background, box);
  if (!tile) {
    return null;
  }
  const [, , width, height] = tile;
  const { gradient } = background;
  const repeatX = background.repeat[0] !== "no-repeat";
  const repeatY = background.repeat[1] !== "no-repeat";

  if (gradient.kind === "linear") {
    let dx;
    let dy;
    if (gradient.corner) {
      // Pointing into a corner means the gradient's midline runs through the
      // other two, which is a direction the tile's shape decides.
      const [cx, cy] = gradient.corner;
      const norm = Math.hypot(width, height);
      dx = (cx * height) / norm;
      dy = (cy * width) / norm;
    } else {
      const radians = gradient.angle * 2 * Math.PI;
      dx = Math.sin(radians);
      dy = -Math.cos(radians);
    }
    const length = Math.abs(width * dx) + Math.abs(height * dy);
    const ramp = resolveRamp(gradient, length);
    // t = dot(q - centre, d) / length + 0.5, then one period per unit.
    const gx = dx / length / ramp.period;
    const gy = dy / length / ramp.period;
    const gz = (0.5 - ((width / 2) * dx + (height / 2) * dy) / length) / ramp.period;
    return finish(GRADIENT_LINEAR, [gx, gy, gz, 0], ramp);
  }

  const cx = resolve(gradient.center.x, width);
  const cy = resolve(gradient.center.y, height);

  if (gradient.kind === "conic") {
    const ramp = resolveRamp(gradient, 0);
    return finish(GRADIENT_CONIC, [cx, cy, gradient.from, 1 / ramp.period], ramp);
  }

  const [rx, ry] = radialRadii(gradient, cx, cy, width, height);
  const ramp = resolveRamp(gradient, rx);
  return finish(GRADIENT_RADIAL, [cx, cy, rx * ramp.period, ry * ramp.period], ramp);

  /**
   * @param {GradientKind} kind
   * @param {[number, number, number, number]} geometry
   * @param {ResolvedRamp} ramp
   * @returns {GradientLayout}
   */
  function finish(kind, geometry, ramp) {
    return {
      kind,
      repeating: ramp.repeating,
      repeatX,
      repeatY,
      geometry,
      tile: /** @type {[number, number, number, number]} */ (tile),
      ramp,
      rampKey: rampKeyOf(ramp),
    };
  }
}

/**
 * A radial gradient's ending shape, as its horizontal and vertical radii.
 *
 * A zero radius is kept just above zero: the shader divides by it, and a
 * vanishing shape draws its last colour everywhere, which is what CSS does
 * with one too.
 *
 * @param {RadialGradient} gradient
 * @param {number} cx
 * @param {number} cy
 * @param {number} width
 * @param {number} height
 * @returns {[number, number]}
 */
function radialRadii(gradient, cx, cy, width, height) {
  const floor = 1e-3;
  const { size, shape } = gradient;
  if (typeof size !== "string") {
    const rx = resolve(size[0], width);
    const ry = shape === "circle" ? rx : resolve(size[1], height);
    return [Math.max(rx, floor), Math.max(ry, floor)];
  }
  const sideX = [Math.abs(cx), Math.abs(width - cx)];
  const sideY = [Math.abs(cy), Math.abs(height - cy)];
  const closest = size.startsWith("closest");
  const pick = closest ? Math.min : Math.max;
  const sideRx = pick(sideX[0], sideX[1]);
  const sideRy = pick(sideY[0], sideY[1]);
  if (size.endsWith("side")) {
    if (shape === "circle") {
      const r = pick(sideRx, sideRy);
      return [Math.max(r, floor), Math.max(r, floor)];
    }
    return [Math.max(sideRx, floor), Math.max(sideRy, floor)];
  }
  // A corner: whichever one is nearest or farthest from the centre.
  let cornerX = sideX[0];
  let cornerY = sideY[0];
  let best = closest ? Infinity : -Infinity;
  for (const x of sideX) {
    for (const y of sideY) {
      const distance = Math.hypot(x, y);
      if (closest ? distance < best : distance > best) {
        best = distance;
        cornerX = x;
        cornerY = y;
      }
    }
  }
  if (shape === "circle") {
    return [Math.max(best, floor), Math.max(best, floor)];
  }
  // An ellipse through that corner with the aspect ratio the matching `side`
  // extent would have had.
  if (sideRy <= floor || sideRx <= floor) {
    return [Math.max(sideRx, floor), Math.max(sideRy, floor)];
  }
  const ratio = sideRx / sideRy;
  const ry = Math.sqrt((cornerX * cornerX) / (ratio * ratio) + cornerY * cornerY);
  return [Math.max(ry * ratio, floor), Math.max(ry, floor)];
}

// ---------------------------------------------------------------------------
// The ramp
// ---------------------------------------------------------------------------

/**
 * Texels per ramp row. Enough that a hard stop blurs over a fraction of a
 * pixel on anything but a large, non-repeating gradient, and small enough
 * that a row costs a kilobyte.
 */
export const RAMP_WIDTH = 256;

/**
 * @param {ResolvedRamp} ramp
 * @returns {string}
 */
function rampKeyOf(ramp) {
  const round = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
  let key = ramp.repeating ? `r${round(ramp.start)}/${round(ramp.period)}` : "n";
  for (let i = 0; i < ramp.stops.length; i++) {
    const { color, position } = ramp.stops[i];
    key += `|${round(position)}:${color.map(round).join(",")}`;
    const hint = ramp.hints[i];
    if (hint !== null && hint !== undefined) {
      key += `~${round(hint)}`;
    }
  }
  return key;
}

/**
 * The colour at a point of the gradient line, interpolated the way CSS does
 * it: between the two stops around it, in premultiplied sRGB, bent toward a
 * hint if the transition has one. Past either end it holds the end's colour.
 *
 * @param {ResolvedRamp} ramp
 * @param {number} t
 * @returns {RGBA}
 */
export function colorAt(ramp, t) {
  const { stops, hints } = ramp;
  // Strictly before: at the first stop's own position a second stop sharing
  // it has to be allowed to win, below.
  if (t < stops[0].position) {
    return stops[0].color;
  }
  const last = stops[stops.length - 1];
  if (t >= last.position) {
    return last.color;
  }
  // The last stop at or before `t`: where two stops share a position the
  // later one wins, which is what makes a hard stop hard.
  let i = 0;
  while (i < stops.length - 2 && stops[i + 1].position <= t) {
    i += 1;
  }
  const a = stops[i];
  const b = stops[i + 1];
  const span = b.position - a.position;
  let weight = span > 0 ? (t - a.position) / span : 1;
  const hint = hints[i];
  if (hint !== null && hint !== undefined && span > 0) {
    const h = (hint - a.position) / span;
    weight = h <= 0 ? 1 : h >= 1 ? 0 : Math.pow(weight, Math.log(0.5) / Math.log(h));
  }
  const alpha = a.color[3] + (b.color[3] - a.color[3]) * weight;
  if (alpha <= 0) {
    return [0, 0, 0, 0];
  }
  /** @type {RGBA} */
  const color = [0, 0, 0, alpha];
  for (let c = 0; c < 3; c++) {
    const premultiplied =
      a.color[c] * a.color[3] + (b.color[c] * b.color[3] - a.color[c] * a.color[3]) * weight;
    color[c] = premultiplied / alpha;
  }
  return color;
}

/**
 * @param {ResolvedRamp} ramp
 * @returns {RGBA}
 */
function averageColor(ramp) {
  const samples = 256;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < samples; i++) {
    const color = colorAt(ramp, (i + 0.5) / samples);
    r += color[0] * color[3];
    g += color[1] * color[3];
    b += color[2] * color[3];
    a += color[3];
  }
  return a > 0 ? [r / a, g / a, b / a, a / samples] : [0, 0, 0, 0];
}

/**
 * One row of texels: straight-alpha sRGB bytes, texel `i` standing for
 * `i / (RAMP_WIDTH - 1)` of the way along what the shader looks up.
 *
 * For a repeating gradient that lookup is `fract(t / period)` — the shader
 * divides by the period and wraps, and has no lane left to subtract where the
 * period starts. So the start is baked in here instead, as a phase: texel `y`
 * holds the colour at the point of the line whose `fract(t / period)` is `y`.
 * One consequence is that the seam where a repetition ends and the next
 * begins can land between two texels rather than on the row's ends, where it
 * is blurred over one texel like any other hard stop.
 *
 * @param {ResolvedRamp} ramp
 * @param {Uint8Array} [target]
 * @param {number} [offset]
 * @returns {Uint8Array}
 */
export function bakeRamp(ramp, target = new Uint8Array(RAMP_WIDTH * 4), offset = 0) {
  const phase = ramp.repeating
    ? ramp.start / ramp.period - Math.floor(ramp.start / ramp.period)
    : 0;
  for (let i = 0; i < RAMP_WIDTH; i++) {
    const y = i / (RAMP_WIDTH - 1);
    let t = y;
    if (ramp.repeating) {
      let f = y - phase;
      f -= Math.floor(f);
      // The very end of the row is the end of a repetition, not the start of
      // the next.
      if (f === 0 && y > 0) {
        f = 1;
      }
      t = ramp.start + ramp.period * f;
    }
    const color = colorAt(ramp, t);
    const at = offset + i * 4;
    target[at] = Math.round(color[0] * 255);
    target[at + 1] = Math.round(color[1] * 255);
    target[at + 2] = Math.round(color[2] * 255);
    target[at + 3] = Math.round(color[3] * 255);
  }
  return target;
}

// ---------------------------------------------------------------------------
// The atlas
// ---------------------------------------------------------------------------

/**
 * The ramp texture and its height in rows, as uniforms every box material in
 * the page shares by reference. Growing the atlas replaces the texture; with
 * the uniform objects shared, every material sees the new one on its next
 * draw without anybody having to find them.
 *
 * `uRamp` starts out `null`, which three binds as its own empty texture — so a
 * page that never draws a gradient never allocates one.
 */
export const rampUniforms = {
  uRamp: { value: /** @type {THREE.DataTexture | null} */ (null) },
  uRampHeight: { value: 1 },
};

const INITIAL_ROWS = 16;

/**
 * One texture for the page, a row per distinct ramp, rows counted by how many
 * boxes are using them.
 *
 * The page rather than the panel because rows are shared by content, and
 * content is shared across panels as often as within one; and because a
 * texture per panel would mean a second binding for any panel that has an
 * `<img>` among its boxes. A row that nobody uses any more is only marked
 * free: its texels stay until another ramp needs the room, since clearing
 * them would be an upload for nothing.
 */
class RampAtlas {
  /** @type {Map<string, { row: number, users: number }>} */
  #rows = new Map();
  /** @type {number[]} */
  #free = [];
  #height = 0;
  /** @type {Uint8Array} */
  #data = new Uint8Array(0);

  /**
   * @param {string} key
   * @param {ResolvedRamp} ramp
   * @returns {number} The row.
   */
  acquire(key, ramp) {
    const existing = this.#rows.get(key);
    if (existing) {
      existing.users += 1;
      return existing.row;
    }
    if (this.#free.length === 0) {
      this.#grow();
    }
    const row = /** @type {number} */ (this.#free.pop());
    this.#rows.set(key, { row, users: 1 });
    bakeRamp(ramp, this.#data, row * RAMP_WIDTH * 4);
    const texture = rampUniforms.uRamp.value;
    if (texture) {
      texture.needsUpdate = true;
    }
    return row;
  }

  /**
   * @param {string} key
   * @returns {void}
   */
  release(key) {
    const entry = this.#rows.get(key);
    if (!entry) {
      return;
    }
    entry.users -= 1;
    if (entry.users <= 0) {
      this.#rows.delete(key);
      this.#free.push(entry.row);
    }
  }

  /** How many rows are in use, for tests and diagnostics. */
  get size() {
    return this.#rows.size;
  }

  /**
   * Double the rows. The rows already handed out keep their numbers — which
   * is why a box holds a row and not a texture coordinate, and why the height
   * is a uniform of its own.
   */
  #grow() {
    const height = Math.max(INITIAL_ROWS, this.#height * 2);
    const data = new Uint8Array(RAMP_WIDTH * height * 4);
    data.set(this.#data);
    // Handed out lowest first, so a page with a few gradients keeps them at
    // the bottom of the texture.
    for (let row = height - 1; row >= this.#height; row--) {
      this.#free.push(row);
    }
    this.#height = height;
    this.#data = data;
    const texture = new THREE.DataTexture(data, RAMP_WIDTH, height, THREE.RGBAFormat);
    // The bytes are sRGB, as CSS colours are, and deliberately not declared
    // so: the shader composites the layer in sRGB, as CSS does, and wants the
    // bytes as they are — and filtering between texels then interpolates in
    // sRGB too, which is what a gradient's stops ask for. See
    // `GRADIENT_GLSL`.
    texture.colorSpace = THREE.NoColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    rampUniforms.uRamp.value?.dispose();
    rampUniforms.uRamp.value = texture;
    rampUniforms.uRampHeight.value = height;
  }
}

export const rampAtlas = new RampAtlas();

/**
 * One box's hold on a ramp row. Setting a layout whose ramp is the one
 * already held is free — which is every write of a box whose gradient did not
 * change, a resize with percentage stops included — and setting a different
 * one takes the new row before letting go of the old, so a box moving between
 * two gradients that share nothing never frees a row it is about to want.
 */
export class RampSlot {
  /** @type {string | null} */
  #key = null;
  row = 0;

  /**
   * @param {GradientLayout | null} layout
   * @returns {number} The row, or 0 when there is no layout.
   */
  set(layout) {
    const key = layout ? layout.rampKey : null;
    if (key === this.#key) {
      return this.row;
    }
    const row = layout ? rampAtlas.acquire(layout.rampKey, layout.ramp) : 0;
    this.release();
    this.#key = key;
    this.row = row;
    return row;
  }

  /**
   * @returns {void}
   */
  release() {
    if (this.#key !== null) {
      rampAtlas.release(this.#key);
    }
    this.#key = null;
    this.row = 0;
  }
}
