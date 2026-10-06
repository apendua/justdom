/**
 * The door into XR: the button, and the session state machine behind it.
 *
 * three's `ARButton` and `VRButton` are the obvious things to build this on,
 * and freedom did, until the state they keep turned out to be the thing that
 * strands a headset. Both hold the running session in a closure variable that
 * is assigned *after* an `await`:
 *
 *   async function onSessionStarted( session ) {
 *     session.addEventListener( 'end', onSessionEnded );
 *     await renderer.xr.setSession( session );   // makeXRCompatible, reference space
 *     button.textContent = 'STOP AR';
 *     currentSession = session;                  // ← only now
 *   }
 *   function onSessionEnded() {
 *     currentSession.removeEventListener( 'end', onSessionEnded );  // ← no guard
 *     button.textContent = 'START AR';
 *     currentSession = null;
 *   }
 *
 * The `end` listener is installed before the await and the variable it reads
 * is written after it, so a session that ends inside that window — or a
 * `setSession` that fails, which is the same window seen from the other end —
 * throws out of `onSessionEnded` with `currentSession` still null. The label
 * is never put back, and the resumed `onSessionStarted` then sets it to
 * `STOP AR` and points `currentSession` at a session that is already over.
 * From there the page insists a session is running for as long as it is open:
 * every later click takes the exit branch and calls `end()` on a corpse, which
 * resolves and does nothing. Only a reload clears it.
 *
 * That is the same complaint `suppressSessionOffers` was written for — a Quest
 * that goes on behaving as though it were still in a session — arriving by a
 * second route, and there is no more of an option for this one than there was
 * for that one. So the button is ours.
 *
 * What that buys, and what everything below is arranged around: **the session
 * this button knows about is only ever written synchronously.** No line that
 * assigns it sits after an `await`, every path back to idle runs through one
 * idempotent `finish`, and `finish` is reached three independent ways — the
 * session's own `end` event, `end()` settling, and the renderer disagreeing —
 * because the failure being fixed is a button that had one way and missed it.
 */
import { reportCrash } from "./crash.js";

/**
 * @typedef {import('three').WebGLRenderer} WebGLRenderer
 */

/**
 * What each mode's button says, and the id it carries. The ids and the wording
 * are three's, deliberately: screenshot scripts, benchmarks and the emulator
 * checks all select on `#ARButton` / `#VRButton` and read the label to decide
 * whether a session is up, and none of that should have to change over where
 * the element is built.
 */
const MODES = {
  "immersive-ar": {
    id: "ARButton",
    enter: "START AR",
    exit: "STOP AR",
    unsupported: "AR NOT SUPPORTED",
  },
  "immersive-vr": {
    id: "VRButton",
    enter: "ENTER VR",
    exit: "EXIT VR",
    unsupported: "VR NOT SUPPORTED",
  },
};

/**
 * @param {XRSessionMode | undefined} mode
 * @param {keyof typeof MODES} fallback
 * @returns {(typeof MODES)[keyof typeof MODES]}
 */
function wordsFor(mode, fallback) {
  return MODES[/** @type {keyof typeof MODES} */ (mode)] ?? MODES[fallback];
}

/**
 * three's own button styling, kept as it was. It is the only styling these
 * buttons have — no stylesheet in the repository mentions either id — so
 * anything less here would change how every app looks on the way in.
 *
 * @param {HTMLElement} element
 * @returns {void}
 */
function stylize(element) {
  element.style.position = "absolute";
  element.style.bottom = "20px";
  element.style.padding = "12px 6px";
  element.style.border = "1px solid #fff";
  element.style.borderRadius = "4px";
  element.style.background = "rgba(0,0,0,0.1)";
  element.style.color = "#fff";
  element.style.font = "normal 13px sans-serif";
  element.style.textAlign = "center";
  element.style.opacity = "0.5";
  element.style.outline = "none";
  element.style.zIndex = "999";
}

