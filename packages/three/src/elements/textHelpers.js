import * as THREE from "three";
import { keepProgram } from "./programKeeper.js";

/**
 * @import {TextLine} from './textLines.js';
 * @import {ProgramKind} from './programKeeper.js';
 */

/**
 * @typedef {object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 */

/** The font size, in px, a style whose own cannot be read is drawn at. */
const DEFAULT_FONT_SIZE = 16;

/**
 * A computed `font-size` as a number of px, or `DEFAULT_FONT_SIZE` where it
 * is not a number. Zero is a size, and draws nothing.
 *
 * @param {string} value
 * @returns {number}
 */
export function readFontSize(value) {
  const size = Number.parseFloat(value);
  return Number.isNaN(size) ? DEFAULT_FONT_SIZE : size;
}

/**
 * The most device pixels a run is ever rasterized for each of its CSS pixels.
 *
 * Two things are clamped by it, and they arrive from opposite directions. A
 * panel under a scene measures what it is really painting (`textScale.js`),
 * and this is where that stops: four is sixteen times the texels of one, and
 * a panel of eight hundred labels is not worth any more of them than that.
 * A panel with nothing to measure against falls back to the page's own
 * device pixel ratio, and this is the cap that used to be two — which is what
 * made text on a three-times phone soft for no better reason than that it was
 * a guess and guesses were kept cheap. The guess is now allowed to be right.
 */
export const MAX_TEXT_SCALE = 4;
const MAX_TEXTURE_SIZE = 2048;
const TEXT_RENDER_BLEED = 2;

/**
 * How many samples the hardware may take across a run when the quad it is on
 * is foreshortened.
 *
 * Trilinear filtering picks one mip level, and it picks it from the *larger*
 * of the two screen derivatives — so a panel turned away from the viewer is
 * sampled at the level the compressed axis asks for and blurred by that much
 * along the axis that is not compressed. A panel at sixty degrees is a whole
 * level too soft, which is most of what "the text goes blurry when I step to
 * the side" is. Anisotropic sampling is the filter that fixes it.
 *
 * Four rather than a number off the device: three clamps whatever is asked
 * for to what the hardware can do, so this needs no renderer to be reached
 * from here, and four is where a run of text has already got back nearly all
 * there is to get. It is also what the code panel of `euclid-xr`, since
 * folded into `euclid`, arrived at on its own, before any of this was
 * shared.
 */
export const TEXT_ANISOTROPY = 4;

/**
 * @typedef {object} TextBounds
 * @property {number} width
 * @property {number} height
 */

/**
 * Everything about a text node's computed style that affects how its glyphs are
 * painted. Line breaking and alignment are deliberately absent: those are read
 * back off the layout as line boxes rather than reconstructed here.
 * @typedef {object} TextRenderStyle
 * @property {string} color
 * @property {string} font
 * @property {string} fontFamily
 * @property {string} fontStyle
 * @property {string} fontVariant
 * @property {string} fontWeight
 * @property {number} fontSize
 * @property {number} letterSpacing
 * @property {number} wordSpacing
 * @property {string} textTransform
 * @property {string} textShadow
 * @property {string} textDecorationLine
 * @property {string} textDecorationColor
 * @property {number} textDecorationThickness
 */

/**
 * @typedef {object} TextTexture
 * @property {THREE.Texture} texture
 * @property {number} width
 * @property {number} height
 */

/**
 * @param {number} value
 * @param {number} [precision]
 * @returns {number}
 */
function round(value, precision = 100) {
  return Math.round(value * precision) / precision;
}

/**
 * A computed length in px, and 0 for anything that is not one. Computed
 * borders and paddings are always px, which is what the boxes that draw
 * text inside themselves read with it.
 *
 * @param {string} value
 * @returns {number}
 */
