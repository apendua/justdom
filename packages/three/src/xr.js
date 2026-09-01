import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { anchorToViewer } from "./anchor.js";

/**
 * Which of the rates a runtime offers to ask for: the fastest it will give,
 * the middle one, or a number in Hz to take the nearest to.
 *
 * @typedef {"high" | "mid" | number} FrameRatePreference
 */

/**
 * Asks the runtime to run the session at the frame rate the app wants.
 *
 * A headset does not give you its best frame rate for asking politely — it
 * gives you its default, which on current standalone hardware is usually the
 * slowest rate it supports, and stays there for the life of the session
 * unless someone says otherwise. `supportedFrameRates` is the list on offer;
 * `updateTargetFrameRate` is how you pick from it.
 *
 * Faster is not free: at 120 Hz a frame has half the budget it has at 60, and
 * a scene that cannot hold the higher rate is worse off than one that never
 * asked, because the runtime drops frames rather than easing off. So this is
 * a preference rather than a demand, and an app with a heavy scene should
 * pass `"mid"`, or a number, or `false` to leave the default alone.
 *
 * Everything here is optional in the WebXR spec and absent in some runtimes,
 * so every step is guarded, and a refusal is swallowed: a session that will
 * not change its frame rate is still a perfectly good session.
 *
 * @param {WebGLRenderer} renderer
 * @param {FrameRatePreference} [preference]
 * @returns {() => void} Stops listening.
 */
export function requestFrameRate(renderer, preference = "high") {
  const onSessionStart = () => {
    const session = /** @type {XRSession & {
     *   supportedFrameRates?: Float32Array;
     *   updateTargetFrameRate?: (rate: number) => Promise<void>;
     * }} */ (/** @type {unknown} */ (renderer.xr.getSession()));
    const offered = session?.supportedFrameRates;
    if (!session || typeof session.updateTargetFrameRate !== "function" || !offered?.length) {
      return;
    }
    const rates = Array.from(offered).sort((a, b) => a - b);
    let wanted;
    if (typeof preference === "number") {
      wanted = rates.reduce((best, rate) =>
        Math.abs(rate - preference) < Math.abs(best - preference) ? rate : best,
      );
    } else if (preference === "mid") {
      wanted = rates[Math.floor((rates.length - 1) / 2)];
    } else {
      wanted = rates[rates.length - 1];
    }
    // A runtime is entitled to refuse, and some reject rather than resolve.
    // Neither is worth an unhandled rejection, let alone the session.
    Promise.resolve(session.updateTargetFrameRate(wanted)).catch(() => {});
  };
  renderer.xr.addEventListener("sessionstart", onSessionStart);
  return () => renderer.xr.removeEventListener("sessionstart", onSessionStart);
}

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
 * The session is also asked to run at the headset's fastest frame rate, which
 * is not what it does by default; see `requestFrameRate` for the trade, and
 * pass `frameRate: "mid"`, a number, or `false` for a scene that would rather
 * have the frame time than the frames.
 *
 * @param {WebGLRenderer} renderer
 * @param {{
 *   ar?: Partial<ARButtonSessionInit>;
 *   vr?: XRSessionInit;
 *   anchor?: boolean;
 *   frameRate?: FrameRatePreference | false;
 * }} [sessionInit]
 * @returns {Promise<HTMLElement>}
 */
export async function createXRButton(renderer, sessionInit = {}) {
  renderer.xr.setReferenceSpaceType("local");
  if (sessionInit.anchor !== false) {
    anchorToViewer(renderer);
  }
  if (sessionInit.frameRate !== false) {
    requestFrameRate(renderer, sessionInit.frameRate);
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