/**
 * Whether this page is running as an installed app rather than in a browser
 * tab -- the only place an automatic session request can succeed.
 *
 * `requestSession` needs a user activation, and a page that has just loaded
 * has none to spend. What makes the automatic path possible at all is that
 * Horizon OS counts launching an installed PWA from the library as that
 * activation; a tab was never handed one, so asking there fails on every
 * platform and would only put a refusal where a player could see it.
 *
 * `standalone` is what a Trusted Web Activity reports. A manifest may ask for
 * `fullscreen` instead, and both are installed as far as this cares. A
 * runtime with no `matchMedia` at all -- jsdom, a worker -- is not an
 * installed app either, which keeps the automatic path off wherever it could
 * not have worked.
 *
 * @returns {boolean}
 */
function isInstalledApp() {
  const media = globalThis.matchMedia;
  if (typeof media !== "function") {
    return false;
  }
  return ["standalone", "fullscreen"].some((mode) => {
    try {
      return media.call(globalThis, `(display-mode: ${mode})`).matches;
    } catch {
      // A runtime that has the method and will not answer for this query.
      return false;
    }
  });
}

/**
 * The state a session button can be in. `requesting` and `ending` are the two
 * that matter: they are the windows in which a second click would otherwise
 * open a second session, or end the same one twice.
 *
 * @typedef {"idle" | "requesting" | "presenting" | "ending"} Phase
 */

/**
 * @typedef {object} SessionButtonOptions
 * @property {XRSessionMode} mode Which kind of session the button asks for.
 * @property {XRSessionInit} [init] What to ask for it with.
 * @property {boolean} [offerSession] Let the browser hold a standing offer of
 *   a session, so it can put an Enter XR affordance in its own chrome and open
 *   one without the button being touched. Off by default. The offer is only
 *   ever made from idle — never alongside `end()`, which is the ordering that
 *   stranded a Quest and the reason three's version of this is not used.
 * @property {boolean} [autoEnter] Ask for the session as soon as the button is
 *   built, without waiting for a click. Off by default, and ignored outside an
 *   installed app -- see `isInstalledApp`. The button is still built and still
 *   returned: an automatic request is an attempt, never a replacement for the
 *   way in, because a refused one that left no button would be a black screen
 *   with nothing to press.
 */

/**
 * Builds the button for a mode the platform supports, wired to a session state
 * machine that cannot be left claiming a session that is over.
 *
 * @param {WebGLRenderer} renderer
 * @param {SessionButtonOptions} options
 * @returns {HTMLButtonElement}
 */