export function px(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * An element's content box in its own border-box frame: the border box
 * less the border and the padding, which is where a browser puts what the
 * element holds.
 *
 * @param {CSSStyleDeclaration} style The element's computed style.
 * @param {{ width: number, height: number }} size Its border box.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function contentBox(style, size) {
  const left = px(style.borderLeftWidth) + px(style.paddingLeft);
  const top = px(style.borderTopWidth) + px(style.paddingTop);
  const right = px(style.borderRightWidth) + px(style.paddingRight);
  const bottom = px(style.borderBottomWidth) + px(style.paddingBottom);
  return {
    x: left,
    y: top,
    width: Math.max(size.width - left - right, 0),
    height: Math.max(size.height - top - bottom, 0),
  };
}

/**
 * @param {string} value
 * @param {number} fontSize
 * @returns {number}
 */
function parsePixelValue(value, fontSize) {
  if (!value || value === "normal") {
    return 0;
  }
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  if (value.endsWith("em")) {
    return parsed * fontSize;
  }
  if (value.endsWith("rem")) {
    const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Number.isNaN(rootSize) ? parsed * fontSize : parsed * rootSize;
  }
  return parsed;
}

/**
 * What one colour string resolves to, remembered. The probe below is not a
 * cheap thing to run between batched layout reads — appending and removing
 * a body child dirties the layout that every rect read after it then has to
 * recompute — and a panel asks about the same handful of colours over and
 * over. The resolution of a computed colour string does not depend on any
 * context the probe would pick up, so the string is the whole key.
 *
 * @type {Map<string, string>}
 */
const normalizedColors = new Map();

/**
 * @param {string} color
 * @returns {string}
 */
function normalizeColor(color) {
  const cached = normalizedColors.get(color);
  if (cached !== undefined) {
    return cached;
  }
  const probe = document.createElement("span");
  probe.style.color = color;
  document.body.appendChild(probe);
  const normalized = getComputedStyle(probe).color || color;
  document.body.removeChild(probe);
  normalizedColors.set(color, normalized);
  return normalized;
}

/**
 * The properties of a `TextRenderStyle` that pick its face. Two typedefs,
 * since `tsc` copies a type split across comment lines into the declaration
 * file with the lines' asterisks in it.
 *
 * @typedef {"fontFamily" | "fontStyle" | "fontVariant" | "fontWeight"} FaceKey
 * @typedef {Pick<TextRenderStyle, FaceKey>} FontFace
 */

/**
 * The canvas `font` shorthand for a face at a size.
 *
 * @param {FontFace} face
 * @param {number} fontSize In px.
 * @returns {string}
 */
function fontShorthand(face, fontSize) {
  return [face.fontStyle, face.fontVariant, face.fontWeight, `${fontSize}px`, face.fontFamily].join(
    " ",
  );
}

/**
 * @param {CSSStyleDeclaration} style
 * @returns {TextRenderStyle}
 */
export function getTextRenderStyle(style) {
  const resolvedFontSize = readFontSize(style.fontSize || "");

  // The `font-variant` slot of the canvas `font` shorthand is the CSS2 one:
  // `normal | small-caps`, and nothing else. `style.fontVariant` is the
  // computed *shorthand*, which serialises whatever its longhands are set to
  // -- `font-variant-numeric: tabular-nums` on the element makes it read
  // "tabular-nums" -- and a shorthand carrying that is not a valid font
  // string. Assigning an invalid string to `context.font` is a silent no-op,
  // so the canvas keeps `10px sans-serif` and every run drawn from that style
  // comes out tiny in the default face, whatever the element's own size and
  // weight say. Only the caps longhand belongs here, and only when it is the
  // one keyword the shorthand admits.
  const variant = style.fontVariantCaps === "small-caps" ? "small-caps" : "normal";

  /** @type {FontFace} */
  const face = {
    fontFamily: style.fontFamily || "sans-serif",
    fontStyle: style.fontStyle || "normal",
    fontVariant: variant,
    fontWeight: style.fontWeight || "400",
  };

  return {
    color: normalizeColor(style.color || "black"),
    font: fontShorthand(face, resolvedFontSize),
    ...face,
    fontSize: resolvedFontSize,
    letterSpacing: parsePixelValue(style.letterSpacing, resolvedFontSize),
    wordSpacing: parsePixelValue(style.wordSpacing, resolvedFontSize),
    textTransform: style.textTransform || "none",
    textShadow: style.textShadow || "none",
    textDecorationLine: style.textDecorationLine || "none",
    textDecorationColor:
      style.textDecorationColor && style.textDecorationColor !== "currentcolor"
        ? normalizeColor(style.textDecorationColor)
        : normalizeColor(style.color || "black"),
    textDecorationThickness: parsePixelValue(style.textDecorationThickness, resolvedFontSize),
  };
}

/**
 * The same style with the font's size, its spacing and the thickness of its
 * decorations multiplied by `factor`. A run drawn in it at `factor` times its
 * layout, through a `unitScale` divided by `factor`, comes out the same size
 * on the same number of texels, but every metric the canvas reads is read off
 * a font `factor` times larger. The shadow is not scaled, and would come out
 * `1 / factor` the size of the glyphs. SVG text, the one caller, draws its
 * runs with no shadow.
 *
 * @param {TextRenderStyle} style
 * @param {number} factor
 * @returns {TextRenderStyle}
 */
export function scaleTextRenderStyle(style, factor) {
  const fontSize = style.fontSize * factor;
  return {
    ...style,
    font: fontShorthand(style, fontSize),
    fontSize,
    letterSpacing: style.letterSpacing * factor,
    wordSpacing: style.wordSpacing * factor,
    textDecorationThickness: style.textDecorationThickness * factor,
  };
}

/**
 * The canvas a run is drawn on, and the one flag that matters on it.
 *
 * `willReadFrequently` sounds like a hint and is a decision. Without it a 2D
 * canvas lives on the GPU, and `getImageData` — which is how the pixels reach
 * the batch's array texture, once per run — becomes a readback: the pipeline
 * flushes and the frame waits for it. Measured on a panel of thirty-nine
 * runs, that read was 2.7 ms apiece and better than three quarters of the
 * whole cost of putting text on the screen; asking for it kept in ordinary
 * memory instead brings it to 0.15 ms. The drawing itself did not get slower
 * — it got slightly faster, these runs being far too small for a GPU canvas
 * to earn back its per-call overhead.
 *
 * @param {number} width
 * @param {number} height
 * @returns {{ canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }}
 */
export function createTextCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Could not create 2D context for text texture rendering.");
  }
  return { canvas, context };
}

