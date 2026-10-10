/**
 * Part of the `?realfocus` experiment: a log, at the bottom of the card,
 * of what the page hears while a field has its focus in a session. It is
 * inside the element the scene mirrors, so it can be read in the headset,
 * where there are no dev tools.
 *
 * What it is for is telling, on the device, whether the system's own
 * keyboard came up and whether keys reach the page:
 *
 * - `navigator.virtualKeyboard`, Chromium's API for an on-screen
 *   keyboard, and the rectangle its `geometrychange` reports;
 * - every `keydown` on the page, the browser's own (`isTrusted`) told
 *   apart from the ones freedom's keyboard dispatches;
 * - `focusin` and `focusout` in the card;
 * - the window and the visual viewport changing size.
 */

/** The part of Chromium's VirtualKeyboard API the log reads. */
interface VirtualKeyboard extends EventTarget {
  overlaysContent: boolean;
  boundingRect: DOMRect;
}

/** How many lines the log keeps; older ones scroll off the top. */
const LINES = 14;

/**
 * Append the log to `root` and start writing to it. Returns a function
 * that stops listening and takes the log out again.
 */
export function mountFocusDiagnostics(root: HTMLElement): () => void {
  const log = document.createElement("pre");
  log.style.cssText = [
    "box-sizing: border-box",
    "width: 100%",
    "margin: 0.5rem 0 0",
    "padding: 0.5rem",
    "font: 13px/1.35 monospace",
    "white-space: pre-wrap",
    "color: #d8f5d0",
    "background: #1b1f1a",
    "border-radius: 0.4rem",
  ].join(";");
  root.append(log);

  const lines: string[] = [];
  const write = (line: string) => {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    lines.push(`${time} ${line}`);
    lines.splice(0, Math.max(0, lines.length - LINES));
    log.textContent = lines.join("\n");
  };

  const describe = (target: EventTarget | null) =>
    target instanceof Element
      ? target.tagName.toLowerCase() + (target.id ? `#${target.id}` : "")
      : target === window
        ? "window"
        : String(target);

  const disposers: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, handler: (event: Event) => void) => {
    target.addEventListener(type, handler, true);
    disposers.push(() => target.removeEventListener(type, handler, true));
  };

  const keyboard = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard;
  if (keyboard) {
    // Without this the browser resizes the page for the keyboard and does
    // not report the rectangle. It is page-wide, so it is put back with the
    // log.
    const overlaid = keyboard.overlaysContent;
    keyboard.overlaysContent = true;
    disposers.push(() => {
      keyboard.overlaysContent = overlaid;
    });
    write("virtualKeyboard: present, overlaysContent set");
    listen(keyboard, "geometrychange", () => {
      const { x, y, width, height } = keyboard.boundingRect;
      write(`geometrychange: x=${x} y=${y} ${width}x${height}`);
    });
  } else {
    write("virtualKeyboard: absent");
  }

  listen(window, "keydown", (event) => {
    const { key, code, isTrusted } = event as KeyboardEvent;
    write(
      `keydown ${JSON.stringify(key)} ${code || "-"} ${isTrusted ? "TRUSTED" : "scripted"} ` +
        `on ${describe(event.target)}, active ${describe(document.activeElement)}`,
    );
  });
  listen(root, "focusin", (event) => write(`focusin ${describe(event.target)}`));
  listen(root, "focusout", (event) => write(`focusout ${describe(event.target)}`));
  listen(window, "resize", () => write(`window resize ${innerWidth}x${innerHeight}`));
  const viewport = window.visualViewport;
  if (viewport) {
    listen(viewport, "resize", () =>
      write(`visualViewport resize ${Math.round(viewport.width)}x${Math.round(viewport.height)}`),
    );
  }

  return () => {
    disposers.forEach((dispose) => dispose());
    log.remove();
  };
}
