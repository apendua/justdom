import * as THREE from "three";
import { onCleanup } from "@apendua.dev/signal";

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
 * @typedef {object} TextRenderStyle
 * @property {string} color
 * @property {string} font
 * @property {string} fontFamily
 * @property {string} fontStyle
 * @property {string} fontVariant
 * @property {string} fontWeight
 * @property {number} fontSize
 * @property {number} lineHeight
 * @property {number} letterSpacing
 * @property {number} wordSpacing
 * @property {string} textTransform
 * @property {string} textAlign
 * @property {string} whiteSpace
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
 * @param {string} color
 * @returns {string}
 */
function normalizeColor(color) {
  const probe = document.createElement("span");
  probe.style.color = color;
  document.body.appendChild(probe);
  const normalized = getComputedStyle(probe).color || color;
  document.body.removeChild(probe);
  return normalized;
}

/**
 * @param {CSSStyleDeclaration} style
 * @returns {TextRenderStyle}
 */
export function getTextRenderStyle(style) {
  const fontSize = Number.parseFloat(style.fontSize || "");
  const resolvedFontSize = Number.isNaN(fontSize) ? DEFAULT_FONT_SIZE : fontSize;
  const lineHeightValue = Number.parseFloat(style.lineHeight || "");
  const lineHeight =
    style.lineHeight === "normal" || Number.isNaN(lineHeightValue)
      ? resolvedFontSize * 1.2
      : lineHeightValue;

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
    lineHeight,
    letterSpacing: parsePixelValue(style.letterSpacing, resolvedFontSize),
    wordSpacing: parsePixelValue(style.wordSpacing, resolvedFontSize),
    textTransform: style.textTransform || "none",
    textAlign: style.textAlign || "left",
    whiteSpace: style.whiteSpace || "normal",
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
 * Wrap text into lines based on maximum width
 * @param {CanvasRenderingContext2D} context
 * @param {string} text
 * @param {number} maxLineWidth
 * @param {number} maxLines
 * @param {number} letterSpacing
 * @param {number} wordSpacing
 * @param {string} whiteSpace
 * @returns {string[]}
 */
function wrapText(context, text, maxLineWidth, maxLines, letterSpacing, wordSpacing, whiteSpace) {
  if (whiteSpace.includes("pre")) {
    return text.split("\n");
  }

  if (maxLineWidth <= 0 || maxLines <= 0) {
    return [text];
  }

  if (whiteSpace === "nowrap") {
    return [text.replace(/\s+/g, " ")];
  }

  const words = text.split(/(\s+)/);
  const lines = [];
  let currentLine = "";

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine + word;
    const testWidth = measureTextWidth(context, testLine, letterSpacing, wordSpacing);

    if (testWidth > maxLineWidth && currentLine !== "") {
      if (lines.length < maxLines - 1) {
        lines.push(currentLine.trimEnd());
        currentLine = word.trimStart();
      } else {
        currentLine = testLine;
      }
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine.trimEnd());
  }

  return lines.length > 0 ? lines : [""];
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
 * @param {Rect} rect
 * @param {number} baselineY
 * @param {string} line
 * @param {TextRenderStyle} style
 * @returns {void}
 */
function drawDecorations(context, rect, baselineY, line, style) {
  if (!style.textDecorationLine || style.textDecorationLine === "none") {
    return;
  }

  const width = measureTextWidth(context, line, style.letterSpacing, style.wordSpacing);
  const thickness = style.textDecorationThickness > 0 ? style.textDecorationThickness : 1;

  context.fillStyle = style.textDecorationColor;

  if (style.textDecorationLine.includes("underline")) {
    context.fillRect(rect.left, baselineY + thickness, width, thickness);
  }
  if (style.textDecorationLine.includes("line-through")) {
    context.fillRect(rect.left, baselineY - style.fontSize * 0.3, width, thickness);
  }
  if (style.textDecorationLine.includes("overline")) {
    context.fillRect(rect.left, baselineY - style.fontSize, width, thickness);
  }
}

/**
 * @param {number} boxWidth
 * @param {number} lineWidth
 * @param {TextRenderStyle} style
 * @returns {number}
 */
function getAlignedX(boxWidth, lineWidth, style) {
  const remaining = Math.max(0, boxWidth - lineWidth);
  switch (style.textAlign) {
    case "right":
    case "end":
      return remaining;
    case "center":
      return remaining / 2;
    default:
      return 0;
  }
}

/**
 * @param {number} boxHeight
 * @param {number} lineCount
 * @param {number} lineIndex
 * @param {number} ascent
 * @param {number} descent
 * @param {TextRenderStyle} style
 * @returns {number}
 */
function getAlignedBaselineY(boxHeight, lineCount, lineIndex, ascent, descent, style) {
  const glyphHeight = ascent + descent;
  const lineHeight = Math.max(style.lineHeight || 0, glyphHeight);
  const textBlockHeight = lineCount * lineHeight;
  const blockTop = Math.max(0, boxHeight - textBlockHeight) / 2;
  const lineTop = blockTop + lineIndex * lineHeight;
  const glyphTop = lineTop + Math.max(0, lineHeight - glyphHeight) / 2;
  return glyphTop + ascent;
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
 * @param {string} text
 * @param {TextRenderStyle} style
 * @param {TextBounds} bounds
 * @param {number} viewportDpr
 * @returns {TextTexture}
 */
export const generateTextTexture = (text, style, bounds, viewportDpr) => {
  const transformedText = applyTextTransform(text, style.textTransform);
  const normalizedBounds = {
    width: Math.max(1, round(bounds.width)),
    height: Math.max(1, round(bounds.height)),
  };
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
  context.font = style.font;
  context.fillStyle = style.color;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";

  const metrics = context.measureText("Mg");
  const ascent = metrics.actualBoundingBoxAscent || style.fontSize * 0.8;
  const descent = metrics.actualBoundingBoxDescent || style.fontSize * 0.2;
  const lineHeight = Math.max(style.lineHeight || 0, ascent + descent);
  const maxLines = Math.max(1, Math.floor(normalizedBounds.height / Math.max(1, lineHeight)));

  const lines = wrapText(
    context,
    transformedText,
    normalizedBounds.width,
    maxLines,
    style.letterSpacing,
    style.wordSpacing,
    style.whiteSpace,
  );

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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineWidth = measureTextWidth(context, line, style.letterSpacing, style.wordSpacing);
    const x = getAlignedX(normalizedBounds.width, lineWidth, style);
    const y = getAlignedBaselineY(normalizedBounds.height, lines.length, i, ascent, descent, style);
    drawText(context, line, x, y, style.letterSpacing, style.wordSpacing);
    drawDecorations(
      context,
      { left: x, top: 0, width: lineWidth, height: normalizedBounds.height },
      y,
      line,
      style,
    );
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
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