/**
 * Whether the node's glyphs can be rasterized once as a white mask and
 * colored by the material, instead of baking the color into the texture.
 * Masked text makes color a material write — animating `color` re-draws
 * nothing — so it is the preferred path, and almost every label qualifies.
 *
 * What disqualifies: a `text-shadow` (the shadow must not take the text's
 * color, so both get baked), and a decoration explicitly colored something
 * other than the text (two colors, one mask). A decoration in
 * `currentcolor` — the default — tints right along with the glyphs.
 *
 * @param {CSSStyleDeclaration} style
 * @returns {boolean}
 */
export function isTintableText(style) {
  const shadow = style.textShadow || "none";
  if (shadow !== "none") {
    return false;
  }
  const line = style.textDecorationLine || "none";
  const color = style.textDecorationColor || "currentcolor";
  return line === "none" || color === "currentcolor";
}

/**
 * What a run is actually rasterized with. For tintable text the colours are
 * pinned to white, so a colour change leaves every key of the style alone
 * and the texture is never re-drawn: the glyphs become a mask, and the
 * colour rides on the material. Text that cannot be a mask keeps its
 * colours baked.
 *
 * @param {CSSStyleDeclaration} style
 * @returns {TextRenderStyle}
 */
export function getRunRenderStyle(style) {
  const renderStyle = getTextRenderStyle(style);
  if (isTintableText(style)) {
    return { ...renderStyle, color: "#ffffff", textDecorationColor: "#ffffff" };
  }
  return renderStyle;
}

/**
 * @param {string} text
 * @param {string} textTransform
 * @returns {string}
 */
function applyTextTransform(text, textTransform) {
  if (textTransform === "uppercase") {
    return text.toUpperCase();
  }
  if (textTransform === "lowercase") {
    return text.toLowerCase();
  }
  if (textTransform === "capitalize") {
    return text.replace(/(^|\s)\S/g, (char) => char.toUpperCase());
  }
  return text;
}

/**
 * @param {CanvasRenderingContext2D} context
 * @param {string} text
 * @param {number} letterSpacing
 * @param {number} wordSpacing
 * @returns {number}
 */
function measureTextWidth(context, text, letterSpacing, wordSpacing) {
  if (!text) {
    return 0;
  }
  if (!letterSpacing && !wordSpacing) {
    // Nothing to space out, so the line can be measured as a line — which is
    // both far cheaper than a call per character and more accurate, since it
    // is the only way the font's kerning is counted.
    return context.measureText(text).width;
  }
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    width += context.measureText(char).width;
    if (char === " ") {
      width += wordSpacing;
    }
    if (i < text.length - 1) {
      width += letterSpacing;
    }
  }
  return width;
}

/**
 * @param {CanvasRenderingContext2D} context
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} letterSpacing
 * @param {number} wordSpacing
 * @returns {number}
 */
function drawText(context, text, x, y, letterSpacing, wordSpacing) {
  if (!text) {
    return x;
  }
  if (!letterSpacing && !wordSpacing) {
    // The overwhelmingly common case: no spacing to apply, so the line goes
    // down in one call rather than two canvas operations per character — a
    // label of twenty characters was forty. It also comes out kerned, which
    // glyph-by-glyph drawing cannot be, so it matches the width the browser
    // measured instead of running a shade wide.
    context.fillText(text, x, y);
    return x + context.measureText(text).width;
  }
  let cursor = x;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    context.fillText(char, cursor, y);
    cursor += context.measureText(char).width;
    if (char === " ") {
      cursor += wordSpacing;
    }
    if (i < text.length - 1) {
      cursor += letterSpacing;
    }
  }
  return cursor;
}

