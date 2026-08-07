import * as THREE from "three";
import { Derived, onCleanup } from "@apendua/signal";
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
  getClipBoxCached,
  getComputedStyleCached,
  getParentElement,
  getTextLayout,
} from "./cache.js";
import { getContentRenderOrder } from "./elevation.js";
import { applyClip, clipBoxEqual, toLocalClipBox, UNCLIPPED } from "./clip.js";

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

  // Measured with transforms neutralized, so both the line boxes and the
  // parent-relative position come back in layout space — the space the
  // mirror draws in, with any transform riding on the ancestors' matrices.
  const layout = selector(() => {
    return getTextLayout(textNode);
  });

  const style = selector(() => {
    return getComputedStyleCached(textNode);
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
      layout.lines,
      renderStyle,
      layout.bounds,
      getViewportDpr(),
      tint.masked,
    );
  });

  // Text has an origin of its own — where its line boxes start inside the
  // parent — so the clip has to be read in that frame, not the parent's. The
  // bounds cannot supply it: under a transform they are measured on a clone
  // parked off-screen, whose coordinates say nothing about where the text is.
  // The parent's rect plus the layout offset is the same number, and true in
  // both cases.
  const clipBox = new Derived(
    () => {
      const box = getClipBoxCached(textNode);
      if (box === UNCLIPPED) {
        return box;
      }
      const parentElement = getParentElement(textNode);
      if (!parentElement) {
        return UNCLIPPED;
      }
      const parentRect = getBoundingClientRectCached(parentElement);
      return toLocalClipBox(box, parentRect.left + layout.left, parentRect.top + layout.top);
    },
    { isEqual: clipBoxEqual },
  );

  const clipUniform = { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) };

  return just(object, [
    effects((obj) => {
      obj.position.set(layout.left, layout.top, -0.01);
    }),
    effects(() => {
      const box = clipBox.get();
      clipUniform.value.set(box.left, box.top, box.right, box.bottom);
    }),
    children(
      $(new THREE.Mesh(), [
        // The material is created once and never replaced — the texture swaps
        // through its map slots instead. Identity matters: the tint effect
        // below writes into whatever material the mesh carries, and a
        // replacement material would arrive untinted, with nothing to say the
        // tint should be applied again.
        set("material", () => {
          const basic = new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide,
            transparent: true,
            alphaTest: 0.001,
            color: "white",
            // Text never occludes through the depth buffer: an antialiased
            // edge pixel that wrote depth would keep out whatever renders
            // after it — and with the draw order below, nothing that should
            // sit in front of text renders before it.
            depthWrite: false,
          });
          applyClip(basic, clipUniform);
          onCleanup(() => {
            basic.dispose();
          });
          return basic;
        }),
        effects((obj) => {
          const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
          const { texture } = textureData;
          const hadMap = !!material.map;
          const hadAlphaMap = !!material.alphaMap;
          if (tint.masked) {
            // A mask carries no color worth sampling: read it as coverage
            // through the alpha map (white-on-black, so the green channel is
            // the smooth canvas antialiasing) and let the color come
            // uniformly from the material. Nothing to fringe, nothing to
            // alias.
            material.alphaMap = texture;
            material.map = null;
          } else {
            material.map = texture;
            material.alphaMap = null;
          }
          if (hadMap !== !!material.map || hadAlphaMap !== !!material.alphaMap) {
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
        // After the map effect, so a re-drawn texture's material stays tinted.
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
        // One step past the parent's own box in the draw order. Boxes carry
        // `elevation * 1000 + layer` and text meshes defaulted to 0, so every
        // glyph drew *before* the surface it sits on: its antialiased edges
        // blended with whatever was behind the panel — usually the scene's
        // dark background — and wrote depth that then kept the surface from
        // filling in behind them. A thin dark border around every letter, and
        // no texture could fix it.
        effects((obj) => {
          const parentElement = getParentElement(textNode);
          if (parentElement) {
            obj.renderOrder = getContentRenderOrder(parentElement);
          }
        }),
      ]),
    ),
  ]);
}
