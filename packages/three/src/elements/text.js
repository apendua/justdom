import * as THREE from "three";
import { map, Observable } from "rxjs";
import { batch, Derived, Lazy, NoValueError, onInvalidate } from "@apendua.dev/signal";
import { effects, flatten, just, set, use } from "@apendua.dev/reactive";
import { animate } from "../render.js";
import { $, children } from "../operators.js";
import { shareObservable } from "@apendua.dev/store4";
import { Font } from "three/examples/jsm/loaders/FontLoader.js";

/**
 * @param {string} fontFamily
 * @returns {string}
 */
function findFontUrl(fontFamily) {
  // Normalize the font family name (remove quotes, trim)
  const normalizedFamily = fontFamily.replace(/['"]/g, "").trim().toLowerCase();
  for (let i = 0; i < document.styleSheets.length; i++) {
    const styleSheet = document.styleSheets[i];
    try {
      for (let j = 0; j < styleSheet.cssRules.length; j++) {
        const rule = styleSheet.cssRules[j];
        if (rule instanceof CSSFontFaceRule) {
          const ruleFontFamily = rule.style
            .getPropertyValue("font-family")
            .replace(/['"]/g, "")
            .trim()
            .toLowerCase();

          if (ruleFontFamily === normalizedFamily) {
            const src = rule.style.getPropertyValue("src");
            // Extract URL from src (can be multiple formats)
            const urlMatch = src.match(/url\(['"]?([^'"]+)['"]?\)/);
            if (urlMatch) {
              return urlMatch[1];
            }
          }
        }
      }
    } catch (e) {
      console.warn("Could not access stylesheet:", e);
    }
  }
  throw new NoValueError();
}

const loadFont = shareObservable(
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
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapText(font, text, maxWidth) {
  const words = text.split(/(\s+)/);
  const lines = [];
  let currentLine = "";

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine + word;
    const testWidth = measureTextWidth(font, testLine);

    if (testWidth > maxWidth && currentLine !== "") {
      lines.push(currentLine.trimEnd());
      currentLine = word.trimStart();
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

const generateTextGeometry = shareObservable(
  /**
   * @param {string} text
   * @param {string} fontUrl
   * @param {number} fontSize
   * @param {number} textWidth
   * @param {string} textAlign
   * @param {number} lineHeight
   * @returns {Observable<THREE.BufferGeometry>}
   */
  (text, fontUrl, fontSize, textWidth, textAlign, lineHeight) => {
    return loadFont(fontUrl).pipe(
      map((font) => {
        const scale = fontSize / (font.data.ascender - font.data.underlinePosition);
        // Add 1 pixel tollerance to avoid wrapping issues
        const maxWidth = (textWidth + 1) / scale;

        // Break text into lines based on textWidth
        const lines = wrapText(font, text, maxWidth);

        // Generate shapes for each line and position them
        /** @type {THREE.Shape[]} */
        const allShapes = [];
        let yOffset = 0;

        lines.forEach((line) => {
          if (!line) return;

          const lineShapes = font.generateShapes(line, font.data.resolution * scale);
          const lineWidth = measureTextWidth(font, line) * scale;

          // Calculate x offset based on alignment
          let xOffset = 0;
          if (textAlign === "center") {
            xOffset = (textWidth - lineWidth) / 2;
          } else if (textAlign === "right" || textAlign === "end") {
            xOffset = textWidth - lineWidth;
          }
          // 'left', 'start', or default is 0

          // Position shapes for this line
          lineShapes.forEach((shape) => {
            translateShape(shape, xOffset, yOffset);
            allShapes.push(shape);
          });

          // Move to next line
          yOffset -= lineHeight;
        });

        const geometry = new THREE.ShapeGeometry(allShapes);
        onInvalidate(() => {
          geometry.dispose();
        });
        return geometry;
      }),
    );
  },
);

/**
 * @param {Record<string, unknown>} objA
 * @param {Record<string, unknown>} objB
 * @returns {boolean}
 */
function shallowEqual(objA, objB) {
  if (objA === objB) {
    return true;
  }
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i];
    if (!Object.is(objA[key], objB[key])) {
      return false;
    }
  }
  return true;
}

/**
 * @param {WeakKey} ctx
 * @param {Text} textNode
 * @returns {Observable<THREE.Object3D>}
 */
export function text(ctx, textNode) {
  const object = new THREE.Object3D();
  /** @type {Lazy<string>} */
  const textColor = new Lazy();
  /** @type {Lazy<string>} */
  const fontFamily = new Lazy();
  /** @type {Lazy<number>} */
  const fontSize = new Lazy();
  // /** @type {Derived<Font>} */
  // const font = new Derived(() => {
  //   const fontUrl = findFontUrl(fontFamily.get());
  //   return new Source(loadFont(fontUrl)).get();
  // });
  /** @type {Lazy<string>} */
  const textContent = new Lazy();
  /** @type {Lazy<string>} */
  const textAlign = new Lazy();
  /** @type {Lazy<string>} */
  const lineHeight = new Lazy();
  /** @type {Lazy<DOMRect>} */
  const textRect = new Lazy((a, b) => shallowEqual(a.toJSON(), b.toJSON()));

  const lineHeightPx = new Derived(() => {
    const height = lineHeight.get();
    if (height === "normal") {
      return fontSize.get() * 1.2;
    }
    if (height.endsWith("px")) {
      return parseFloat(height);
    }
    return parseFloat(height) * fontSize.get();
  });

  // const material = new Derived(() => {
  //   const basic = new THREE.MeshBasicMaterial();
  //   new Derived(() => {
  //     basic.color.set(backgroundColor.get());
  //   }).get();
  //   onInvalidate(() => {
  //     basic.dispose();
  //   });
  //   return basic;
  // });

  const textMaterial = shareObservable(() => {
    return just(
      new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
      }),
      [
        effects((material) => {
          material.color.set(textColor.get() ?? "black");
        }),
        effects((material) => {
          onInvalidate(() => {
            material.dispose();
          });
        }),
      ],
    );
  });

  return just(object, [
    effects((obj) => {
      const { left, top } = textRect.get();
      const parentRect = textNode.parentElement?.getBoundingClientRect();
      if (parentRect) {
        const offsetX = left - parentRect.left;
        const offsetY = top - parentRect.top;
        obj.position.set(offsetX, offsetY, -0.01);
      } else {
        obj.position.set(left, top, -0.01);
      }
    }),
    effects(() => {
      use(
        animate(ctx, () => {
          if (!textNode.parentElement) {
            return;
          }
          const style = getComputedStyle(textNode.parentElement);

          const textRange = document.createRange();
          textRange.selectNodeContents(textNode);

          batch(() => {
            textColor.set(style.color);
            fontFamily.set(style.fontFamily);
            fontSize.set(parseFloat(style.fontSize));
            textContent.set(textNode.textContent);
            textAlign.set(style.textAlign);
            lineHeight.set(style.lineHeight);
            textRect.set(textRange.getBoundingClientRect());
          });
        }),
      );
    }),
    children(
      $(new THREE.Mesh(), [
        set("material", textMaterial()),
        set(
          "geometry",
          flatten(() => {
            const fontUrl = findFontUrl(fontFamily.get());
            return generateTextGeometry(
              textContent.get() || "",
              fontUrl,
              fontSize.get(),
              textRect.get().width,
              textAlign.get(),
              lineHeightPx.get(),
            );
          }),
        ),
        effects((obj) => {
          obj.position.set(0, fontSize.get(), 0.01);
          obj.scale.set(1, -1, 1);
        }),
      ]),
    ),
  ]);
}
