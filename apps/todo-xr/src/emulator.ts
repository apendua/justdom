import { XRDevice, metaQuest3 } from "iwer";
import { DevUI } from "@iwer/devui";

/**
 * IWER's frame loop saves and restores the clear state around its own
 * canvas clear — three `gl.getParameter` reads, every frame (XRSession.js,
 * `onDeviceFrame`). A synchronous getParameter is a pipeline sync: the
 * driver has to finish everything in flight before it can answer, so the
 * emulated session pays a CPU⇄GPU stall per frame that scales with however
 * much the scene drew. The values it asks for only ever change through
 * `clearColor`/`clearDepth`/`clearStencil`, so a JS shadow can answer
 * instead, and the query never reaches the driver.
 *
 * Emulator-only by construction: this file is loaded only behind
 * `?emulator`, and a headset has no IWER loop to stall.
 */
function shadowClearStateQueries() {
  for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Ctx) {
      continue;
    }
    type Shadowed = {
      __clearColor?: [number, number, number, number];
      __clearDepth?: number;
      __clearStencil?: number;
    };
    const proto = Ctx.prototype as WebGLRenderingContext & Shadowed;
    const clearColor = proto.clearColor;
    const clearDepth = proto.clearDepth;
    const clearStencil = proto.clearStencil;
    const getParameter = proto.getParameter;
    proto.clearColor = function (this: typeof proto, r: number, g: number, b: number, a: number) {
      this.__clearColor = [r, g, b, a];
      return clearColor.call(this, r, g, b, a);
    };
    proto.clearDepth = function (this: typeof proto, depth: number) {
      this.__clearDepth = depth;
      return clearDepth.call(this, depth);
    };
    proto.clearStencil = function (this: typeof proto, stencil: number) {
      this.__clearStencil = stencil;
      return clearStencil.call(this, stencil);
    };
    proto.getParameter = function (this: typeof proto, pname: number) {
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

export interface EmulatorOptions {
  /**
   * Whether to install the dev UI — the headset and controller panels drawn
   * over the scene. On for a person driving the demo by hand, off for a test
   * that is photographing what the scene looks like and wants nothing else in
   * the frame.
   */
  devUI?: boolean;
}

export function install({ devUI = true }: EmulatorOptions = {}) {
  console.log("Installing emulator");
  shadowClearStateQueries();
  const xrDevice = new XRDevice(metaQuest3);
  xrDevice.installRuntime();
  if (devUI) {
    xrDevice.installDevUI(DevUI);
  }
  // The emulated headset is the only handle a test has on where the viewer is
  // standing and what the controllers are doing. It is reachable only from a
  // page that asked for the emulator in the first place, which is the same
  // bargain the dev UI strikes.
  (window as unknown as { xrDevice?: XRDevice }).xrDevice = xrDevice;
  return xrDevice;
}