export function createSessionButton(
  renderer,
  { mode, init, offerSession = false, autoEnter = false },
) {
  const words = wordsFor(mode, "immersive-vr");
  const button = document.createElement("button");
  button.id = words.id;
  button.type = "button";
  stylize(button);
  button.style.cursor = "pointer";
  button.style.left = "calc(50% - 50px)";
  button.style.width = "100px";

  /**
   * The session being presented, or null. Written synchronously, always: this
   * variable is the whole of what went wrong in three's version, and the rule
   * that keeps it right is that no line assigning it may sit after an `await`.
   *
   * @type {XRSession | null}
   */
  let current = null;
  /** @type {Phase} */
  let phase = "idle";
  /** Takes the `end` listener off whatever `current` is. */
  let detach = () => {};
  /**
   * Whether a session has been presented yet, which is as far as a
   * `sessiongranted` is honoured; see the listener at the bottom.
   */
  let presented = false;

  const relabel = () => {
    button.textContent = current ? words.exit : words.enter;
  };

  /**
   * Where a failure that stops a session happening goes. A refused session is
   * the failure a headset most needs explained — the app simply does not
   * start, with the console on a desk in another room — so it goes to the
   * crash panel where there is one, which is why `installCrashPanel` listens
   * for rejections at all.
   *
   * @param {unknown} err
   * @returns {void}
   */
  const report = (err) => {
    console.error(err);
    reportCrash(renderer, err);
  };

  /**
   * A session we have decided not to present, handed back. Nothing waits on it
   * and nothing is done if it refuses: it is already the unhappy path.
   *
   * @param {XRSession} session
   * @returns {void}
   */
  const discard = (session) => {
    // `end()` on a session that is already over throws rather than rejects on
    // some runtimes, and this is called on paths where that is likely.
    try {
      Promise.resolve(session.end()).catch(() => {});
    } catch {
      // Already gone, which is what was wanted.
    }
  };

  /**
   * Back to idle. Idempotent, and keyed on the session so that a late word
   * about a session that is already forgotten says nothing.
   *
   * @param {XRSession} session
   * @returns {void}
   */
  function finish(session) {
    if (current !== session) {
      return;
    }
    detach();
    detach = () => {};
    current = null;
    phase = "idle";
    relabel();
    // Only now, with the end an accomplished fact rather than a promise
    // somebody made a moment ago. three offered the next session on the line
    // after `end()` without waiting for it, and a Quest handed an offer that
    // overlaps the session it replaces stops taking taps.
    offer();
  }

  /**
   * Take a session — from the button, from a standing offer, from a grant —
   * and put the renderer on it.
   *
   * @param {XRSession} session
   * @returns {Promise<void>}
   */
  async function present(session) {
    if (current) {
      // Two at once: a standing offer resolving while a requested session is
      // already up, most likely. The one already being drawn to wins.
      discard(session);
      return;
    }
    current = session;
    phase = "presenting";
    presented = true;
    relabel();

    // On the session itself rather than only on the renderer, and before
    // anything is awaited. `XRSession` is a real `EventTarget`, so a listener
    // that throws does not stop this one — which is not true of the renderer's
    // `sessionend`, where three's `EventDispatcher` walks its listeners with
    // nothing to catch a throw, and one bad reaction silently cancels every
    // listener behind it.
    const onEnd = () => finish(session);
    session.addEventListener("end", onEnd);
    detach = () => session.removeEventListener("end", onEnd);

    try {
      await renderer.xr.setSession(session);
    } catch (err) {
      if (current !== session) {
        // It ended while three was setting up, and three read its own
        // `session` back as null on the far side of the await. `finish` has
        // had the button back since; the rejection is the race rather than
        // anything anyone can act on.
        return;
      }
      // three could not take the session. There is nothing to draw with, so
      // the headset is handed back rather than left on a black screen with no
      // way out but the system menu.
      finish(session);
      discard(session);
      report(err);
    }
    // Nothing after the await touches `current`: if the session ended in the
    // meantime, `finish` has already run and three tore its own side down on
    // the way past, and there is nothing left here to undo.
  }

  /**
   * Ask for a session, the way the button does.
   *
   * @param {{ quiet?: boolean }} [options] `quiet` keeps a refusal off the
   *   crash panel. For the automatic request, which nobody asked for out loud:
   *   the fallback is the button, already built and sitting there, and a panel
   *   in front of a player who has not touched anything yet would be reporting
   *   a failure the next tap recovers from. It still reaches the console,
   *   which is where a refusal that turns out to be permanent is diagnosed --
   *   and the button's own request reports properly, so a real refusal still
   *   surfaces the moment the player presses it.
   * @returns {Promise<void>}
   */
  async function enter({ quiet = false } = {}) {
    const xr = navigator.xr;
    if (phase !== "idle" || !xr) {
      return;
    }
    phase = "requesting";
    /** @type {XRSession} */
    let session;
    try {
      session = await xr.requestSession(mode, init);
    } catch (err) {
      // Only if nothing else moved in the meantime: a grant or a standing
      // offer could have presented one while this was in flight.
      if (phase === "requesting") {
        phase = "idle";
        relabel();
      }
      if (quiet) {
        console.error(err);
      } else {
        report(err);
      }
      return;
    }
    await present(session);
  }

  /**
   * Hand the session back. The label is not put right here: it follows the
   * session, and the session is not over until its own `end` says so.
   *
   * @returns {void}
   */
  function exit() {
    const session = current;
    if (!session || phase === "ending") {
      return;
    }
    phase = "ending";
    void (async () => {
      try {
        await session.end();
      } catch {
        // A runtime that will not end a session — or one that throws because
        // it already has — is one nothing here can do anything about. The line
        // below is what keeps either from being a button stuck on EXIT for the
        // life of the page.
      }
      // `end()` settling means the `end` event has already been and gone, so
      // this is almost always a no-op. Almost: it is also the way back from a
      // runtime whose event never arrives.
      finish(session);
    })();
  }

  /**
   * Offer the browser a session, for a page that wants the browser's own Enter
   * XR affordance. Never while one is running, and never in the same breath as
   * ending one.
   *
   * @returns {void}
   */
  function offer() {
    const xr =
      /** @type {(XRSystem & {
       *   offerSession?: (mode: XRSessionMode, init?: XRSessionInit) => Promise<XRSession>;
       * }) | undefined} */ (navigator.xr);
    if (!offerSession || !xr || typeof xr.offerSession !== "function" || phase !== "idle") {
      return;
    }
    try {
      Promise.resolve(xr.offerSession(mode, init)).then(
        (session) => present(session),
        () => {
          // Withdrawn, superseded by a later offer, or refused. All three mean
          // the browser is not starting a session, which is not news.
        },
      );
    } catch (err) {
      // A runtime that has the method and will not take the offer. The page
      // still has its button, which is the part that matters.
      console.error(err);
    }
  }

  button.addEventListener("click", () => {
    if (current) {
      exit();
    } else {
      // Both halves report what they cannot do; this is only here so that a
      // fault nobody anticipated is loud rather than an unhandled rejection.
      enter().catch((err) => console.error(err));
    }
  });
  button.addEventListener("mouseenter", () => {
    button.style.opacity = "1.0";
  });
  button.addEventListener("mouseleave", () => {
    button.style.opacity = "0.5";
  });

  // The third way back to idle, and the one that covers a session this button
  // never handed out: the crash panel ends one of its own accord, and so could
  // anything else holding the renderer. `getSession()` is the renderer's own
  // answer, so this can only ever agree with it.
  renderer.xr.addEventListener("sessionend", () => {
    if (current && !renderer.xr.getSession()) {
      finish(current);
    }
  });

  // A session the browser granted without being asked: the page was navigated
  // to from inside an immersive context and is expected to carry on there.
  // Honoured only before the first session, which is as far as three took it
  // and as far as it is safe to take it — a grant honoured after an exit would
  // walk straight back into the headset the player just left.
  navigator.xr?.addEventListener?.("sessiongranted", () => {
    if (!presented && phase === "idle") {
      enter().catch((err) => console.error(err));
    }
  });

  relabel();
  offer();

  // Last of all, and deliberately: the button exists and is about to be
  // returned, so a refusal here leaves the player something to press rather
  // than nothing. A standing offer has already been made if the page wanted
  // one, and if it resolves alongside this request `present` discards
  // whichever session arrives second.
  if (autoEnter && isInstalledApp()) {
    enter({ quiet: true }).catch((err) => console.error(err));
  }

  return button;
}

