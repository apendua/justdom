import * as THREE from "three";

/**
 * What a scene needs to show an element the browser draws itself, with
 * HTML-in-Canvas (https://github.com/WICG/html-in-canvas), next to or
 * instead of a mirror: whether the browser can, how to hand it the element,
 * a texture to upload its picture to, and a material that shows the picture
 * in the page's colours.
 */

/**
 * Whether the browser can draw an element into a WebGL texture: Chrome from
 * 157, which ships HTML-in-Canvas with no flag. `texElementSubImage2D` is what
 * `createElementTexture` uploads with, and the canvas's `paint` event, which
 * `requestPaint` asks for, is what tells it when to. Earlier Chromium had the
 * API behind `chrome://flags/#canvas-draw-element`, and up to 154 under older
 * names (`layoutsubtree`, `texElementImage2D`), which this does not count.
 *
 * @returns {boolean}
 */
export function canDrawHtmlInCanvas() {
  return (
    typeof WebGL2RenderingContext !== "undefined" &&
    "texElementSubImage2D" in WebGL2RenderingContext.prototype &&
    typeof HTMLCanvasElement !== "undefined" &&
    "requestPaint" in HTMLCanvasElement.prototype
  );
}

/**
 * The parts of HTML-in-Canvas this module calls, which the DOM's types do not
 * have yet.
 *
 * @typedef {HTMLCanvasElement & { requestPaint(): void }} DrawableCanvas
 * @typedef {WebGL2RenderingContext & {
 *   texElementSubImage2D(
 *     target: number,
 *     level: number,
 *     xoffset: number,
 *     yoffset: number,
 *     element: Element,
 *     config?: { width?: number; height?: number },
 *   ): void;
 * }} ElementDrawingContext
 */

/**
 * Let the browser lay out and draw `element` inside `canvas`, and nowhere on
 * the page: the canvas takes `content="drawable"`, the element `drawable`,
 * and the element becomes the canvas's last child. Then ask for a `paint`, at
 * which the element has a picture to upload.
 *
 * The function it returns takes the element's `drawable` away, and the
 * canvas's `content` too once no other child of it is drawable. Where the
 * element goes then is the caller's: call it after moving the element out.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Element} element
 * @returns {() => void}
 */
export function drawInCanvas(canvas, element) {
  canvas.setAttribute("content", "drawable");
  element.setAttribute("drawable", "");
  canvas.append(element);
  /** @type {DrawableCanvas} */ (canvas).requestPaint();
  return () => {
    element.removeAttribute("drawable");
    if (!canvas.querySelector(":scope > [drawable]")) {
      canvas.removeAttribute("content");
    }
  };
}

/**
 * A texture of `element`, a drawable child of the renderer's canvas (see
 * `drawInCanvas`), and the `upload` that draws the element's latest picture
 * into it. Call `upload` from the canvas's `paint`, once that event has
 * painted the element (`paintedElement`): before the first paint there is no
 * picture, and `texElementSubImage2D` throws.
 *
 * three's own `HTMLTexture` (r185 to r187) uploads with `texElementImage2D`,
 * which Chrome 157 no longer has. So this texture is an `ExternalTexture`
 * around a WebGL texture of its own: `upload` allocates it at the element's
 * size in device px, its CSS px at the page's pixel ratio, whenever that size
 * changes, since `texElementSubImage2D` only writes into storage that exists,
 * and draws the whole element into it at that size. Rows run from the element's bottom, as three's own uploads do, unless
 * the texture's `flipY` is set to `false`.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {HTMLElement} element
 * @returns {{ texture: THREE.ExternalTexture, upload: () => void, dispose: () => void }}
 */
export function createElementTexture(renderer, element) {
  const gl = /** @type {ElementDrawingContext} */ (renderer.getContext());
  const glTexture = gl.createTexture();
  const texture = new THREE.ExternalTexture(glTexture);
  texture.colorSpace = THREE.SRGBColorSpace;
  let width = 0;
  let height = 0;
  return {
    texture,
    upload() {
      const ratio = globalThis.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(element.offsetWidth * ratio));
      const h = Math.max(1, Math.round(element.offsetHeight * ratio));
      // Through three's state, so that it knows what is bound where.
      renderer.state.bindTexture(gl.TEXTURE_2D, glTexture);
      if (w !== width || h !== height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        width = w;
        height = h;
      }
      // three sets these for each texture it uploads, and leaves them so.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      // Without a size the browser draws the element at its size in the
      // canvas's own pixels, which under a session is the headset's
      // framebuffer and need not fit the storage.
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, element, { width: w, height: h });
      renderer.state.unbindTexture();
    },
    dispose() {
      texture.dispose();
      gl.deleteTexture(glTexture);
    },
  };
}

/**
 * An unlit, see-through material for a `createElementTexture` texture.
 * `texElementSubImage2D` writes only RGBA8, which the GPU does not decode from
 * sRGB as it does an SRGB8_ALPHA8 one, so a plain material shows every colour the page drew
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
 * Whether a canvas's `paint` event painted `element` anew, so that a texture
 * of it has something new to upload. The event lists the drawable children
 * whose picture changed, and a paint `requestPaint` asked for while nothing
 * changed lists none.
 *
 * @param {Event} event
 * @param {Element} element
 * @returns {boolean}
 */
export function paintedElement(event, element) {
  return /** @type {Event & { changedElements: readonly Element[] }} */ (
    event
  ).changedElements.includes(element);
}
