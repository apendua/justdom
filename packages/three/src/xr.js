import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";

/**
 * @typedef {import('three').WebGLRenderer} WebGLRenderer
 * @typedef {import('three/examples/jsm/webxr/ARButton.js').ARButtonSessionInit} ARButtonSessionInit
 */

/**
 * Builds the button used to enter XR. Passthrough AR is preferred where the
 * platform can provide it, but plenty of headsets (anything without a
 * passthrough camera) only ever report support for immersive-vr, so this
 * falls back to a VR session there instead of leaving the visitor stuck on a
 * button that can never work. If neither mode is supported it falls back to
 * ARButton's own button, which renders the "AR NOT SUPPORTED" /
 * "WEBXR NEEDS HTTPS" state.
 *
 * @param {WebGLRenderer} renderer
 * @param {{ ar?: Partial<ARButtonSessionInit>; vr?: XRSessionInit }} [sessionInit]
 * @returns {Promise<HTMLElement>}
 */
export async function createXRButton(renderer, sessionInit = {}) {
  const xr = navigator.xr;
  if (xr) {
    if (await xr.isSessionSupported("immersive-ar").catch(() => false)) {
      return ARButton.createButton(renderer, sessionInit.ar);
    }
    if (await xr.isSessionSupported("immersive-vr").catch(() => false)) {
      return VRButton.createButton(renderer, sessionInit.vr);
    }
  }
  return ARButton.createButton(renderer, sessionInit.ar);
}
