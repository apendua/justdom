import { anchorToViewer } from "./anchor.js";
import { createSessionButton, createUnsupportedButton } from "./button.js";
import { installCrashPanel } from "./crash.js";

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
 * Stops a page standing about with a session on offer.
 *
 * `navigator.xr.offerSession` says "start me when you like" — the browser
 * takes the offer, puts an Enter XR affordance in its own chrome, and may
 * open the session with no click of ours at all. three's `ARButton` and
 * `VRButton` make one when they are built, and another the instant the
 * button is used to *leave* a session: `currentSession.end()` and the offer
 * on the next line, without waiting for the end to happen.
 *
 * That second one is the problem. On a Quest, leaving a session that has
 * already been re-offered leaves the browser behaving as though the session
 * were still running — it stops taking taps, and only a restart clears it.
 * Not every time, which is what a race looks like from the outside.
 *
 * There is no way to ask three's buttons not to do this: both call sites
 * read `navigator.xr.offerSession` and use it if it is there. So it is not
 * there. The property is shadowed with `undefined`, which both `if`s read as
 * "this runtime has no offers" — the same branch every browser but Chrome
 * takes anyway. It stays shadowed for the life of the page, because the
 * button reads it again every time it is clicked.
 *
 * `createXRButton` no longer needs this: it builds freedom's own button, which
 * makes an offer only when a page asks for one and only from a session state
 * of rest (see `createSessionButton`). This is still exported for a page that
 * mounts three's buttons itself, which is the only way that hazard is still
 * reachable from here.
 *
 * @returns {() => void} Puts it back.
 */
