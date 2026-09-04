/**
 * @typedef {import('three').WebGLRenderer} WebGLRenderer
 */

/** The id the panel is mounted under, for anyone who wants to find it. */
export const CRASH_PANEL_ID = "freedom-crash-panel";

/**
 * The panel installed for a renderer, if there is one.
 *
 * @type {WeakMap<WebGLRenderer, (err: unknown) => void>}
 */
const reporters = new WeakMap();

/**
 * Hand a failure straight to the renderer's crash panel, without waiting for
 * the host to report it.
 *
 * The window's `error` event is not a reliable way to hear about a throw from
 * inside an XR frame callback, which is the failure that matters most here.
 * The spec says the runtime must "report the exception", meaning fire that
 * event -- but a callback runs behind whatever is driving the session, and a
 * driver that catches is a driver the event never fires for. The XR emulator
 * these apps are developed against is exactly that: it wraps every frame
 * callback in a `try`/`catch` and writes the error to the console, so a crash
 * that a headset would report was invisible in a tab. Rather than depend on
 * that, freedom's frame loop catches its own failures and says so here.
 *
 * @param {WebGLRenderer} renderer
 * @param {unknown} err
 * @returns {boolean} Whether anything was listening.
 */
export function reportCrash(renderer, err) {
  const report = reporters.get(renderer);
  if (!report) {
    return false;
  }
  report(err);
  return true;
}

/**
 * Puts an uncaught error where the player can read it: on the page, with the
 * headset given back.
 *
 * Inside an immersive session an uncaught exception is invisible. The
 * console is on a desk somewhere, not in front of the player, and the
 * failure itself does not look like one: three requests the next frame only
 * after the current callback has returned, so a throw from the frame loop
 * ends the loop, and what the player sees is the scene standing still, or
 * nothing, with no way to tell which it is or why. Everything a failure has
 * to say is on the page, and the page is not being shown.
 *
 * So the session is ended — that puts the browser back on screen — and the
 * error is written into a panel on top of the page, message and stack, where
 * it can be read on the headset and photographed for a bug report. Uncaught
 * exceptions and unhandled rejections both count: three's own XR buttons
 * request a session with a bare `.then`, so a refused session is a rejection
 * nobody hears, and it is exactly the failure a device that will not start
 * an app needs explained.
 *
 * The panel is built on the first error and not before, so a page that does
 * not crash is left exactly as it was. Every further error is appended until
 * the panel is dismissed, and the next error after that opens a fresh one.
 *
 * Installed by `createXRButton` for every app; `crashPanel: false` opts out.
 *
 * @param {WebGLRenderer} renderer
 * @param {{ root?: HTMLElement }} [options] Where the panel is mounted.
 *   `document.body` unless told otherwise.
 * @returns {() => void} Stops listening and takes the panel down.
 */
export function installCrashPanel(renderer, options = {}) {
  /** @type {HTMLElement | null} */
  let panel = null;
  /** @type {HTMLElement | null} */
  let entries = null;
  let reporting = false;

  const mount = () => {
    const root = options.root ?? document.body;
    panel = document.createElement("section");
    panel.id = CRASH_PANEL_ID;
    panel.setAttribute("role", "alert");
    panel.style.cssText = [
      "position: fixed",
      "top: 0",
      "left: 0",
      "right: 0",
      "max-height: 70vh",
      "overflow: auto",
      "box-sizing: border-box",
      "padding: 12px 16px",
      "background: rgba(40, 0, 0, 0.95)",
      "color: #fff",
      "font: 14px/1.4 monospace",
      "z-index: 2147483647",
    ].join("; ");

    const header = document.createElement("header");
    header.style.cssText = "display: flex; align-items: center; gap: 12px; margin-bottom: 8px";
    const title = document.createElement("strong");
    title.textContent = "The app crashed. The XR session was ended so this could be read.";
    title.style.flex = "1";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.style.cssText = "font: inherit; padding: 4px 12px";
    dismiss.addEventListener("click", unmount);
    header.append(title, dismiss);

    entries = document.createElement("div");
    panel.append(header, entries);
    root.appendChild(panel);
  };

  const unmount = () => {
    panel?.remove();
    panel = null;
    entries = null;
  };

  /**
   * @param {unknown} err
   */
  const report = (err) => {
    // A failure while reporting a failure — a `sessionend` handler that
    // throws, say — would come straight back here. One report at a time.
    if (reporting) {
      return;
    }
    reporting = true;
    try {
      // The session first: the page is what the player is about to look at.
      const session = renderer.xr.getSession();
      if (session) {
        Promise.resolve(session.end()).catch(() => {});
      }
      if (!panel) {
        mount();
      }
      const entry = document.createElement("pre");
      entry.style.cssText = "margin: 0 0 12px; white-space: pre-wrap; word-break: break-word";
      entry.textContent = describe(err);
      entries?.appendChild(entry);
    } finally {
      reporting = false;
    }
  };

  /** @param {ErrorEvent} event */
  const onError = (event) => {
    // A script from another origin reports nothing but "Script error.", and
    // `error` is null; the message is all there is then.
    report(event.error ?? event.message);
  };
  /** @param {PromiseRejectionEvent} event */
  const onRejection = (event) => {
    report(event.reason);
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  // What `reportCrash` finds: the frame loop's failures come straight here
  // rather than round through the window, which may never hear about them.
  reporters.set(renderer, report);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    reporters.delete(renderer);
    unmount();
  };
}

/**
 * The error as one block of text: name, message and stack. Chrome's `stack`
 * already opens with the name and message and Firefox's does not, so the
 * message is put in front only where it is missing.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describe(err) {
  if (err instanceof Error) {
    const headline = `${err.name}: ${err.message}`;
    const { stack } = err;
    if (!stack) {
      return headline;
    }
    return stack.includes(err.message) ? stack : `${headline}\n${stack}`;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
