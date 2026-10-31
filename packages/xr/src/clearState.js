/**
 * @typedef {object} Shadow
 * @property {[number, number, number, number]} [__clearColor]
 * @property {number} [__clearDepth]
 * @property {number} [__clearStencil]
 */

/**
 * Answer the three clear-state queries from a JS shadow on each of
 * `contexts`, rather than from the driver.
 *
 * IWER's frame loop saves and restores the clear state around its own
 * canvas clear: three `gl.getParameter` reads, every frame (XRSession.js,
 * `onDeviceFrame`). A synchronous `getParameter` is a pipeline sync: the
 * driver has to finish everything in flight before it can answer, so the
 * emulated session pays a CPU⇄GPU stall per frame that scales with however
 * much the scene drew. The values it asks for only ever change through
 * `clearColor`, `clearDepth` and `clearStencil`, so a shadow kept by those
 * three can answer instead, and the query never reaches the driver.
 *
 * Emulator-only by construction: it is installed by `install` in
 * `emulator.js`, which is loaded only behind `?emulator`, and a headset has
 * no IWER loop to stall.
 *
 * @param {Iterable<{ prototype: WebGLRenderingContext } | undefined>} contexts
 */
export function shadowClearStateQueries(contexts) {
  for (const Ctx of contexts) {
    if (!Ctx) {
      continue;
    }
    const proto = /** @type {WebGLRenderingContext & Shadow} */ (Ctx.prototype);
    const { clearColor, clearDepth, clearStencil, getParameter } = proto;
    /** @this {WebGLRenderingContext & Shadow} */
    proto.clearColor = function (r, g, b, a) {
      this.__clearColor = [r, g, b, a];
      return clearColor.call(this, r, g, b, a);
    };
    /** @this {WebGLRenderingContext & Shadow} */
    proto.clearDepth = function (depth) {
      this.__clearDepth = depth;
      return clearDepth.call(this, depth);
    };
    /** @this {WebGLRenderingContext & Shadow} */
    proto.clearStencil = function (stencil) {
      this.__clearStencil = stencil;
      return clearStencil.call(this, stencil);
    };
    /** @this {WebGLRenderingContext & Shadow} */
    proto.getParameter = function (pname) {
      if (pname === this.COLOR_CLEAR_VALUE) {
        return new Float32Array(this.__clearColor ?? [0, 0, 0, 0]);
      }
      if (pname === this.DEPTH_CLEAR_VALUE) {
        return this.__clearDepth ?? 1;
      }
      if (pname === this.STENCIL_CLEAR_VALUE) {
        return this.__clearStencil ?? 0;
      }
      return getParameter.call(this, pname);
    };
  }
}
