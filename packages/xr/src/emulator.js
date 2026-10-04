import { XRDevice, XRReferenceSpace, metaQuest3 } from "iwer";
import { DevUI, useKeyMapStore } from "@iwer/devui";
import { shadowClearStateQueries } from "./clearState.js";
import { offsetByTransform } from "./offsetSpaces.js";

/**
 * Keys to move the emulated controllers to, by hand and by the DevUI's name
 * for what the key does (`thumbstick-up`, `trigger`, `squeeze`, `pose` and
 * so on), as `KeyboardEvent.code`s.
 *
 * @typedef {Partial<Record<"left" | "right", Record<string, string>>>} KeyMap
 */

/**
 * @typedef {object} EmulatorOptions
 * @property {boolean} [devUI] Whether to install the dev UI: the headset and
 *   controller panels drawn over the scene. On for a person driving the
 *   app by hand, off for a script that sets the poses itself or
 *   photographs the scene and wants nothing else in the frame.
 * @property {KeyMap} [keyMap] Keys to move the dev UI's controllers to. Its
 *   default keymap drives them from WASD, the arrow keys and Q/E/R, so a
 *   game that listens to those keys on a desktop gets each press twice in
 *   the dev UI's play mode: once as its own binding and once as an emulated
 *   thumbstick or button. Ignored without the dev UI.
 */

/**
 * Install an emulated Quest 3 in an ordinary browser, for an app loaded
 * with `?emulator`, and return it.
 *
 * The emulated headset is also left on `window.xrDevice`. It is the only
 * handle a script has on where the viewer is standing and what the
 * controllers are doing, which is how the apps are exercised in a headless
 * browser. It is reachable only from a page that asked for the emulator in
 * the first place, which is the same bargain the dev UI strikes.
 *
 * @param {EmulatorOptions} [options]
 * @returns {XRDevice}
 */
export function install({ devUI = true, keyMap } = {}) {
  console.log("Installing emulator");
  shadowClearStateQueries([window.WebGLRenderingContext, window.WebGL2RenderingContext]);
  const xrDevice = new XRDevice(metaQuest3);
  // Desktop browsers have a navigator.xr of their own that supports nothing,
  // and IWER steps aside for it unless told not to; the whole point of asking
  // for the emulator is to have it stand in for that.
  xrDevice.installRuntime({ forceInstall: true });
  offsetByTransform(XRReferenceSpace);
  if (devUI) {
    xrDevice.installDevUI(DevUI);
    const { bindKey } = useKeyMapStore.getState();
    for (const handedness of /** @type {const} */ (["left", "right"])) {
      for (const [action, code] of Object.entries(keyMap?.[handedness] ?? {})) {
        bindKey(handedness, action, code);
      }
    }
  }
  /** @type {Window & { xrDevice?: XRDevice }} */ (window).xrDevice = xrDevice;
  return xrDevice;
}
