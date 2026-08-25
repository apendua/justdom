import * as THREE from "three";
import { onCleanup } from "justdom-signal";

/**
 * @import {TextLine} from './textLines.js';
 */

/**
 * @typedef {object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 */

const DEFAULT_FONT_SIZE = 16;
const MAX_DPR = 2;
const MAX_TEXTURE_SIZE = 2048;
const TEXT_RENDER_BLEED = 2;

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
 * @param {CSSStyleDeclaration} style
 * @returns {TextRenderStyle}
 */
export function getTextRenderStyle(style) {
  const fontSize = Number.parseFloat(style.fontSize || "");
  const resolvedFontSize = Number.isNaN(fontSize) ? DEFAULT_FONT_SIZE : fontSize;

  const font = [
    style.fontStyle || "normal",
    style.fontVariant || "normal",
    style.fontWeight || "400",
    `${resolvedFontSize}px`,
    style.fontFamily || "sans-serif",
  ].join(" ");

  return {
    color: normalizeColor(style.color || "black"),
    font,
    fontFamily: style.fontFamily || "sans-serif",
    fontStyle: style.fontStyle || "normal",
    fontVariant: style.fontVariant || "normal",
    fontWeight: style.fontWeight || "400",
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
 * @param {string} textShadow
 * @returns {{ color: string, offsetX: number, offsetY: number, blur: number } | null}
 */
function parseTextShadow(textShadow) {
  if (!textShadow || textShadow === "none") {
    return null;
  }

  const firstShadow = textShadow.split(",")[0].trim();
  const colorMatch = firstShadow.match(/(rgba?\([^)]*\)|#[0-9a-fA-F]+|[a-zA-Z]+)/);
  const numberParts = firstShadow.match(/-?\d+(?:\.\d+)?px/g) || [];
  if (numberParts.length < 2) {
    return null;
  }

  return {
    color: colorMatch ? colorMatch[1] : "rgba(0,0,0,0)",
    offsetX: Number.parseFloat(numberParts[0] || "0"),
    offsetY: Number.parseFloat(numberParts[1] || "0"),
    blur: numberParts[2] ? Number.parseFloat(numberParts[2]) : 0,
  };
}

/**
 * @param {TextRenderStyle} style
 * @returns {{ right: number, bottom: number }}
 */
function getRenderBleed(style) {
  const shadow = parseTextShadow(style.textShadow);
  if (!shadow) {
    return {
      right: TEXT_RENDER_BLEED,
      bottom: TEXT_RENDER_BLEED,
    };
  }
  return {
    right: TEXT_RENDER_BLEED + Math.max(0, shadow.offsetX) + shadow.blur,
    bottom: TEXT_RENDER_BLEED + Math.max(0, shadow.offsetY) + shadow.blur,
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
 * @param {number} viewportDpr
 * @returns {number}
 */
function getEffectiveDpr(viewportDpr) {
  const dpr = Number.isFinite(viewportDpr) && viewportDpr > 0 ? viewportDpr : 1;
  return Math.min(MAX_DPR, dpr);
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
 * @param {TextLine[]} lines
 * @param {TextRenderStyle} style
 * @param {TextBounds} bounds
 * @param {number} viewportDpr
 * @param {boolean} [mask] Rasterize as a coverage mask: white glyphs on an
 *   *opaque black* ground, meant to be read through a material's alpha map.
 *   Opacity is the point — on a transparent canvas the antialiasing lives
 *   only in the alpha channel, and the un-premultiplication that happens on
 *   upload rounds every partially covered texel's color back to full white,
 *   so a coverage read from a color channel comes out aliased. Painted onto
 *   black, the color channels *are* the coverage, gradient and all.
 * @returns {TextTexture}
 */
export const generateTextTexture = (lines, style, bounds, viewportDpr, mask = false) => {
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
  const renderBleed = getRenderBleed(style);
  const textureBounds = getTextureBounds(normalizedBounds, renderBleed);
  const dpr = getEffectiveDpr(viewportDpr);
  const maxDimension = Math.max(textureBounds.width, textureBounds.height, 1);
  const textureScale = Math.min(1, MAX_TEXTURE_SIZE / (maxDimension * dpr));
  const effectiveDpr = dpr * textureScale;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(textureBounds.width * effectiveDpr));
  canvas.height = Math.max(1, Math.ceil(textureBounds.height * effectiveDpr));

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create 2D context for text texture rendering.");
  }

  context.scale(effectiveDpr, effectiveDpr);
  if (mask) {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, textureBounds.width, textureBounds.height);
  }
  context.font = style.font;
  context.fillStyle = style.color;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";

  const shadow = parseTextShadow(style.textShadow);
  if (shadow) {
    context.shadowColor = shadow.color;
    context.shadowOffsetX = shadow.offsetX;
    context.shadowOffsetY = shadow.offsetY;
    context.shadowBlur = shadow.blur;
  } else {
    context.shadowColor = "rgba(0,0,0,0)";
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
    context.shadowBlur = 0;
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
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  onCleanup(() => {
    texture.dispose();
  });

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
