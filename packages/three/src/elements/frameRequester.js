import { frames } from "../render.js";

/**
 * Frames for the parts of a portal that have to sample something rather than
 * be told about it: the animation clock, which watches styles move under a
 * running animation, and a scroll drag, which watches a hand move.
 *
 * The renderer's own frames when the portal lives inside a `render()` loop —
 * emitted at the top of each frame, so whatever they invalidate settles
 * before that frame draws — and the browser's otherwise, which is what tests
 * and plain pages get.
 *
 * @param {WeakKey} ctx
 * @returns {(tick: () => void) => () => void}
 */
export function createFrameRequester(ctx) {
  return (tick) => {
    try {
      const subscription = frames(ctx).subscribe(() => tick());
      return () => subscription.unsubscribe();
    } catch {
      if (typeof requestAnimationFrame !== "function") {
        // Nowhere to borrow frames from: no renderer and no browser loop, as
        // under a test runner. Whatever wanted sampling gets none, which for
        // all of them means holding still rather than failing — the caller is
        // asking to watch something change, not asking whether it can.
        return () => {};
      }
      let active = true;
      let handle = 0;
      const loop = () => {
        if (active) {
          tick();
          handle = requestAnimationFrame(loop);
        }
      };
      handle = requestAnimationFrame(loop);
      return () => {
        active = false;
        cancelAnimationFrame(handle);
      };
    }
  };
}
