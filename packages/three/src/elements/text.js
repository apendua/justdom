import * as THREE from "three";
import { NoValueError, onCleanup } from "@apendua/signal";
import { effects, just, set, selector } from "@apendua/signal";
import { $, children } from "../operators.js";
import {
  generateTextTexture,
  getTextRenderStyle,
  isTintableText,
  makeTextQuadGeometry,
} from "./textHelpers.js";
import { parseColor } from "./VisualProperties.js";
import {
  getBoundingClientRectCached,
  getComputedStyleCached,
  getParentElement,
  getTextLayout,
} from "./cache.js";
import { isTransformed, untransformVector } from "./cssTransform.js";

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

  // Text has no layout offsets the way elements do, so its measurements come
  // from client rects — which are transformed bounds the moment a transform
  // sits anywhere above. The texture draws glyphs in the node's own
  // untransformed px (the object's ancestors re-apply the transform), so the
  // accumulated transform is divided back out first. Exact under translation
  // and scale; a rotated ancestor only hands back axis-aligned bounds, so
  // there the sizes approximate.
  const measured = selector(() => {
    const { bounds, lines } = layout;
    const parentElement = getParentElement(textNode);
    if (!parentElement || !isTransformed(parentElement)) {
      return { width: bounds.width, height: bounds.height, lines };
    }
    const size = untransformVector(parentElement, bounds.width, bounds.height);
    return {
      width: Math.abs(size.x),
      height: Math.abs(size.y),
      lines: lines.map((line) => {
        const corner = untransformVector(parentElement, line.left, line.top);
        const extent = untransformVector(parentElement, line.width, line.height);
        return {
          text: line.text,
          left: corner.x,
          top: corner.y,
          width: Math.abs(extent.x),
          height: Math.abs(extent.y),
        };
      }),
    };
  });

  // What actually reaches the rasterizer. For tintable text — almost every
  // label — the colors are pinned to white here, so a color change leaves
  // every key of this selector untouched and the texture is never re-drawn:
  // the glyphs become a mask, and the color rides on the material below.
  // Shadowed or explicitly-decorated text keeps its colors baked.
  const renderStyle = selector(() => {
    const renderStyle = getTextRenderStyle(style);
    if (isTintableText(style)) {
      return { ...renderStyle, color: "#ffffff", textDecorationColor: "#ffffff" };
    }
    return renderStyle;
  });

  // The color the material paints the mask with. Kept as the raw string so
  // that the per-frame samples of an animating neighbourhood gate on string
  // equality; parsing happens in the effect, only when this actually changed.
  const tint = selector(() => {
    if (!isTintableText(style)) {
      return { masked: false, color: "#ffffff" };
    }
    return { masked: true, color: style.color || "#000000" };
  });

  const textureData = selector(() => {
    return generateTextTexture(
      measured.lines,
      renderStyle,
      { width: measured.width, height: measured.height },
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
      let offsetX = textRect.left - parentRect.left;
      let offsetY = textRect.top - parentRect.top;
      const parentElement = getParentElement(textNode);
      if (parentElement && isTransformed(parentElement)) {
        // Both rects are transformed by the same ancestors, so their delta is
        // the transformed local offset; divide the transform back out.
        const local = untransformVector(parentElement, offsetX, offsetY);
        offsetX = local.x;
        offsetY = local.y;
      }
      obj.position.set(offsetX, offsetY, -0.01);
    }),
    children(
      $(new THREE.Mesh(), [
        // The material is created once and never replaced — the texture swaps
        // in and out of its `map` slot instead. Identity matters: the tint
        // effect below writes into whatever material the mesh carries, and a
        // replacement material would arrive untinted, with nothing to say the
        // tint should be applied again.
        set("material", () => {
          const basic = new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide,
            transparent: true,
            alphaTest: 0.001,
            color: "white",
          });
          onCleanup(() => {
            basic.dispose();
          });
          return basic;
        }),
        effects((obj) => {
          const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
          const hadMap = !!material.map;
          material.map = textureData.texture;
          if (!hadMap) {
            // Gaining a map changes the program; swapping one texture for
            // another does not.
            material.needsUpdate = true;
          }
        }),
        set("geometry", () => {
          const { width, height } = textureData;
          const geometry = makeTextQuadGeometry(width, height);
          onCleanup(() => {
            geometry.dispose();
          });
          return geometry;
        }),
        // After set("material"), so a re-drawn texture's fresh material gets
        // tinted too. Baked textures carry their own color and stay white.
        effects((obj) => {
          const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
          if (tint.masked) {
            const [color, alpha] = parseColor(tint.color);
            material.color.copy(color);
            material.opacity = alpha;
          } else {
            material.color.set("#ffffff");
            material.opacity = 1;
          }
        }),
        effects((obj) => {
          obj.position.set(0, 0, 0.01);
        }),
      ]),
    ),
  ]);
}
