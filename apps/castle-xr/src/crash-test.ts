/**
 * A crash on purpose, so the crash panel can be tried end to end.
 *
 * TEMPORARY. This file and the single call in `App.ts` are here to be reverted
 * before the branch merges — the app is not supposed to throw five seconds
 * into a session.
 *
 * What it is for: the panel `installCrashPanel` puts up is the only thing a
 * player in a headset sees when something throws, and there is no way to know
 * it works — that the session really is handed back, that the stack really is
 * readable, that Copy really does reach the clipboard — without a crash to
 * look at. Deployed on a preview, where the source maps are, the stack should
 * name this file and these functions rather than a column in a minified chunk.
 *
 * The query string picks which failure, since the panel listens for three:
 *
 * - `?crash=off` — no crash; the game as it normally is.
 * - `?crash=frame` (the default) — a throw from inside the frame loop, which
 *   is the one that needs freedom's own catch: an XR frame callback's throw is
 *   not reliably reported to the window.
 * - `?crash=reject` — an unhandled rejection.
 * - `?crash=timer` — a throw from a timer, which reaches the panel by the
 *   window's `error` event.
 */

import { getXRSession, useFrame } from "@apendua/freedom";

/** Long enough to have the headset on and be looking at the board. */
const CRASH_AFTER_MS = 5000;

const crashKinds = ["off", "frame", "reject", "timer"] as const;

type CrashKind = (typeof crashKinds)[number];

function requestedCrash(): CrashKind {
  const requested = new URLSearchParams(location.search).get("crash");
  if (requested === null) {
    return "frame";
  }
  return (crashKinds as readonly string[]).includes(requested) ? (requested as CrashKind) : "frame";
}

function knockTheCastleOver(): void {
  throw new Error(
    "Simulated crash from castle-xr. This is deliberate — open the app with ?crash=off for the game.",
  );
}

/**
 * A frame of app code between the loop and the throw, so the stack has
 * something in it for a source map to be right or wrong about.
 */
function crashOnPurpose(): void {
  knockTheCastleOver();
}

/**
 * Arms the crash. Call it from an `effects` block: it reads the session, so it
 * re-arms when one starts and disarms when it ends, and nothing happens on the
 * page before the player has gone in.
 */
export function simulateCrash(ctx: WeakKey): void {
  const kind = requestedCrash();
  if (kind === "off") {
    return;
  }
  const xrSession = getXRSession(ctx);
  if (!xrSession) {
    return;
  }

  const due = performance.now() + CRASH_AFTER_MS;
  let fired = false;

  useFrame(ctx, () => {
    if (fired || performance.now() < due) {
      return;
    }
    fired = true;
    switch (kind) {
      case "reject":
        void Promise.reject(new Error("Simulated unhandled rejection from castle-xr."));
        return;
      case "timer":
        setTimeout(crashOnPurpose);
        return;
      default:
        crashOnPurpose();
    }
  });
}
