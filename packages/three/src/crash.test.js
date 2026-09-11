import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CRASH_PANEL_ID,
  describe as describeError,
  installCrashPanel,
  reportCrash,
} from "./crash.js";

/**
 * @typedef {import('three').WebGLRenderer} WebGLRenderer
 */

// The panel talks to two browser things: the window's error events and the
// renderer's current session. jsdom supplies the first; the second is a fake
// that only remembers whether it was ended.

/**
 * @param {boolean} presenting
 */
function fakeRenderer(presenting) {
  const state = { ended: 0 };
  const session = {
    end: async () => {
      state.ended++;
    },
  };
  const renderer = {
    xr: {
      getSession: () => (presenting ? session : null),
    },
  };
  return { state, renderer: /** @type {WebGLRenderer} */ (/** @type {unknown} */ (renderer)) };
}

/**
 * @param {unknown} error
 */
function throwUncaught(error) {
  window.dispatchEvent(
    new window.ErrorEvent("error", {
      error,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * @param {unknown} reason
 */
function rejectUnhandled(reason) {
  // jsdom has no PromiseRejectionEvent; a plain event wearing a `reason` is
  // all the handler reads.
  window.dispatchEvent(Object.assign(new window.Event("unhandledrejection"), { reason }));
}

function panel() {
  return document.getElementById(CRASH_PANEL_ID);
}

/**
 * @param {string} action
 * @returns {HTMLButtonElement | null}
 */
function button(action) {
  return /** @type {HTMLButtonElement | null} */ (
    document.querySelector(`#${CRASH_PANEL_ID} button[data-action="${action}"]`)
  );
}

/**
 * Hands the panel a clipboard, or takes the one it has away. jsdom ships no
 * `navigator.clipboard` at all, which is the same thing the panel sees on a
 * page that is not allowed one.
 *
 * @param {{ writeText: (text: string) => Promise<void> } | null} clipboard
 */
function withClipboard(clipboard) {
  const had = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  if (clipboard) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  } else {
    delete (/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (navigator)).clipboard);
  }
  return () => {
    if (had) {
      Object.defineProperty(navigator, "clipboard", had);
    } else {
      delete (
        /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (navigator)).clipboard
      );
    }
  };
}

/** Lets the copy button's promise settle before the assertions run. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("installCrashPanel", () => {
  /** @type {(() => void)[]} */
  const installed = [];

  afterEach(() => {
    for (const uninstall of installed.splice(0)) {
      uninstall();
    }
    assert.equal(panel(), null);
  });

  test("ends the session and writes the error onto the page", () => {
    const { state, renderer } = fakeRenderer(true);
    installed.push(installCrashPanel(renderer));
    assert.equal(panel(), null, "nothing is mounted until something goes wrong");

    throwUncaught(new Error("the scene fell over"));

    assert.equal(state.ended, 1);
    const shown = panel();
    assert.ok(shown);
    assert.match(shown.textContent ?? "", /the scene fell over/);
  });

  test("reports an unhandled rejection the same way", () => {
    const { state, renderer } = fakeRenderer(true);
    installed.push(installCrashPanel(renderer));

    rejectUnhandled(new Error("the runtime said no"));

    assert.equal(state.ended, 1);
    assert.match(panel()?.textContent ?? "", /the runtime said no/);
  });

  test("shows the error on a page with no session to end", () => {
    const { renderer } = fakeRenderer(false);
    installed.push(installCrashPanel(renderer));

    throwUncaught(new Error("still a crash"));

    assert.match(panel()?.textContent ?? "", /still a crash/);
  });

  test("appends later errors to the same panel", () => {
    const { renderer } = fakeRenderer(false);
    installed.push(installCrashPanel(renderer));

    throwUncaught(new Error("first"));
    throwUncaught(new Error("second"));

    const shown = panel();
    assert.ok(shown);
    assert.equal(document.querySelectorAll(`#${CRASH_PANEL_ID} pre`).length, 2);
    assert.match(shown.textContent ?? "", /first[\s\S]*second/);
  });

  test("dismissing takes the panel down, and the next error opens a fresh one", () => {
    const { renderer } = fakeRenderer(false);
    installed.push(installCrashPanel(renderer));

    throwUncaught(new Error("first"));
    const dismiss = button("dismiss");
    assert.ok(dismiss);
    dismiss.click();
    assert.equal(panel(), null);

    throwUncaught(new Error("second"));
    const shown = panel();
    assert.ok(shown);
    assert.doesNotMatch(shown.textContent ?? "", /first/);
    assert.match(shown.textContent ?? "", /second/);
  });

  test("copies everything the panel is showing", async () => {
    /** @type {string[]} */
    const written = [];
    const restore = withClipboard({
      writeText: async (text) => {
        written.push(text);
      },
    });
    try {
      const { renderer } = fakeRenderer(false);
      installed.push(installCrashPanel(renderer));

      throwUncaught(new Error("first"));
      throwUncaught(new Error("second"));
      const copy = button("copy");
      assert.ok(copy);
      copy.click();
      await flush();

      assert.equal(written.length, 1);
      assert.match(written[0] ?? "", /first[\s\S]*second/);
      assert.equal(copy.textContent, "Copied");
    } finally {
      restore();
    }
  });

  test("copies the fresh panel's errors only, not the dismissed one's", async () => {
    /** @type {string[]} */
    const written = [];
    const restore = withClipboard({
      writeText: async (text) => {
        written.push(text);
      },
    });
    try {
      const { renderer } = fakeRenderer(false);
      installed.push(installCrashPanel(renderer));

      throwUncaught(new Error("first"));
      button("dismiss")?.click();
      throwUncaught(new Error("second"));
      button("copy")?.click();
      await flush();

      assert.equal(written.length, 1);
      assert.doesNotMatch(written[0] ?? "", /first/);
      assert.match(written[0] ?? "", /second/);
    } finally {
      restore();
    }
  });

  test("selects the text instead when there is no clipboard to write to", async () => {
    const restore = withClipboard(null);
    try {
      const { renderer } = fakeRenderer(false);
      installed.push(installCrashPanel(renderer));

      throwUncaught(new Error("nowhere to put it"));
      const copy = button("copy");
      assert.ok(copy);
      copy.click();
      await flush();

      assert.equal(copy.textContent, "Copy it now");
      assert.match(window.getSelection()?.toString() ?? "", /nowhere to put it/);
      window.getSelection()?.removeAllRanges();
    } finally {
      restore();
    }
  });

  test("says so when the clipboard refuses", async () => {
    const restore = withClipboard({
      writeText: async () => {
        throw new Error("denied");
      },
    });
    try {
      const { renderer } = fakeRenderer(false);
      installed.push(installCrashPanel(renderer));

      throwUncaught(new Error("boom"));
      const copy = button("copy");
      assert.ok(copy);
      copy.click();
      await flush();

      // A refusal still leaves the text selected, so the browser's own copy
      // is one gesture away.
      assert.equal(copy.textContent, "Copy it now");
      window.getSelection()?.removeAllRanges();
    } finally {
      restore();
    }
  });

  test("leaves the muted 'Script error.' of a cross-origin script alone", () => {
    // What a browser reports for a script from another origin: a fixed
    // message and nothing else. It cannot be this app -- its own scripts are
    // same-origin and arrive with their Error -- and there is nothing in it
    // to read, so a page whose analytics beacon throws when the tab is hidden
    // must not be told it crashed. The session stays up with it.
    const { state, renderer } = fakeRenderer(true);
    installed.push(installCrashPanel(renderer));

    /** @type {string[]} */
    const warned = [];
    const warn = console.warn;
    console.warn = (/** @type {unknown[]} */ ...args) => warned.push(args.join(" "));
    try {
      for (let i = 0; i < 3; i++) {
        window.dispatchEvent(
          new window.ErrorEvent("error", {
            error: null,
            message: "Script error.",
            filename: "",
            lineno: 0,
            colno: 0,
          }),
        );
      }
    } finally {
      console.warn = warn;
    }

    assert.equal(panel(), null);
    assert.equal(state.ended, 0);
    // Said to the console, where a developer can see it, and said once.
    assert.equal(warned.length, 1);
    assert.match(warned[0] ?? "", /Script error/);
  });

  test("shows an error with no Error behind it, and where it came from", () => {
    const { renderer } = fakeRenderer(false);
    installed.push(installCrashPanel(renderer));

    window.dispatchEvent(
      new window.ErrorEvent("error", {
        error: null,
        message: "Uncaught SyntaxError: unexpected token",
        filename: "https://labs.apendua.dev/apps/kite-xr/assets/index.js",
        lineno: 12,
        colno: 34,
      }),
    );

    const text = panel()?.textContent ?? "";
    assert.match(text, /unexpected token/);
    assert.match(text, /index\.js:12:34/);
  });

  test("uninstalling stops listening and removes the panel", () => {
    const { state, renderer } = fakeRenderer(true);
    const uninstall = installCrashPanel(renderer);
    throwUncaught(new Error("before"));
    assert.ok(panel());

    uninstall();
    assert.equal(panel(), null);

    throwUncaught(new Error("after"));
    assert.equal(panel(), null);
    assert.equal(state.ended, 1);
  });

  test("takes a failure handed straight to it, without going through the window", () => {
    // The frame loop's door. An XR frame callback that throws is not reliably
    // reported to the window -- the emulator these apps are developed against
    // catches every one of them and writes to the console instead -- so the
    // loop says so here rather than waiting for an event that may never come.
    const { state, renderer } = fakeRenderer(true);
    installed.push(installCrashPanel(renderer));

    assert.equal(reportCrash(renderer, new Error("straight from the loop")), true);

    assert.equal(state.ended, 1);
    assert.match(panel()?.textContent ?? "", /straight from the loop/);
  });

  test("says so when nothing is listening for a renderer", () => {
    const { renderer } = fakeRenderer(true);

    assert.equal(reportCrash(renderer, new Error("nobody home")), false);
    assert.equal(panel(), null);
  });

  test("stops listening for a renderer once the panel is uninstalled", () => {
    const { renderer } = fakeRenderer(true);
    installCrashPanel(renderer)();

    assert.equal(reportCrash(renderer, new Error("too late")), false);
    assert.equal(panel(), null);
  });

  test("mounts under the root it is given", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const { renderer } = fakeRenderer(false);
    installed.push(installCrashPanel(renderer, { root }));

    throwUncaught(new Error("here"));

    assert.equal(panel()?.parentElement, root);
    root.remove();
  });
});

describe("describe", () => {
  test("uses the stack as it is when it already carries the message", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at somewhere";
    assert.equal(describeError(err), "Error: boom\n    at somewhere");
  });

  test("puts the name and message in front of a stack that lacks them", () => {
    const err = new TypeError("boom");
    err.stack = "somewhere@file.js:1:1";
    assert.equal(describeError(err), "TypeError: boom\nsomewhere@file.js:1:1");
  });

  test("is the headline alone when there is no stack", () => {
    const err = new RangeError("boom");
    err.stack = undefined;
    assert.equal(describeError(err), "RangeError: boom");
  });

  test("shows a thrown string or object as text", () => {
    assert.equal(describeError("just a string"), "just a string");
    assert.equal(describeError({ code: 7 }), '{"code":7}');
    assert.equal(describeError(undefined), "undefined");
  });
});