/**
 * One layer of a computed `text-shadow`, in the shape the canvas shadow
 * properties want it. `color` is `null` when the layer named none: author
 * syntax may leave the color out, and it then means the text's own color,
 * which only the paint knows.
 *
 * @typedef {object} TextShadow
 * @property {string | null} color
 * @property {number} offsetX
 * @property {number} offsetY
 * @property {number} blur
 */

/**
 * A length inside a `text-shadow`. Computed values are always absolute, so
 * `px` is the only unit that can turn up and nothing here converts units.
 */
const SHADOW_LENGTH = /-?\d*\.?\d+px/g;

/**
 * What is allowed to stand as the color of a layer: a hex triplet, a bare
 * identifier (a named color), or a color function with its arguments —
 * `rgb(0, 0, 0)` and `rgb(0 0 0 / 50%)` alike, and the wide-gamut spellings
 * a modern engine increasingly serializes to. The list is deliberately of
 * color functions only: whatever survives this is handed to the canvas
 * `shadowColor` setter, which ignores what it cannot parse, so a `calc(…)`
 * or a stray word from a malformed value must not reach it.
 */
const SHADOW_COLOR =
  /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]+|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\((?:[^()]|\([^()]*\))*\))$/;

/**
 * Splits a `text-shadow` into its layers: the commas that separate layers
 * are the ones at nesting depth zero, not the ones inside a color function.
 * `rgb(0, 0, 0) 2px 3px 4px` is a single layer with two commas in it, and
 * splitting on those leaves `rgb(0`, which has no length in it at all.
 *
 * @param {string} textShadow
 * @returns {string[]}
 */
function splitShadowLayers(textShadow) {
  /** @type {string[]} */
  const layers = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < textShadow.length; i++) {
    const char = textShadow[i];
    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      layers.push(textShadow.slice(start, i));
      start = i + 1;
    }
  }
  layers.push(textShadow.slice(start));
  return layers;
}

/**
 * Reads the *first* layer of a `text-shadow`.
 *
 * First layer only, on purpose: a canvas context has one shadow, so painting
 * the rest would take a draw pass per layer — every glyph drawn again, and
 * the fill accumulating on each pass wherever the text is not opaque. The
 * first layer is the one CSS paints on top, so it is the one that reads;
 * the others are dropped, and the bleed the texture grows is the first
 * layer's alone. A panel that genuinely needs stacked shadows wants a
 * multi-pass raster, not an approximation smuggled in here.
 *
 * Lengths and color are separated by taking the length tokens out and
 * treating what remains as the color, rather than by matching a color
 * pattern over the whole layer. That reads color-first (what a computed
 * value serializes to) and color-last (what an author writes) alike, and it
 * cannot mistake the `px` of `2px` for a named color.
 *
 * @param {string} textShadow Normally a computed value, so color first and
 *   lengths in px; author syntax parses too.
 * @returns {TextShadow | null} `null` when there is no shadow to paint —
 *   `none`, an empty value, a layer without both offsets, or a color this
 *   does not recognise (better no shadow than one the canvas silently
 *   declines to change).
 */
export function parseTextShadow(textShadow) {
  if (!textShadow || textShadow === "none") {
    return null;
  }

  const layer = splitShadowLayers(textShadow)[0];
  const [offsetX, offsetY, blur] = layer.match(SHADOW_LENGTH) ?? [];
  if (offsetX === undefined || offsetY === undefined) {
    return null;
  }

  const color = layer.replace(SHADOW_LENGTH, " ").replace(/\s+/g, " ").trim();
  if (color && !SHADOW_COLOR.test(color)) {
    return null;
  }

  return {
    color: color || null,
    offsetX: Number.parseFloat(offsetX),
    offsetY: Number.parseFloat(offsetY),
    // A negative blur is not a value CSS produces, and a canvas ignores one;
    // clamping also keeps it from shrinking the bleed below the glyphs.
    blur: blur ? Math.max(0, Number.parseFloat(blur)) : 0,
  };
}

/**
 * How far past its layout box a run has to be drawn for nothing to be
 * clipped by the edge of the texture. Takes the shadow already parsed: the
 * paint needs the same one, and the two must not be able to disagree about
 * whether there is a shadow to make room for.
 *
 * @param {TextShadow | null} shadow
 * @returns {{ right: number, bottom: number }}
 */
export function getRenderBleed(shadow) {
  const { right, bottom } = getShadowBleed(shadow);
  return {
    right: TEXT_RENDER_BLEED + right,
    bottom: TEXT_RENDER_BLEED + bottom,
  };
}