export function suppressSessionOffers() {
  const xr = /** @type {(XRSystem & { offerSession?: unknown }) | undefined} */ (navigator.xr);
  if (!xr || typeof xr.offerSession !== "function") {
    return () => {};
  }
  const own = Object.getOwnPropertyDescriptor(xr, "offerSession");
  try {
    Object.defineProperty(xr, "offerSession", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  } catch {
    // A runtime that will not let go of it keeps it; nothing else here
    // depends on having won.
    return () => {};
  }
  return () => {
    if (own) {
      Object.defineProperty(xr, "offerSession", own);
    } else {
      // It came from the prototype, and deleting the shadow uncovers it.
      delete xr.offerSession;
    }
  };
}

/**
 * @typedef {import('three').WebGLRenderer} WebGLRenderer
 */

/**
 * What three's `VRButton` asks for on top of whatever it was given, kept
 * because the immersive-vr fallback has been starting with them all along and
 * this is not the change to find out which of them three was relying on.
 * `layers` is the one that would be missed: three reaches for an
 * `XRProjectionLayer` whenever the browser has `XRWebGLBinding`, and a session
 * that was never granted the feature is a session it cannot set up.
 */
const VR_DEFAULT_FEATURES = ["local-floor", "bounded-floor", "layers"];

/**
 * A session init with one more optional feature in it, leaving whatever the
 * caller asked for alone — including that same feature, asked for twice.
 *
 * @template {{ optionalFeatures?: string[] }} T
 * @param {T | undefined} init
 * @param {string} feature
 * @returns {T}
 */
function withOptionalFeature(init, feature) {
  const features = init?.optionalFeatures ?? [];
  return /** @type {T} */ ({
    ...init,
    optionalFeatures: features.includes(feature) ? features : [...features, feature],
  });
}

/**
 * Builds the button used to enter XR. Passthrough AR is preferred where the
 * platform can provide it, but plenty of headsets (anything without a
 * passthrough camera) only ever report support for immersive-vr, so this
 * falls back to a VR session there instead of leaving the visitor stuck on a
 * button that can never work. If neither mode is supported the button is the
 * dead-end one — "AR NOT SUPPORTED", or the link to HTTPS that is the only
 * one of those states anybody can act on.
 *
 * The button and the session state machine behind it are freedom's own rather
 * than three's `ARButton` / `VRButton`; `createSessionButton` opens with why,
 * and the short of it is that three's holds the running session in a variable
 * assigned after an `await`, so a session that ends inside that window leaves
 * the page insisting one is still running until it is reloaded. The element
 * keeps three's ids and wording, so anything selecting `#ARButton` /
 * `#VRButton` or reading the label goes on working.
 *
 * The reference space is set to `local`, whose origin is at the headset's
 * position when the session starts, rather than three's own `local-floor`
 * default, whose origin sits on the floor. Scenes here are laid out for the
 * `local` origin, so the default would put everything at floor level, well
 * below the headset's initial gaze — the session would start, but the scene
 * would appear missing.
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
 * The browser is not offered a session, which is three's own default and one a
 * Quest can get stuck on; see `suppressSessionOffers` for what that looked
 * like. `offerSession: true` asks for the browser's own Enter XR affordance,
 * and freedom makes that offer itself — only from a session state of rest, so
 * an offer never overlaps the end of the session it would replace, which is
 * the ordering that made three's a hazard.
 *
 * An uncaught error ends the session and is written onto the page, where it
 * can be read on the headset rather than guessed at from a scene that has
 * stopped moving; see `installCrashPanel`. `crashPanel: false` opts out, for
 * a page with error reporting of its own.
 *
 * Hand tracking is asked for, as an optional feature of both session kinds.
 * A hand put down on the table is reported either way — the runtime exposes
 * it as a pointer source with a target ray and a synthesised select — but
 * only with the feature does the source carry a `hand`, which is the one
 * thing that tells it apart from a controller: three's controller-model
 * factory would otherwise draw a controller for it, and no joint ever
 * arrives. A headset without hands ignores the request. `handTracking:
 * false` leaves it out.
 *
 * The AR session no longer asks for `dom-overlay`, which three's `ARButton`
 * added along with an empty `<div>` on the page and a close cross drawn into
 * it. Nothing here ever used it: these are headset apps, where the overlay is
 * not shown and the session is left through the system menu, and the cross was
 * one more thing reading the session variable that this button exists to stop
 * trusting. A page that wants one can ask for the feature and pass its own
 * `domOverlay` root through `ar`.
 *
 * @param {WebGLRenderer} renderer
 * @param {{
 *   ar?: XRSessionInit;
 *   vr?: XRSessionInit;
 *   anchor?: boolean;
 *   frameRate?: FrameRatePreference | false;
 *   offerSession?: boolean;
 *   crashPanel?: boolean;
 *   handTracking?: boolean;
 * }} [sessionInit]
 * @returns {Promise<HTMLElement>}
 */
export async function createXRButton(renderer, sessionInit = {}) {
  if (sessionInit.handTracking !== false) {
    sessionInit = {
      ...sessionInit,
      ar: withOptionalFeature(sessionInit.ar, "hand-tracking"),
      vr: withOptionalFeature(sessionInit.vr, "hand-tracking"),
    };
  }
  renderer.xr.setReferenceSpaceType("local");
  if (sessionInit.anchor !== false) {
    anchorToViewer(renderer);
  }
  if (sessionInit.frameRate !== false) {
    requestFrameRate(renderer, sessionInit.frameRate);
  }
  if (sessionInit.crashPanel !== false) {
    installCrashPanel(renderer);
  }
  const offerSession = sessionInit.offerSession === true;
  const xr = navigator.xr;
  if (xr) {
    if (await xr.isSessionSupported("immersive-ar").catch(() => false)) {
      return createSessionButton(renderer, {
        mode: "immersive-ar",
        init: sessionInit.ar,
        offerSession,
      });
    }
    if (await xr.isSessionSupported("immersive-vr").catch(() => false)) {
      let vr = sessionInit.vr;
      for (const feature of VR_DEFAULT_FEATURES) {
        vr = withOptionalFeature(vr, feature);
      }
      return createSessionButton(renderer, { mode: "immersive-vr", init: vr, offerSession });
    }
  }
  return createUnsupportedButton("immersive-ar");
}