/**
 * The button for a platform that cannot open a session at all: three's own
 * dead-end states, kept because they are the ones people have seen.
 *
 * A page served over plain HTTP gets a link to itself over HTTPS, which is the
 * one of these that is actually actionable; a browser without WebXR gets a
 * link to what WebXR is; and a runtime that supports neither immersive mode
 * gets a disabled button saying so.
 *
 * @param {XRSessionMode} [mode] Whose wording to use for a runtime that has
 *   WebXR and supports neither immersive mode.
 * @returns {HTMLElement}
 */
export function createUnsupportedButton(mode = "immersive-ar") {
  if (!("xr" in navigator)) {
    const message = document.createElement("a");
    if (window.isSecureContext === false) {
      message.href = document.location.href.replace(/^http:/, "https:");
      message.textContent = "WEBXR NEEDS HTTPS";
    } else {
      message.href = "https://immersiveweb.dev/";
      message.textContent = "WEBXR NOT AVAILABLE";
    }
    stylize(message);
    message.style.textDecoration = "none";
    message.style.left = "calc(50% - 90px)";
    message.style.width = "180px";
    return message;
  }
  const words = wordsFor(mode, "immersive-ar");
  const button = document.createElement("button");
  button.id = words.id;
  button.type = "button";
  button.disabled = true;
  stylize(button);
  button.style.cursor = "auto";
  button.style.left = "calc(50% - 75px)";
  button.style.width = "150px";
  button.textContent = words.unsupported;
  return button;
}