/**
 * How far a run's shadow reaches past its layout box, to the right and to
 * the bottom: the part of the bleed that is ink a page paints, where the
 * kerning bleed (`TEXT_RENDER_BLEED`) is room for glyphs drawn one by one.
 * A shadow offset up or to the left is cut at the texture's edge, so it
 * reaches no further than the box.
 *
 * @param {TextShadow | null} shadow
 * @returns {{ right: number, bottom: number }}
 */
export function getShadowBleed(shadow) {
  if (!shadow) {
    return { right: 0, bottom: 0 };
  }
  return {
    right: Math.max(0, shadow.offsetX) + shadow.blur,
    bottom: Math.max(0, shadow.offsetY) + shadow.blur,
  };
}

/**
 * @param {CanvasRenderingContext2D} context
 * @param {number} left
 * @param {number} width
 * @param {number} baselineY
 * @param {TextRenderStyle} style
 * @returns {void}
 */
function drawDecorations(context, left, width, baselineY, style) {
  if (!style.textDecorationLine || style.textDecorationLine === "none") {
    return;
  }

  const thickness = style.textDecorationThickness > 0 ? style.textDecorationThickness : 1;

  context.fillStyle = style.textDecorationColor;

  if (style.textDecorationLine.includes("underline")) {
    context.fillRect(left, baselineY + thickness, width, thickness);
  }
  if (style.textDecorationLine.includes("line-through")) {
    context.fillRect(left, baselineY - style.fontSize * 0.3, width, thickness);
  }
  if (style.textDecorationLine.includes("overline")) {
    context.fillRect(left, baselineY - style.fontSize, width, thickness);
  }
}

/**
 * @param {TextBounds} bounds
 * @param {{ right: number, bottom: number }} bleed
 * @returns {TextBounds}
 */
function getTextureBounds(bounds, bleed) {
  if (bounds.width <= 0 || bounds.height <= 0) {
    return { width: 1, height: 1 };
  }
  return {
    width: Math.max(1, Math.ceil(bounds.width + bleed.right)),
    height: Math.max(1, Math.ceil(bounds.height + bleed.bottom)),
  };
}

/**
 * @param {number} renderScale Device pixels per CSS pixel — measured off the
 *   panel where there is a scene to measure against, and the page's own
 *   ratio where there is not.
 * @returns {number}
 */
function getEffectiveScale(renderScale) {
  const scale = Number.isFinite(renderScale) && renderScale > 0 ? renderScale : 1;
  return Math.min(MAX_TEXT_SCALE, scale);
}

/**
 * A measuring context, kept around so laying out a line does not cost a canvas
 * of its own. It never draws anything.
 * @type {CanvasRenderingContext2D | null}
 */
let measuringContext = null;

/**
 * @returns {CanvasRenderingContext2D}
 */
function getMeasuringContext() {
  if (!measuringContext) {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) {
      throw new Error("Could not create 2D context for text measurement.");
    }
    measuringContext = context;
  }
  return measuringContext;
}

/**
 * How every mark drawn on a panel's surface — a run of text, a field's
 * value, its caret — is blended and depth-tested. One recipe, here, because
 * a mark drawn one way and its neighbour another is a mark that z-fights
 * differently from an angle.
 *
 * Two-sided, because the container's half turn faces every plane away from the
 * viewer. One pass: the back pass three adds for a two-sided transparent
 * material orders a closed shape's own surfaces, and a quad has only the one —
 * the pass would be a second draw and, the expensive half, a second program
 * invalidation per mark per frame. No depth write: an antialiased edge pixel
 * that wrote depth would keep out whatever renders after it, and with the draw
 * order a panel uses nothing that belongs in front of text renders before it.
 * Still depth-tested, against what the scene drew before the panel. Nothing of
 * its own panel is in the depth buffer yet: the panel's depth quad draws after
 * all of its content (`createDepthQuad` in `blocker.js`).
 *
 * Spread into a `ShaderMaterial` as readily as into a `MeshBasicMaterial`;
 * `createMarkMaterial` is the latter.
 */
export const MARK_MATERIAL_SETTINGS = Object.freeze({
  side: THREE.DoubleSide,
  forceSinglePass: true,
  transparent: true,
  depthWrite: false,
});

/**
 * A material to draw one mark with, on `MARK_MATERIAL_SETTINGS`: white, to be
 * tinted by the caller, and discarding the fully transparent texels a mask's
 * ground leaves.
 *
 * Its program stays linked after the last mark drawn with it goes
 * (`programKeeper.js`). Which program that is depends on what the caller
 * does with the material afterwards. It can install the clip patch or the
 * reveal's (`clip.js`), and put a picture in `map`, a mask in `alphaMap` or
 * neither. Each of those programs gets its own keeper when it is first drawn.
 *
 * @returns {THREE.MeshBasicMaterial}
 */
