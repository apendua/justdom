/**
 * Getting a Web Audio context to make a sound at all, which a browser allows
 * only once the player has done something to the page.
 *
 * A context made before then, as an `AudioListener` made while the scene is
 * built is, starts `suspended`, and sources started on it stay silent until
 * someone calls `resume()` within a gesture's grace. Chromium gives a gesture
 * five seconds of grace; Safari on iOS gives the handler of the gesture
 * itself and not much more. Nothing else resumes a context: starting a
 * source on a suspended one leaves it suspended.
 */

/**
 * The events that count as the player doing something to the page. Only
 * events that grant user activation are any use here: a touch's `pointerdown`
 * does not grant it in Chromium, while its `pointerup` and `touchend` do,
 * which is why the list is of ends and not of starts.
 */
const PAGE_GESTURES = ["pointerup", "touchend", "click", "keydown"];

/**
 * The event that counts as the player doing something inside an XR session,
 * where the page sees no pointer or key at all: a trigger pull or a pinch.
 */
const SESSION_GESTURES = ["select"];

/**
 * @typedef {Pick<BaseAudioContext, "state" | "addEventListener" | "removeEventListener"> & {
 *   resume: () => Promise<void>,
 * }} ResumableContext
 */

/**
 * @typedef {object} UnlockTargets
 * @property {EventTarget} [page] Where the page's gestures are heard, the
 *   document by default.
 * @property {EventTarget | null} [session] An XR session whose `select`
 *   counts as a gesture too.
 */

/**
 * Asks `context` to resume now, and again on every gesture after this, until
 * it is running or the returned function is called.
 *
 * The rules, for every state the context can be in:
 *
 * - Already `running`: nothing is asked and nothing is listened to.
 * - `suspended`: `resume()` is called at once, which works when this runs
 *   within a gesture's grace, as it does right after the Enter button
 *   started a session in Chromium. Then every gesture on `page` or
 *   `session` calls it again, from inside the gesture's own handler, which
 *   is the one place Safari on iOS accepts it.
 * - Turned `running`, by any of those or by anything else: the listeners
 *   come off, and nothing is asked again. A context that is suspended again
 *   later, by the system taking the audio away, is not followed: that is a
 *   new call's business.
 * - `closed`: nothing is asked and nothing is listened to, since a closed
 *   context never resumes.
 * - The returned function called: the listeners come off, whatever the
 *   state. Calling it again does nothing.
 *
 * It also tells Safari on iOS that the page plays audio (`navigator.audioSession`,
 * Safari 17 on). Otherwise Web Audio there is treated as the page's ambient
 * noise and the ring/silent switch mutes it, while an `<audio>` element on
 * the same phone plays through.
 *
 * @param {ResumableContext} context
 * @param {UnlockTargets} [targets]
 * @returns {() => void} Stops listening.
 */
export function unlockAudio(context, { page = globalThis.document, session = null } = {}) {
  playThroughSilentSwitch();
  if (context.state !== "suspended") {
    return () => {};
  }

  /** @type {[EventTarget, string[]][]} */
  const targets = [];
  if (page) {
    targets.push([page, PAGE_GESTURES]);
  }
  if (session) {
    targets.push([session, SESSION_GESTURES]);
  }

  const resume = () => {
    // A context that will not resume rejects, and the next gesture tries
    // again; the rejection itself has nothing to say.
    void context.resume().catch(() => {});
  };
  const onStateChange = () => {
    if (context.state !== "suspended") {
      stop();
    }
  };
  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    context.removeEventListener("statechange", onStateChange);
    for (const [target, events] of targets) {
      for (const event of events) {
        target.removeEventListener(event, resume);
      }
    }
  };

  context.addEventListener("statechange", onStateChange);
  for (const [target, events] of targets) {
    for (const event of events) {
      target.addEventListener(event, resume);
    }
  }
  resume();
  return stop;
}

/**
 * Safari's `navigator.audioSession`, set to `playback` once: what an
 * `<audio>` element gets on its own, and Web Audio only when asked.
 */
function playThroughSilentSwitch() {
  const audioSession = /** @type {{ audioSession?: { type: string } }} */ (
    /** @type {unknown} */ (globalThis.navigator)
  )?.audioSession;
  if (audioSession && audioSession.type !== "playback") {
    audioSession.type = "playback";
  }
}
