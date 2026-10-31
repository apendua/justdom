/**
 * @typedef {import('three').WebGLRenderer} WebGLRenderer
 */

/** The id the panel is mounted under, for anyone who wants to find it. */
export const CRASH_PANEL_ID = "freedom-crash-panel";

/** How long the copy button says what happened before going back to "Copy". */
const COPIED_MS = 2000;

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
 * One kind of error is left alone: the muted `"Script error."` a browser
 * reports for a script from another origin, which is contentless by
 * construction and never the app's own code. See `isMuted` for why taking
 * those turned every hidden tab into a crash report.
 *
 * The panel is built on the first error and not before, so a page that does
 * not crash is left exactly as it was. Every further error is appended until
 * the panel is dismissed, and the next error after that opens a fresh one.
 *
 * A stack read off a headset is a stack retyped by hand, so the panel also
 * carries a Copy button: everything it is showing, as text, on the clipboard,
 * ready to be pasted into a bug report from whatever the headset shares a
 * clipboard with. Where there is no clipboard to write to — a page served
 * over plain http, a browser that will not — the text is selected instead,
 * which leaves the browser's own copy within reach.
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
  /** Whether the console has already been told about a muted error. */
  let warnedAboutMuted = false;
  /** And about a resize-observation loop, which is reported the same way. */
  let warnedAboutResizeLoop = false;
  /** What the open panel is showing, in the order it was reported. */
  /** @type {string[]} */
  let reported = [];
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let relabel;

  /**
   * The panel's text on the clipboard. Nothing is thrown from here: a copy
   * that fails is a copy that says so on the button, not a second crash on
   * top of the one being read.
   *
   * @param {HTMLButtonElement} button
   */
  const copy = async (button) => {
    let told = "Copy failed";
    try {
      await navigator.clipboard.writeText(reported.join("\n\n"));
      told = "Copied";
    } catch {
      // No clipboard: an insecure page, or a headset browser that will not.
      // Selecting the text puts the browser's own copy within reach.
      told = selectEntries() ? "Copy it now" : "Copy failed";
    }
    button.textContent = told;
    clearTimeout(relabel);
    relabel = setTimeout(() => {
      button.textContent = "Copy";
    }, COPIED_MS);
  };

  /**
   * @returns {boolean} Whether the text ended up selected.
   */
  const selectEntries = () => {
    const selection = entries && window.getSelection?.();
    if (!entries || !selection) {
      return false;
    }
    try {
      const range = document.createRange();
      range.selectNodeContents(entries);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch {
      return false;
    }
  };

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
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.dataset.action = "copy";
    copyButton.textContent = "Copy";
    copyButton.style.cssText = "font: inherit; padding: 4px 12px";
    copyButton.addEventListener("click", () => {
      void copy(copyButton);
    });

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.dataset.action = "dismiss";
    dismiss.textContent = "Dismiss";
    dismiss.style.cssText = "font: inherit; padding: 4px 12px";
    dismiss.addEventListener("click", unmount);
    header.append(title, copyButton, dismiss);

    entries = document.createElement("div");
    panel.append(header, entries);
    root.appendChild(panel);
  };

  const unmount = () => {
    clearTimeout(relabel);
    relabel = undefined;
    panel?.remove();
    panel = null;
    entries = null;
    reported = [];
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
      const text = describe(err);
      const entry = document.createElement("pre");
      entry.style.cssText = "margin: 0 0 12px; white-space: pre-wrap; word-break: break-word";
      entry.textContent = text;
      entries?.appendChild(entry);
      reported.push(text);
    } finally {
      reporting = false;
    }
  };

  /** @param {ErrorEvent} event */
  const onError = (event) => {
    if (isResizeLoop(event)) {
      // Not a crash at all — see `isResizeLoop`. Said once, to the console,
      // because the layout that produced it will go on producing it.
      if (!warnedAboutResizeLoop) {
        warnedAboutResizeLoop = true;
        console.warn(
          `freedom: ignoring "${event.message}" — the browser deferred some resize` +
            " notifications to the next frame. Nothing threw, so the crash panel stays down and" +
            " the session stays up. Something is resizing what it observes; worth fixing, but" +
            " not by ending the session.",
        );
      }
      return;
    }
    if (isMuted(event)) {
      // Not ours, and nothing to show. Said once, to the console, because a
      // page whose neighbour throws every frame does not need it said again.
      if (!warnedAboutMuted) {
        warnedAboutMuted = true;
        console.warn(
          'freedom: ignoring "Script error." — a script from another origin threw, and the' +
            " browser withholds everything about it. It is not this app's crash, so the crash" +
            " panel stays down. The browser's own console has the real error.",
        );
      }
      return;
    }
    // Not every error arrives with an `Error` behind it, and the message on
    // its own does not say where it came from. Where the browser named the
    // file, the report says so too.
    report(event.error ?? locate(event));
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
 * Whether this is the browser complaining about a resize-observation loop
 * rather than reporting a failure.
 *
 * A `ResizeObserver` callback that changes the size of something being
 * observed makes the browser go round again, and when the round is not
 * settled by the end of the delivery it says so on the window: "ResizeObserver
 * loop completed with undelivered notifications." in current browsers,
 * "ResizeObserver loop limit exceeded" in older ones. It arrives as an `error`
 * event because that is the only channel the spec has for it — there is no
 * exception behind it, `error` is null, and the file it names is the document
 * itself rather than any script. Nothing has gone wrong that ending a session
 * would help with: the deferred notifications are delivered on the next frame,
 * and the page carries on.
 *
 * The panel has to know that, because the alternative is what this was written
 * for: a scrolling list whose bar appears when there is something to scroll
 * takes space out of the row the window sits in, so the observer that noticed
 * the window had been laid out resized the window — one notice, and an app in
 * a headset was put back on the desktop with a crash report over it. The
 * widget no longer does that (see `scrollable` in `justdom-three-ui`), but
 * anything a page mounts can, and none of it is this app crashing.
 *
 * `isMuted` does not cover it: the browser names the document as the file, so
 * the event is not the contentless one a cross-origin script produces.
 *
 * @param {ErrorEvent} event
 * @returns {boolean}
 */
function isResizeLoop(event) {
  return event.error == null && /^ResizeObserver loop\b/.test(event.message ?? "");
}

/**
 * Whether the browser is refusing to say anything about this one.
 *
 * A script from another origin throws behind a curtain. The HTML spec has the
 * browser *mute* the report rather than leak a stranger's source across an
 * origin boundary, and what reaches the page is a fixed, contentless event:
 * the message is exactly `"Script error."`, `error` is null, and the file,
 * line and column are empty. Nothing distinguishes one such failure from
 * another, and nothing in it can be acted on.
 *
 * It is also never this app's. Everything freedom's apps ship is served from
 * the page's own origin, so their throws arrive here with the `Error` itself,
 * stack and all — as does anything a browser extension injects, which the
 * browser attributes to its `chrome-extension://` file. A muted report means
 * some script the app does not control failed: an analytics or captcha
 * beacon, something a browser puts in the page for a feature of its own.
 * Those tend to fire on lifecycle moments a player can produce at will —
 * hiding the tab is the usual one, so opening the browser's share sheet, or
 * switching apps, would raise the panel with "Script error." in it every
 * time, over an app that was running perfectly.
 *
 * So the panel does not take them. Its whole promise is that what it shows is
 * both real and readable, and a muted error is neither.
 *
 * @param {ErrorEvent} event
 * @returns {boolean}
 */
function isMuted(event) {
  return event.error == null && !event.filename && !event.lineno && !event.colno && !!event.message;
}

/**
 * An error event with no `Error` behind it, as text: the message, and where
 * the browser says it happened.
 *
 * @param {ErrorEvent} event
 * @returns {string}
 */
function locate(event) {
  const message = event.message || "An error with no message";
  if (!event.filename) {
    return message;
  }
  return `${message}\n    at ${event.filename}:${event.lineno}:${event.colno}`;
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
