import * as THREE from "three";
import { batch, Signal, NoValueError, onInvalidate } from "@apendua.dev/signal";
import { effects, component, just, set, use } from "@apendua.dev/reactive";
import { animate } from "../render.js";
import { $, children } from "../operators.js";
import { shareObservable } from "@apendua.dev/store4";
import { generateTextGeometry } from "./textHelpers.js";
import { getBoundingClientRectCached, getComputedStyleCached } from "./cache.js";

/**
 * @import { Observable } from "rxjs";
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
 * @param {WeakKey} ctx
 * @param {Text} textNode
 * @returns {Observable<THREE.Object3D>}
 */
export function text(ctx, textNode) {
  const object = new THREE.Object3D();
  /** @type {Signal<string>} */
  const textColor = new Signal();
  /** @type {Signal<string>} */
  const fontFamily = new Signal();
  /** @type {Signal<number>} */
  const fontSize = new Signal();
  // /** @type {Derived<Font>} */
  // const font = new Derived(() => {
  //   const fontUrl = findFontUrl(fontFamily.get());
  //   return getValueFromDependency(loadFont(fontUrl));
  // });
  /** @type {Signal<string>} */
  const textContent = new Signal();
  /** @type {Signal<boolean>} */
  const textJustify = new Signal();
  /** @type {Signal<DOMRect>} */
  const textRect = new Signal(undefined, (a, b) => {
    return shallowEqual(a.toJSON(), b.toJSON());
  });
  /** @type {Signal<DOMRectList>} */
  const textRects = new Signal(undefined, (a, b) => {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!shallowEqual(a[i].toJSON(), b[i].toJSON())) {
        return false;
      }
    }
    return true;
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
      const parentRect = textNode.parentElement
        ? getBoundingClientRectCached(textNode.parentElement)
        : null;
      if (parentRect) {
        const offsetX = left - parentRect.left;
        const offsetY = top - parentRect.top;
        obj.position.set(offsetX, offsetY, -0.01);
      } else {
        obj.position.set(left, top, -0.01);
      }
    }),
    effects(() => {
      if (!textNode.parentElement) {
        return;
      }
      const style = getComputedStyleCached(textNode.parentElement);

      const textRange = document.createRange();
      textRange.selectNodeContents(textNode);

      batch(() => {
        textColor.set(style.color);
        fontFamily.set(style.fontFamily);
        fontSize.set(parseFloat(style.fontSize));
        textContent.set(textNode.textContent);
        textJustify.set(style.textAlign === "justify");
        textRect.set(textRange.getBoundingClientRect());
        textRects.set(textRange.getClientRects());
      });
    }),
    children(
      $(new THREE.Mesh(), [
        set("material", textMaterial()),
        set(
          "geometry",
          component(() => {
            const fontUrl = findFontUrl(fontFamily.get());
            return generateTextGeometry(
              textContent.get() || "",
              fontUrl,
              fontSize.get(),
              textRect.get(),
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