export function createMarkMaterial() {
  return keepProgram(markMaterial(), MARK_PROGRAM);
}

/** @returns {THREE.MeshBasicMaterial} */
function markMaterial() {
  return new THREE.MeshBasicMaterial({
    ...MARK_MATERIAL_SETTINGS,
    alphaTest: 0.001,
    color: "white",
  });
}

/**
 * What a keeper samples in place of a mark's picture or mask. Never uploaded:
 * three sends a texture up only once `needsUpdate` has been set on it, and
 * binds an empty texture of its own in the place of one that never has. Which
 * texture it is does not enter the program, only whether there is one.
 */
const NO_PICTURE = new THREE.Texture();

/** @type {ProgramKind<THREE.MeshBasicMaterial>} */
const MARK_PROGRAM = {
  name: "freedom-mark",
  variant: (material) =>
    `${material.customProgramCacheKey()}|${material.map ? "map" : ""}|${material.alphaMap ? "alphaMap" : ""}`,
  create: (material) => {
    const keeper = markMaterial();
    // The patch itself rather than a copy of it, so that the keeper compiles
    // to the same source whichever of the two links the program.
    keeper.onBeforeCompile = material.onBeforeCompile;
    keeper.customProgramCacheKey = material.customProgramCacheKey;
    keeper.map = material.map && NO_PICTURE;
    keeper.alphaMap = material.alphaMap && NO_PICTURE;
    return keeper;
  },
};

/**
 * How far one line of text advances in this style, and nothing else: the
 * width `measureTextRun` gives, without the two measurements of the font's
 * height that come with it.
 *
 * @param {string} text
 * @param {TextRenderStyle} style
 * @returns {number}
 */
export function measureTextAdvance(text, style) {
  const context = getMeasuringContext();
  context.font = style.font;
  const drawn = applyTextTransform(text, style.textTransform);
  return measureTextWidth(context, drawn, style.letterSpacing, style.wordSpacing);
}

/**
 * What one line of text would measure in this style, for a run the browser
 * laid out nowhere — an `<input>`'s value, which is not a text node and has
 * no line boxes to read back. The width is the canvas's, kerned the way
 * `drawText` will draw it, so what is measured here is what is painted.
 *
 * @param {string} text
 * @param {TextRenderStyle} style
 * @returns {{ width: number, ascent: number, descent: number }}
 */
export function measureTextRun(text, style) {
  const context = getMeasuringContext();
  context.font = style.font;
  const ascent = measureFontExtent("Mg", context, style.fontSize * 0.8, "Ascent");
  const descent = measureFontExtent("Mg", context, style.fontSize * 0.2, "Descent");
  return { width: measureTextAdvance(text, style), ascent, descent };
}

/**
 * @typedef {object} DrawnLine
 * @property {string} text
 * @property {number} left
 * @property {number} width
 * @property {number} baseline
 */

/**
 * Place each line the browser produced onto the texture: horizontally where the
 * layout put it, and vertically on the baseline its line box implies. Because
 * the positions come from the layout rather than from a second guess at it,
 * `text-align` needs no special handling here — a centred line arrives already
 * offset, and so does a right-aligned or justified one.
 * @param {TextLine[]} lines
 * @param {TextRenderStyle} style
 * @param {number} ascent
 * @param {number} descent
 * @returns {DrawnLine[]}
 */
function layOutLines(lines, style, ascent, descent) {
  const context = getMeasuringContext();
  context.font = style.font;
  const glyphHeight = ascent + descent;

  return lines.map((line) => {
    const text = applyTextTransform(line.text, style.textTransform);
    const boxHeight = line.height > 0 ? line.height : glyphHeight;
    return {
      text,
      left: line.left,
      width: measureTextWidth(context, text, style.letterSpacing, style.wordSpacing),
      // Line boxes are as tall as the font's ascent plus its descent, so the
      // centring term is normally zero; it only does anything if the metrics
      // we measure disagree with the ones the layout used.
      baseline: line.top + (boxHeight - glyphHeight) / 2 + ascent,
    };
  });
}

/**
 * @param {string} text
 * @param {CanvasRenderingContext2D} context
 * @param {number} fallback
 * @param {"Ascent" | "Descent"} side
 * @returns {number}
 */
function measureFontExtent(text, context, fallback, side) {
  const metrics = context.measureText(text);
  return metrics[`fontBoundingBox${side}`] || metrics[`actualBoundingBox${side}`] || fallback;
}

