import * as THREE from "three";
import { NoValueError, onCleanup, Derived } from "@apendua.dev/signal";
import { effects, component, just, set, fields, use } from "@apendua.dev/reactive";
import { $, children } from "../operators.js";
import { generateTextGeometry, rectsEqual } from "./textHelpers.js";
import {
  getBoundingClientRectCached,
  getComputedStyleCached,
  getParentElement,
  getTextClientRects,
  getTextContent,
} from "./cache.js";

/**
 * @import { Observable } from "rxjs";
 * @import { Rect } from "./textHelpers.js";
 */

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
 * @param {Rect} textRect
 * @param {Rect[]} textRects
 * @returns {Rect[]}
 */
function getRelativeTextRects(textRect, textRects) {
  /** @type {Rect[]} */
  const relativeRects = [];
  for (let i = 0; i < textRects.length; i++) {
    const rect = textRects[i];
    relativeRects.push({
      left: rect.left - textRect.left,
      top: rect.top - textRect.top,
      width: rect.width,
      height: rect.height,
    });
  }
  return relativeRects;
}

/**
 * @param {WeakKey} ctx
 * @param {Text} textNode
 * @returns {Observable<THREE.Object3D>}
 */
export function text(ctx, textNode) {
  const object = new THREE.Object3D();
  // /** @type {Derived<Font>} */
  // const font = new Derived(() => {
  //   const fontUrl = findFontUrl(fontFamily.get());
  //   return getValueFromDependency(loadFont(fontUrl));
  // });
  const textContent = new Derived(() => {
    return getTextContent(textNode);
  });

  const textRect = fields(() => {
    return getTextClientRects(textNode)[0];
  });

  const textRects = new Derived(
    () => {
      const [boundingRect, clientRects] = getTextClientRects(textNode);
      return getRelativeTextRects(boundingRect, Array.from(clientRects));
    },
    (a, b) => {
      return (
        a.length == b.length &&
        a.every((rectA, index) => {
          return rectsEqual(rectA, b[index]);
        })
      );
    },
  );

  const style = fields(() => {
    return getComputedStyleCached(textNode);
  });

  const fontUrl = new Derived(() => {
    return findFontUrl(style.fontFamily);
  });

  const fontSize = new Derived(() => {
    const size = parseFloat(style.fontSize);
    if (Number.isNaN(size)) {
      throw new NoValueError();
    }
    return size;
  });

  const parentRect = fields(() => {
    const parentElement = getParentElement(textNode);
    if (!parentElement) {
      throw new NoValueError();
    }
    return getBoundingClientRectCached(parentElement);
  });

  return just(object, [
    effects((obj) => {
      const offsetX = textRect.left - parentRect.left;
      const offsetY = textRect.top - parentRect.top;
      obj.position.set(offsetX, offsetY, -0.01);
    }),
    children(
      $(new THREE.Mesh(), [
        set("material", () => {
          const basic = new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide,
          });
          use(() => {
            basic.color.set(style.color ?? "black");
          });
          onCleanup(() => {
            basic.dispose();
          });
          return basic;
        }),
        set(
          "geometry",
          component(() => {
            return generateTextGeometry(
              textContent.get(),
              fontUrl.get(),
              fontSize.get(),
              textRects.get(),
            );
          })(),
        ),
        effects((obj) => {
          obj.position.set(0, fontSize.get(), 0.01);
          obj.scale.set(1, -1, 1);
        }),
      ]),
    ),
  ]);
}
