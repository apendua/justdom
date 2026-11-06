import * as THREE from "three";

/**
 * What a scene needs to show an element the browser draws itself, with
 * HTML-in-Canvas (https://github.com/WICG/html-in-canvas), next to or
 * instead of a mirror: whether the browser can, and a material that shows
 * the picture in the page's colours. three's `HTMLTexture` does the upload.
 */

/**
 * Whether the browser can draw an element into a WebGL texture: Chromium
 * with `chrome://flags/#canvas-draw-element` turned on, or started with
 * `--enable-blink-features=CanvasDrawElement`. `texElementImage2D` is what
 * three's `HTMLTexture` uploads with, and the canvas's `paint` event, which
 * `requestPaint` asks for, is what tells it when to.
 *
 * @returns {boolean}
 */
export function canDrawHtmlInCanvas() {
  return (
    typeof WebGL2RenderingContext !== "undefined" &&
    "texElementImage2D" in WebGL2RenderingContext.prototype &&
    typeof HTMLCanvasElement !== "undefined" &&
    "requestPaint" in HTMLCanvasElement.prototype
  );
}

/**
 * An unlit, see-through material for an `HTMLTexture`. three uploads that
 * texture as RGBA8, which the GPU does not decode from sRGB as it does an
 * SRGB8_ALPHA8 one, so a plain material shows every colour the page drew
 * lighter than it was. The map's shader decodes it inline when
 * `DECODE_VIDEO_TEXTURE` is defined, as it does for a video.
 *
 * @param {THREE.Texture | null} [map]
 * @returns {THREE.MeshBasicMaterial}
 */
export function htmlTextureMaterial(map = null) {
  const material = new THREE.MeshBasicMaterial({ map, transparent: true });
  material.defines = { DECODE_VIDEO_TEXTURE: "" };
  return material;
}
