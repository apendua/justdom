import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { anchorToViewer } from "./anchor.js";

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
 * ARButton always requests `local` as the reference space, with its origin
 * at the headset's position when the session starts. VRButton never touches
 * `renderer.xr`'s reference space type, so three.js is left on its own
 * default, `local-floor`, whose origin sits on the floor instead. Scenes here
 * are laid out for the `local` origin, so falling back to VRButton unchanged
 * would put everything at floor level, well below the headset's initial
 * gaze — the fallback session would start, but the scene would appear
 * missing. Setting the reference space explicitly keeps both paths
 * consistent, matching what ARButton already does internally.
 *
 * A `local` origin is also only a promise that the runtime keeps as well as
 * its tracking allowed at the instant the session was created — entered on
 * stale tracking, the origin lands somewhere arbitrary and the scene with it.
 * So the viewer anchor is installed alongside the button: every session's
 * origin is re-derived from the first trustworthy viewer pose instead of
 * being trusted blindly (see `anchorToViewer`). `anchor: false` opts out,
 * for an app that wants to manage the reference space itself.
 *
 * @param {WebGLRenderer} renderer
 * @param {{
 *   ar?: Partial<ARButtonSessionInit>;
 *   vr?: XRSessionInit;
 *   anchor?: boolean;
 * }} [sessionInit]
 * @returns {Promise<HTMLElement>}
 */
export async function createXRButton(renderer, sessionInit = {}) {
  renderer.xr.setReferenceSpaceType("local");
  if (sessionInit.anchor !== false) {
    anchorToViewer(renderer);
  }
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
