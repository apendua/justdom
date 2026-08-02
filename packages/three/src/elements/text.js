import * as THREE from "three";
import { NoValueError, onCleanup } from "@apendua/signal";
import { effects, just, set, selector } from "@apendua/signal";
import { $, children } from "../operators.js";
import { generateTextTexture, getTextRenderStyle, makeTextQuadGeometry } from "./textHelpers.js";
import {
  getBoundingClientRectCached,
  getComputedStyleCached,
  getParentElement,
  getTextLayout,
} from "./cache.js";

/**
 * @import { Observable } from "rxjs";
 */

/**
 * @returns {number}
 */
function getViewportDpr() {
  if (typeof window === "undefined") {
    return 1;
  }
  return window.devicePixelRatio || 1;
}

/**
 * @param {WeakKey} _
 * @param {Text} textNode
 * @returns {Observable<THREE.Object3D>}
 */
export function text(_, textNode) {
  const object = new THREE.Object3D();

  const layout = selector(() => {
    return getTextLayout(textNode);
  });

  const textRect = selector(() => {
    return layout.bounds;
  });

  const style = selector(() => {
    return getComputedStyleCached(textNode);
  });

  const textureData = selector(() => {
    return generateTextTexture(
      layout.lines,
      getTextRenderStyle(style),
      layout.bounds,
      getViewportDpr(),
    );
  });

  const parentRect = selector(() => {
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
          const { texture } = textureData;
          const basic = new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide,
            transparent: true,
            alphaTest: 0.001,
            map: texture,
            color: "white",
          });
          onCleanup(() => {
            basic.dispose();
          });
          return basic;
        }),
        set("geometry", () => {
          const { width, height } = textureData;
          const geometry = makeTextQuadGeometry(width, height);
          onCleanup(() => {
            geometry.dispose();
          });
          return geometry;
        }),
        effects((obj) => {
          obj.position.set(0, 0, 0.01);
        }),
      ]),
    ),
  ]);
}
