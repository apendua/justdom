/**
 * Where `render()` takes its size from, and how it applies one.
 *
 * Two sources, one shape. The window is what a headset app wants: its canvas
 * is the page. A container is what a page with other things on it wants: the
 * canvas fills the element's content box and follows it as the page lays the
 * element out again. Each source is read in full on every change, the pixel
 * ratio included, so a canvas dragged to a screen of another density, or a
 * page zoomed, is drawn at the density it is now shown at.
 *
 * The rules for applying a size:
 *
 * - A size is applied once when the renderer is built, and again on every
 *   change the source reports.
 * - Nothing is applied while a session is presenting. three refuses a
 *   `setSize` then (the headset's layer has its own size), and the camera
 *   the scene draws with is the headset's, not this one.
 * - When the session ends, the size is applied again, read fresh. three puts
 *   back the size it saved when the session started, which is stale if the
 *   window or the container changed in between.
 * - The renderer's size, the camera's aspect and what `size(ctx)` reports
 *   change together, in one application, and never one without the others.
 */

/**
 * @import * as THREE from "three";
 */

/**
 * @typedef {object} ViewSize
 * @property {number} width In CSS pixels.
 * @property {number} height In CSS pixels.
 * @property {number} pixelRatio Device pixels per CSS pixel.
 */

/**
 * @typedef {object} SizeSource
 * @property {() => ViewSize} read The size now.
 * @property {(onChange: () => void) => () => void} subscribe Calls
 *   `onChange` whenever the size may have changed, until the returned
 *   function is called.
 */

/**
 * The window's inner size.
 *
 * @param {Window} [win]
 * @returns {SizeSource}
 */
export function windowSize(win = window) {
  return {
    read: () => ({
      width: win.innerWidth,
      height: win.innerHeight,
      pixelRatio: win.devicePixelRatio,
    }),
    subscribe(onChange) {
      win.addEventListener("resize", onChange);
      return () => win.removeEventListener("resize", onChange);
    },
  };
}

/**
 * The content box of an element: its client size less its padding.
 *
 * @param {HTMLElement} element
 * @param {typeof ResizeObserver} [Observer] The observer to watch it with;
 *   the browser's unless a test hands in its own.
 * @returns {SizeSource}
 */
export function containerSize(element, Observer = globalThis.ResizeObserver) {
  const view = element.ownerDocument.defaultView ?? window;
  return {
    read() {
      const style = view.getComputedStyle(element);
      const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      return {
        width: Math.max(0, element.clientWidth - padX),
        height: Math.max(0, element.clientHeight - padY),
        pixelRatio: view.devicePixelRatio,
      };
    },
    subscribe(onChange) {
      const observer = new Observer(() => onChange());
      observer.observe(element);
      return () => observer.disconnect();
    },
  };
}

/**
 * Applies the source's size to the renderer and the camera, and to `onSize`,
 * now and on every change, by the rules at the top of this file.
 *
 * @param {Pick<THREE.WebGLRenderer, "setPixelRatio" | "setSize"> & {
 *   xr: Pick<THREE.WebXRManager, "isPresenting" | "addEventListener" | "removeEventListener">;
 * }} renderer
 * @param {Pick<THREE.PerspectiveCamera, "aspect" | "updateProjectionMatrix">} camera
 * @param {SizeSource} source
 * @param {(size: ViewSize) => void} onSize
 * @returns {() => void} Stops following.
 */
export function followSize(renderer, camera, source, onSize) {
  function apply() {
    if (renderer.xr.isPresenting) {
      return;
    }
    const next = source.read();
    renderer.setPixelRatio(next.pixelRatio);
    renderer.setSize(next.width, next.height);
    // A container laid out at nothing yet has no aspect; keep the last one
    // rather than hand the projection a NaN.
    if (next.width > 0 && next.height > 0) {
      camera.aspect = next.width / next.height;
      camera.updateProjectionMatrix();
    }
    onSize(next);
  }
  apply();
  const unsubscribe = source.subscribe(apply);
  renderer.xr.addEventListener("sessionend", apply);
  return () => {
    unsubscribe();
    renderer.xr.removeEventListener("sessionend", apply);
  };
}

/**
 * Puts the canvas in the container, as a block, until the returned function
 * takes it out again.
 *
 * A block rather than the inline box a canvas is by default: an inline canvas
 * sits on the line's baseline with the descender's gap under it, so a
 * container sized by its content comes out a few pixels taller than the
 * canvas, which the canvas then grows to fill, and so on with every resize.
 *
 * @param {HTMLElement} container
 * @param {HTMLCanvasElement} canvas
 * @returns {() => void}
 */
export function putCanvasIn(container, canvas) {
  canvas.style.display = "block";
  container.appendChild(canvas);
  return () => canvas.remove();
}