/**
 * The mip chain of a run whose colours are baked into its texture, built here
 * rather than left to the driver.
 *
 * `gl.generateMipmap` averages four texels as they are *stored*, and what is
 * stored for a baked run is straight alpha on a transparent ground: a texel
 * the glyphs miss is transparent **black**, and one they half-cover carries
 * the text's colour at half alpha. Averaging those pulls the colour toward
 * black — a level-1 texel along the edge of a letter comes out half the
 * colour at half the alpha, which composites as a dark rim, and every level
 * under it is darker again. Shadowed text that reads cleanly up close goes
 * muddy as the panel shrinks, and there is nothing in level 0 to blame for
 * it.
 *
 * The mask path avoids this by painting coverage onto an opaque ground,
 * where the average of the stored values *is* the average of the coverage. A
 * baked run cannot: what is behind its glyphs is the panel.
 *
 * A canvas can, though. Its backing store is premultiplied, so halving one
 * with `drawImage` filters it in the space where that average is the right
 * one, and the un-premultiplication every upload does hands it back as a
 * half-covered texel carrying the *full* colour at half alpha — exactly the
 * shape level 0 has. Three uploads a texture's `mipmaps` as its levels and
 * asks the driver for none of its own, so this replaces the chain rather
 * than adding to it, and it has to be the whole chain: a level short of 1×1
 * is a texture `LinearMipmapLinearFilter` cannot sample.
 *
 * Only baked runs pay the extra canvases, and a baked run is the rare one —
 * a text shadow, or a decoration coloured away from the glyphs.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {HTMLCanvasElement[]} Level 0 first, down to 1×1.
 */
export function buildTextMipmaps(canvas) {
  /** @type {HTMLCanvasElement[]} */
  const mipmaps = [canvas];
  let source = canvas;
  let width = canvas.width;
  let height = canvas.height;
  // Halved from the level above rather than from level 0, which is both what
  // the driver does and less work: every step reads a quarter of what the
  // one before it read.
  while (width > 1 || height > 1) {
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
    const level = createTextCanvas(width, height);
    level.context.imageSmoothingEnabled = true;
    level.context.drawImage(source, 0, 0, width, height);
    mipmaps.push(level.canvas);
    source = level.canvas;
  }
  return mipmaps;
}

/**
 * The canvas `generateTextTexture` draws a run on, worked out without
 * drawing it: the lines as they will be drawn, the texture's bounds in CSS
 * px with the bleed for kerning and shadow, the scale it is drawn at, and
 * the canvas's size in texels. The size is what the text batch keys a run's
 * array by (`SizeClass` in `textBatch.js`), so whatever needs to know which
 * runs share an array asks here.
 *
 * @param {TextLine[]} lines
 * @param {TextRenderStyle} style
 * @param {TextBounds} bounds
 * @param {number} renderScale As `generateTextTexture` takes it.
 * @param {number} [unitScale] As `generateTextTexture` takes it.
 * @returns {{
 *   width: number,
 *   height: number,
 *   textureBounds: TextBounds,
 *   effectiveDpr: number,
 *   drawnLines: DrawnLine[],
 *   shadow: TextShadow | null,
 * }}
 */
export function measureTextCanvas(lines, style, bounds, renderScale, unitScale = 1) {
  const measuring = getMeasuringContext();
  measuring.font = style.font;
  const ascent = measureFontExtent("Mg", measuring, style.fontSize * 0.8, "Ascent");
  const descent = measureFontExtent("Mg", measuring, style.fontSize * 0.2, "Descent");

  const drawnLines = layOutLines(lines, style, ascent, descent);
  const normalizedBounds = {
    width: Math.max(1, round(bounds.width)),
    height: Math.max(1, round(bounds.height)),
  };
  // Drawing a line glyph by glyph loses the kerning the browser applied, so a
  // line can come out a shade wider than the box it was measured in. Grow the
  // texture to whatever was actually drawn rather than clipping the end of it.
  for (const line of drawnLines) {
    normalizedBounds.width = Math.max(normalizedBounds.width, round(line.left + line.width));
    normalizedBounds.height = Math.max(normalizedBounds.height, round(line.baseline + descent));
  }
  const shadow = parseTextShadow(style.textShadow);
  const renderBleed = getRenderBleed(shadow);
  const textureBounds = getTextureBounds(normalizedBounds, renderBleed);
  const dpr = getEffectiveScale(renderScale) * unitScale;
  const maxDimension = Math.max(textureBounds.width, textureBounds.height, 1);
  const textureScale = Math.min(1, MAX_TEXTURE_SIZE / (maxDimension * dpr));
  const effectiveDpr = dpr * textureScale;

  return {
    width: Math.max(1, Math.ceil(textureBounds.width * effectiveDpr)),
    height: Math.max(1, Math.ceil(textureBounds.height * effectiveDpr)),
    textureBounds,
    effectiveDpr,
    drawnLines,
    shadow,
  };
}

