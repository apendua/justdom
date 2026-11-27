/**
 * Draws through a lost WebGL context without stopping for good.
 *
 * A browser takes the context away when it needs the GPU back: Safari on a
 * phone does when the page goes to the background, the screen locks or the
 * GPU runs short of memory, and gives it back as the page comes forward
 * again. three listens for both events. On `webglcontextlost` it stops
 * drawing, and on `webglcontextrestored` it starts again, with every
 * program, buffer and texture made anew from what the scene still holds.
 *
 * What three does not cover is the time before the first event. The context
 * is lost at once, and the event comes some time later, in a task of its
 * own, so a frame in between still draws. WebKit's `createShader` answers
 * null once the context is lost, and a frame that links a program in that
 * time hands the null to `shaderSource`, which throws. `WebGLRenderer.compile`
 * never checks for a lost context at all, so it throws after the event too.
 * Chromium answers a stand-in shader instead of null, which is why a desk
 * never shows it.
 *
 * So the context itself is asked, which knows at once. While it is lost the
 * draw is not called. A context can also go in the middle of a draw, between
 * the two shaders of one program, so what the draw throws once the context
 * is lost is let go as well. What it throws with the context still there is
 * a fault of its own and goes on to the caller.
 *
 * @template {[] | [time: number, frame: XRFrame]} A
 * @param {Pick<WebGLRenderingContext, "isContextLost">} gl
 * @param {(...args: A) => void} draw
 * @returns {(...args: A) => void} `draw`, held through a lost context.
 */
export function holdThroughLoss(gl, draw) {
  // Two fixed arguments rather than a rest parameter, which would be an
  // array every frame. `A` is at most a frame's time and its `XRFrame`, but
  // the type cannot follow that through, hence the casts.
  const call = /** @type {(a: unknown, b: unknown) => void} */ (/** @type {unknown} */ (draw));
  /** @type {(a: unknown, b: unknown) => void} */
  const held = (a, b) => {
    if (gl.isContextLost()) {
      return;
    }
    try {
      call(a, b);
    } catch (err) {
      if (!gl.isContextLost()) {
        throw err;
      }
    }
  };
  return /** @type {(...args: A) => void} */ (/** @type {unknown} */ (held));
}
