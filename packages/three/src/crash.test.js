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
    const dismiss = /** @type {HTMLButtonElement | null} */ (
      document.querySelector(`#${CRASH_PANEL_ID} button`)
    );
    assert.ok(dismiss);
    dismiss.click();
    assert.equal(panel(), null);

    throwUncaught(new Error("second"));
    const shown = panel();
    assert.ok(shown);
    assert.doesNotMatch(shown.textContent ?? "", /first/);
    assert.match(shown.textContent ?? "", /second/);
  });

  test("falls back to the message when a cross-origin script reports no error", () => {
    const { renderer } = fakeRenderer(false);
    installed.push(installCrashPanel(renderer));

    window.dispatchEvent(new window.ErrorEvent("error", { error: null, message: "Script error." }));

    assert.match(panel()?.textContent ?? "", /Script error\./);
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