/**
 * @param {TextLine[]} lines
 * @param {TextRenderStyle} style
 * @param {TextBounds} bounds
 * @param {number} renderScale How many device pixels the run is drawn for
 *   each of its CSS pixels. `textScale.js` says where the number comes from.
 * @param {boolean} [mask] Rasterize as a coverage mask: white glyphs on an
 *   *opaque black* ground, meant to be read through a material's alpha map.
 *   Opacity is the point — on a transparent canvas the antialiasing lives
 *   only in the alpha channel, and the un-premultiplication that happens on
 *   upload rounds every partially covered texel's color back to full white,
 *   so a coverage read from a color channel comes out aliased. Painted onto
 *   black, the color channels *are* the coverage, gradient and all.
 * @param {number} [unitScale] How many CSS pixels one unit of `lines` and
 *   `bounds` is drawn at: 1 for HTML text, whose layout is in CSS pixels.
 *   SVG text hands its layout over `measuringScale` times larger than its
 *   user units, with a style scaled to match, so it passes the scale of the
 *   matrices above the `<text>` divided by that factor. Multiplied in after
 *   `renderScale` is capped, since the cap is on how finely a panel is
 *   painted, and a user unit may be many CSS pixels.
 * @returns {TextTexture} The caller's to dispose. A run keeps its rasters
 *   past the computation that drew them, one per step its panel holds
 *   (`textRun.js`), so when one goes is the caller's call and not the
 *   computation's.
 */
export const generateTextTexture = (
  lines,
  style,
  bounds,
  renderScale,
  mask = false,
  unitScale = 1,
) => {
  const { width, height, textureBounds, effectiveDpr, drawnLines, shadow } = measureTextCanvas(
    lines,
    style,
    bounds,
    renderScale,
    unitScale,
  );
  const { canvas, context } = createTextCanvas(width, height);

  context.scale(effectiveDpr, effectiveDpr);
  if (mask) {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, textureBounds.width, textureBounds.height);
  }
  context.font = style.font;
  context.fillStyle = style.color;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";

  // The transparent default goes on first and unconditionally. Assigning a
  // color the engine cannot parse is not an error: the setter simply leaves
  // `shadowColor` at whatever it held, so what it held has to be "no shadow".
  context.shadowColor = "rgba(0,0,0,0)";
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.shadowBlur = 0;
  if (shadow) {
    // A layer that named no color takes the text's, which is what CSS does
    // with an omitted `text-shadow` color.
    context.shadowColor = shadow.color ?? style.color;
    context.shadowOffsetX = shadow.offsetX;
    context.shadowOffsetY = shadow.offsetY;
    context.shadowBlur = shadow.blur;
  }

  for (const line of drawnLines) {
    drawText(context, line.text, line.left, line.baseline, style.letterSpacing, style.wordSpacing);
    drawDecorations(context, line.left, line.width, line.baseline, style);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = true;
  // A mask is coverage data, not color. Tagged sRGB it would be uploaded to
  // an sRGB internal format and the *hardware* would linearize every sample —
  // a half-covered edge texel would come back as 0.21 instead of 0.5, and the
  // glyph edges would collapse to a thin, crispy rim.
  texture.colorSpace = mask ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  // Mipmapped: a panel at arm's length draws its texture well under 1:1, and
  // an unmipped linear sample there dances between texels as the head moves.
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // And sampled across the foreshortening, which the panels these sit on are
  // almost always under.
  texture.anisotropy = TEXT_ANISOTROPY;
  if (mask) {
    // Coverage on an opaque ground, which is the one shape whose stored
    // average is the average anybody wanted. The driver's chain is right.
    texture.generateMipmaps = true;
  } else {
    texture.mipmaps = buildTextMipmaps(canvas);
    texture.generateMipmaps = false;
  }
  texture.needsUpdate = true;

  return {
    texture,
    width: textureBounds.width,
    height: textureBounds.height,
  };
};

/**
 * @param {number} width
 * @param {number} height
 * @returns {THREE.BufferGeometry}
 */
export function makeTextQuadGeometry(width, height) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([0, 0, 0, width, 0, 0, 0, height, 0, width, height, 0]);
  const uvs = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  geometry.computeVertexNormals();
  return geometry;
}
