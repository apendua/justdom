/**
 * Stands in for the renderer's frame loop. The interaction manager is handed
 * one of these per controller and is expected to do its raycasting from it;
 * `run()` is a frame going by.
 */
export function fakeFrameLoop() {
  /** @type {Set<XRFrameRequestCallback>} */
  const callbacks = new Set();
  return {
    /**
     * @param {XRFrameRequestCallback} fn
     * @returns {() => void}
     */
    onAnimationFrame(fn) {
      callbacks.add(fn);
      return () => {
        callbacks.delete(fn);
      };
    },
    run() {
      for (const fn of callbacks) {
        fn(0, /** @type {XRFrame} */ (/** @type {unknown} */ ({})));
      }
    },
  };
}
