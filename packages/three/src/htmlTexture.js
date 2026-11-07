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
 * `DECODE_VIDEO_TEXTURE` is defined, as it does for a video. The map is set
 * once the browser has painted the element, since a texture made before that
 * has nothing to upload.
 *
 * @returns {THREE.MeshBasicMaterial}
 */
export function htmlTextureMaterial() {
  const material = new THREE.MeshBasicMaterial({ transparent: true });
  material.defines = { DECODE_VIDEO_TEXTURE: "" };
  return material;
}

/**
 * Ask the browser to paint what `canvas` holds once more, and fire `paint`
 * when it has. A browser without HTML-in-Canvas does nothing.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {void}
 */
export function requestPaint(canvas) {
  /** @type {HTMLCanvasElement & { requestPaint?: () => void }} */ (canvas).requestPaint?.();
}

/**
 * Whether a canvas's `paint` event painted `element`, so that a texture of
 * it has something to upload. An event that does not list what it painted
 * counts as having painted everything the canvas holds.
 *
 * @param {Event} event
 * @param {Element} element
 * @returns {boolean}
 */
export function paintedElement(event, element) {
  const changed = /** @type {Event & { changedElements?: readonly Element[] }} */ (event)
    .changedElements;
  return !changed || changed.includes(element);
}
