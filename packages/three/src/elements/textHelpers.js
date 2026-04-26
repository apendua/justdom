import * as THREE from "three";
import { Observable } from "rxjs";
import { onCleanup } from "@apendua.dev/signal";
import { map } from "@apendua.dev/reactive";
import { shareObservable } from "@apendua.dev/store4";
import { Font } from "three/examples/jsm/loaders/FontLoader.js";

/**
 * @typedef {object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 */

const EPSILON = 1e-2;

/**
 * @param {Rect} rectA
 * @param {Rect} rectB
 * @returns {boolean}
 */
export const rectsEqual = (rectA, rectB) => {
  return (
    Math.abs(rectA.left - rectB.left) < EPSILON &&
    Math.abs(rectA.top - rectB.top) < EPSILON &&
    Math.abs(rectA.width - rectB.width) < EPSILON &&
    Math.abs(rectA.height - rectB.height) < EPSILON
  );
};

export const loadFont = shareObservable(
  /**
   * @param {string} path
   * @returns {Observable<Font>}
   */
  (path) => {
    return new Observable((subscriber) => {
      import("three/examples/jsm/loaders/TTFLoader.js")
        .then(({ TTFLoader }) => {
          const loader = new TTFLoader();
          loader.load(
            path,
            (font) => {
              subscriber.next(new Font(font));
            },
            () => {},
            (error) => {
              console.warn(error);
            },
          );
        })
        .catch((err) => {
          subscriber.error(err);
        });
    });
  },
);

/**
 * Measure the width of text using font data
 * @param {Font} font
 * @param {string} text
 * @returns {number}
 */
function measureTextWidth(font, text) {
  const { data } = font;
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const glyph = data.glyphs[char];
    if (glyph) {
      width += glyph.ha || 0;
    }
  }
  return width;
}

/**
 * Wrap text into lines based on maximum width
 * @param {Font} font
 * @param {string} text
 * @param {number[]} lineWidths
 * @returns {string[]}
 */
function wrapText(font, text, lineWidths) {
  if (lineWidths.length === 0) {
    return [text];
  }
  const words = text.split(/(\s+)/);
  const lines = [];
  let currentLine = "";
  let maxLineWidth = lineWidths[0];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine + word;
    const testWidth = measureTextWidth(font, testLine);

    if (testWidth > maxLineWidth && currentLine !== "") {
      if (lines.length < lineWidths.length - 1) {
        lines.push(currentLine.trimEnd());
        currentLine = word.trimStart();
        maxLineWidth = lineWidths[lines.length];
      } else {
        maxLineWidth = Infinity;
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
 * Translate all points in a shape by offset
 * @param {THREE.Path} path
 * @param {number} xOffset
 * @param {number} yOffset
 */
function translateShape(path, xOffset, yOffset) {
  const offset = new THREE.Vector2(xOffset, yOffset);
  path.curves.forEach((curve) => {
    if (curve instanceof THREE.LineCurve) {
      curve.v1.add(offset);
      curve.v2.add(offset);
    } else if (curve instanceof THREE.QuadraticBezierCurve) {
      curve.v0.add(offset);
      curve.v1.add(offset);
      curve.v2.add(offset);
    } else if (curve instanceof THREE.CubicBezierCurve) {
      curve.v0.add(offset);
      curve.v1.add(offset);
      curve.v2.add(offset);
      curve.v3.add(offset);
    }
  });

  // Also handle holes if present
  if (path instanceof THREE.Shape) {
    path.holes.forEach((hole) => {
      translateShape(hole, xOffset, yOffset);
    });
  }
}

export const generateTextGeometry = shareObservable(
  /**
   * @param {string} text
   * @param {string} fontUrl
   * @param {number} fontSize
   * @param {Rect[]} textRects
   * @returns {Observable<THREE.BufferGeometry>}
   */
  (text, fontUrl, fontSize, textRects) => {
    // TODO(@apendua): Handle textAlign = "justify", which requires slightly different shape generation logic.
    return loadFont(fontUrl).pipe(
      map((font) => {
        const scale = fontSize / (font.data.ascender - font.data.underlinePosition);

        const lineWidths = Array.from(textRects).map((rect) => (rect.width + 1) / scale);
        const lines = wrapText(font, text, lineWidths);

        /** @type {THREE.Shape[]} */
        const allShapes = [];

        lines.forEach((line, i) => {
          const lineShapes = font.generateShapes(line, font.data.resolution * scale);

          const xOffset = textRects[i]?.left ?? 0;
          const yOffset = textRects[i]?.top ?? 0;

          lineShapes.forEach((shape) => {
            translateShape(shape, xOffset, yOffset);
            allShapes.push(shape);
          });
        });

        const geometry = new THREE.ShapeGeometry(allShapes);
        onCleanup(() => {
          geometry.dispose();
        });
        return geometry;
      }),
    );
  },
);
