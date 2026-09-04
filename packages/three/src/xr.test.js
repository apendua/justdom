import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { createXRButton, requestFrameRate, suppressSessionOffers } from "./xr.js";

// ARButton and VRButton build real DOM elements, which this plain node:test
// environment has no `document` for. The decision this module makes —
// which one to call, with which session init, and when the reference space
// is set — does not depend on what they return, so their `createButton`
// statics are stubbed out per test instead of exercising the real thing.

/**
 * @typedef {import('three').WebGLRenderer} WebGLRenderer
 */

/**
 * @typedef {WebGLRenderer & {
 *   calls: string[];
 *   listeners: string[];
 *   emit: (type: string) => void;
 * }} FakeRenderer
 */

/**
 * @param {unknown} [session]
 * @returns {FakeRenderer}
 */
function fakeRenderer(session = null) {
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const listeners = [];
  /** @type {Record<string, (() => void)[]>} */
  const handlers = {};
  // Built first and cast on the way out: a multi-line comment straight after
  // `return` counts as a line break, and ASI turns the whole thing into
  // `return undefined`.
  const renderer = {
    calls,
    listeners,
    emit(/** @type {string} */ type) {
      for (const handler of handlers[type] ?? []) {
        handler();
      }
    },
    xr: {
      setReferenceSpaceType(/** @type {string} */ value) {
        calls.push(value);
      },
      // What the viewer anchor hangs itself on when it is installed.
      addEventListener(/** @type {string} */ type, /** @type {() => void} */ handler) {
        listeners.push(type);
        (handlers[type] ??= []).push(handler);
      },
      removeEventListener() {},
      getSession: () => session,
      getReferenceSpace: () => null,
    },
  };
  return /** @type {FakeRenderer} */ (/** @type {unknown} */ (renderer));
}

/**
 * A session that offers a set of frame rates and records what it was asked
 * for. `rates` of null is a runtime that does not offer the choice at all.
 *
 * @param {number[] | null} rates
 */
function fakeSession(rates) {
  /** @type {{ asked: number[]; rejects: boolean }} */
  const state = { asked: [], rejects: false };
  return {
    state,
    session: {
      supportedFrameRates: rates ? Float32Array.from(rates) : undefined,
      updateTargetFrameRate: rates
        ? async (/** @type {number} */ rate) => {
            state.asked.push(rate);
            if (state.rejects) {
              throw new Error("the runtime said no");
            }
          }
        : undefined,
    },
  };
}

describe("createXRButton", () => {
  afterEach(() => {
    delete navigator.xr;
  });

  test("prefers immersive-ar when the platform supports it", async (t) => {
    const arButton = {};
    const ar = t.mock.method(ARButton, "createButton", () => arButton);
    const vr = t.mock.method(VRButton, "createButton", () => {
      throw new Error("VRButton.createButton should not be called");
    });
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({
        isSessionSupported: async (/** @type {string} */ mode) => mode === "immersive-ar",
      })
    );

    const button = await createXRButton(fakeRenderer());

    assert.equal(button, arButton);
    assert.equal(ar.mock.callCount(), 1);
    assert.equal(vr.mock.callCount(), 0);
  });

  test("falls back to immersive-vr on a headset with no passthrough", async (t) => {
    const vrButton = {};
    const ar = t.mock.method(ARButton, "createButton", () => {
      throw new Error("ARButton.createButton should not be called");
    });
    const vr = t.mock.method(VRButton, "createButton", () => vrButton);
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({
        isSessionSupported: async (/** @type {string} */ mode) => mode === "immersive-vr",
      })
    );

    const button = await createXRButton(fakeRenderer());

    assert.equal(button, vrButton);
    assert.equal(vr.mock.callCount(), 1);
    assert.equal(ar.mock.callCount(), 0);
  });

  test("falls back to ARButton's own unsupported state when neither mode is available", async (t) => {
    const arButton = {};
    const ar = t.mock.method(ARButton, "createButton", () => arButton);
    t.mock.method(VRButton, "createButton", () => {
      throw new Error("VRButton.createButton should not be called");
    });
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({ isSessionSupported: async () => false })
    );

    const button = await createXRButton(fakeRenderer());

    assert.equal(button, arButton);
    assert.equal(ar.mock.callCount(), 1);
  });

  test("falls back the same way when navigator.xr does not exist at all", async (t) => {
    const arButton = {};
    const ar = t.mock.method(ARButton, "createButton", () => arButton);
    delete navigator.xr;

    const button = await createXRButton(fakeRenderer());

    assert.equal(button, arButton);
    assert.equal(ar.mock.callCount(), 1);
  });

  test("treats a rejected immersive-ar check the same as unsupported, and still checks immersive-vr", async (t) => {
    const vrButton = {};
    t.mock.method(ARButton, "createButton", () => {
      throw new Error("ARButton.createButton should not be called");
    });
    const vr = t.mock.method(VRButton, "createButton", () => vrButton);
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({
        isSessionSupported: async (/** @type {string} */ mode) => {
          if (mode === "immersive-ar") {
            throw new Error("NotSupportedError");
          }
          return mode === "immersive-vr";
        },
      })
    );

    const button = await createXRButton(fakeRenderer());

    assert.equal(button, vrButton);
    assert.equal(vr.mock.callCount(), 1);
  });

  test("sets the reference space to local before either button is created, so the fallback lands where AR content is authored for", async (t) => {
    t.mock.method(ARButton, "createButton", () => ({}));
    const vr = t.mock.method(
      VRButton,
      "createButton",
      (/** @type {WebGLRenderer & { calls: string[] }} */ renderer) => {
        // VRButton itself never touches the reference space (unlike
        // ARButton, which sets it right before starting a session) — by the
        // time it is asked to build a button, createXRButton must already
        // have set it, or the fallback session would start at floor level
        // instead of where the scene expects the headset to be.
        assert.deepEqual(renderer.calls, ["local"]);
        return {};
      },
    );
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({
        isSessionSupported: async (/** @type {string} */ mode) => mode === "immersive-vr",
      })
    );

    await createXRButton(fakeRenderer());

    assert.equal(vr.mock.callCount(), 1);
  });

  test("installs the viewer anchor by default, and not when opted out", async (t) => {
    t.mock.method(ARButton, "createButton", () => ({}));
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({ isSessionSupported: async () => false })
    );

    const anchored = fakeRenderer();
    // The frame rate is asked for on `sessionstart` too, and this test is
    // about the anchor, so it is left out of the way here rather than
    // counted among the anchor's own listeners.
    await createXRButton(anchored, { frameRate: false });
    // The anchor waits for sessions on the renderer; the subscription is how
    // it is installed at all.
    assert.deepEqual(anchored.listeners, ["sessionstart", "sessionend"]);

    const unanchored = fakeRenderer();
    await createXRButton(unanchored, { anchor: false, frameRate: false });
    assert.deepEqual(unanchored.listeners, []);
  });

  test("installs the crash panel unless told not to", async (t) => {
    t.mock.method(ARButton, "createButton", () => ({}));
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({
        isSessionSupported: async () => true,
      })
    );
    const listen = t.mock.method(window, "addEventListener");
    const listening = () => listen.mock.calls.map((call) => call.arguments[0]);

    await createXRButton(fakeRenderer(), { anchor: false, frameRate: false });
    assert.deepEqual(listening(), ["error", "unhandledrejection"]);

    listen.mock.resetCalls();
    await createXRButton(fakeRenderer(), { anchor: false, frameRate: false, crashPanel: false });
    assert.deepEqual(listening(), []);
  });

  test("passes the ar/vr session init through to whichever button is used", async (t) => {
    const arInit = { optionalFeatures: ["hand-tracking"] };
    const vrInit = { optionalFeatures: ["local-floor"] };
    // Untouched, and so the same object: hand tracking is the one thing the
    // button adds to a session init, and here it is told not to.
    /** @type {unknown} */
    let seenAr;
    /** @type {unknown} */
    let seenVr;
    t.mock.method(
      ARButton,
      "createButton",
      (/** @type {unknown} */ _renderer, /** @type {unknown} */ sessionInit) => {
        seenAr = sessionInit;
        return {};
      },
    );
    t.mock.method(
      VRButton,
      "createButton",
      (/** @type {unknown} */ _renderer, /** @type {unknown} */ sessionInit) => {
        seenVr = sessionInit;
        return {};
      },
    );

    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({ isSessionSupported: async () => false })
    );
    await createXRButton(fakeRenderer(), { ar: arInit, vr: vrInit, handTracking: false });
    assert.equal(seenAr, arInit);

    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({
        isSessionSupported: async (/** @type {string} */ mode) => mode === "immersive-vr",
      })
    );
    await createXRButton(fakeRenderer(), { ar: arInit, vr: vrInit, handTracking: false });
    assert.equal(seenVr, vrInit);
  });

  /**
   * Captures the session init each of three's buttons is handed.
   *
   * @param {import('node:test').TestContext} t
   */
  function captureInits(t) {
    /** @type {{ ar?: { optionalFeatures?: string[] }; vr?: { optionalFeatures?: string[] } }} */
    const seen = {};
    t.mock.method(
      ARButton,
      "createButton",
      (/** @type {unknown} */ _renderer, /** @type {never} */ sessionInit) => {
        seen.ar = sessionInit;
        return {};
      },
    );
    t.mock.method(
      VRButton,
      "createButton",
      (/** @type {unknown} */ _renderer, /** @type {never} */ sessionInit) => {
        seen.vr = sessionInit;
        return {};
      },
    );
    return seen;
  }

  test("asks for hand tracking on both session kinds, keeping whatever else was asked for", async (t) => {
    const seen = captureInits(t);

    // Nothing asked for: the feature is the whole of the init.
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({ isSessionSupported: async () => false })
    );
    await createXRButton(fakeRenderer(), { anchor: false, frameRate: false });
    assert.deepEqual(seen.ar, { optionalFeatures: ["hand-tracking"] });

    // Other features asked for: the request is added, not put in their place,
    // and an app that asked for it itself is not asking twice.
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({
        isSessionSupported: async (/** @type {string} */ mode) => mode === "immersive-vr",
      })
    );
    await createXRButton(fakeRenderer(), {
      anchor: false,
      frameRate: false,
      ar: { optionalFeatures: ["hand-tracking"], requiredFeatures: ["hit-test"] },
      vr: { optionalFeatures: ["local-floor"] },
    });
    assert.deepEqual(seen.vr, { optionalFeatures: ["local-floor", "hand-tracking"] });

    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({ isSessionSupported: async () => true })
    );
    await createXRButton(fakeRenderer(), {
      anchor: false,
      frameRate: false,
      ar: { optionalFeatures: ["hand-tracking"], requiredFeatures: ["hit-test"] },
    });
    assert.deepEqual(seen.ar, {
      optionalFeatures: ["hand-tracking"],
      requiredFeatures: ["hit-test"],
    });
  });

  test("handTracking: false leaves the session init exactly as given", async (t) => {
    const seen = captureInits(t);
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({ isSessionSupported: async () => true })
    );

    await createXRButton(fakeRenderer(), { anchor: false, frameRate: false, handTracking: false });
    assert.equal(seen.ar, undefined);

    const arInit = { optionalFeatures: ["local-floor"] };
    await createXRButton(fakeRenderer(), {
      anchor: false,
      frameRate: false,
      handTracking: false,
      ar: arInit,
    });
    assert.deepEqual(seen.ar, { optionalFeatures: ["local-floor"] });
  });
});

describe("requestFrameRate", () => {
  test("asks for the fastest rate the runtime offers", () => {
    const { state, session } = fakeSession([72, 90, 120]);
    const renderer = fakeRenderer(session);

    requestFrameRate(renderer);
    // Nothing is asked for until there is a session to ask.
    assert.deepEqual(state.asked, []);

    renderer.emit("sessionstart");
    assert.deepEqual(state.asked, [120]);
  });

  test("takes the middle rate, or the nearest to a number", () => {
    const mid = fakeSession([72, 90, 120]);
    const midRenderer = fakeRenderer(mid.session);
    requestFrameRate(midRenderer, "mid");
    midRenderer.emit("sessionstart");
    assert.deepEqual(mid.state.asked, [90]);

    const near = fakeSession([72, 90, 120]);
    const nearRenderer = fakeRenderer(near.session);
    requestFrameRate(nearRenderer, 100);
    nearRenderer.emit("sessionstart");
    assert.deepEqual(near.state.asked, [90]);
  });

  test("offers the rates in whatever order, and still picks the fastest", () => {
    const { state, session } = fakeSession([120, 72, 90]);
    const renderer = fakeRenderer(session);
    requestFrameRate(renderer);
    renderer.emit("sessionstart");
    assert.deepEqual(state.asked, [120]);
  });

  test("says nothing to a runtime that does not offer the choice", () => {
    const { state, session } = fakeSession(null);
    const renderer = fakeRenderer(session);
    requestFrameRate(renderer);
    // The point is that this does not throw; a session that cannot change
    // its frame rate is still a perfectly good session.
    renderer.emit("sessionstart");
    assert.deepEqual(state.asked, []);
  });

  test("swallows a refusal rather than leaving a rejection loose", async () => {
    const { state, session } = fakeSession([72, 90]);
    state.rejects = true;
    const renderer = fakeRenderer(session);
    requestFrameRate(renderer);
    renderer.emit("sessionstart");
    assert.deepEqual(state.asked, [90]);
    // Give the rejected promise a turn to go unhandled, if it were going to.
    await new Promise((resolve) => setImmediate(resolve));
  });

  test("stops listening when it is told to", () => {
    const { session } = fakeSession([72, 90]);
    const renderer = fakeRenderer(session);
    const stop = requestFrameRate(renderer);
    assert.deepEqual(renderer.listeners, ["sessionstart"]);
    stop();
  });
});

describe("suppressSessionOffers", () => {
  afterEach(() => {
    delete navigator.xr;
  });

  /**
   * An XRSystem whose `offerSession` lives on a prototype, the way a real
   * one's does — the shadowing has to survive being deleted off the instance.
   */
  function fakeXRSystem() {
    /** @type {string[]} */
    const offered = [];
    const prototype = {
      offerSession(/** @type {string} */ mode) {
        offered.push(mode);
        return Promise.resolve();
      },
      isSessionSupported: async (/** @type {string} */ mode) => mode === "immersive-ar",
    };
    return { offered, system: Object.create(prototype) };
  }

  test("hides the offer, and gives it back", () => {
    const { offered, system } = fakeXRSystem();
    navigator.xr = /** @type {XRSystem} */ (/** @type {unknown} */ (system));

    const restore = suppressSessionOffers();
    // The exact shape three's buttons test for.
    assert.equal(system.offerSession, undefined);

    restore();
    assert.equal(typeof system.offerSession, "function");
    system.offerSession("immersive-ar");
    assert.deepEqual(offered, ["immersive-ar"]);
  });

  test("says nothing about a runtime that has no offers to make", () => {
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({ isSessionSupported: async () => false })
    );
    // The point is that neither of these throws.
    suppressSessionOffers()();

    delete navigator.xr;
    suppressSessionOffers()();
  });

  test("the button hides it, and leaves it hidden", async (t) => {
    t.mock.method(ARButton, "createButton", () => ({}));
    const { system } = fakeXRSystem();
    navigator.xr = /** @type {XRSystem} */ (/** @type {unknown} */ (system));

    await createXRButton(fakeRenderer());

    // Not restored on the way out: three's button reads this again on every
    // click, and the click that leaves a session is the one that matters.
    assert.equal(system.offerSession, undefined);
  });

  test("offerSession: true leaves three's own behaviour alone", async (t) => {
    t.mock.method(ARButton, "createButton", () => ({}));
    const { system } = fakeXRSystem();
    navigator.xr = /** @type {XRSystem} */ (/** @type {unknown} */ (system));

    await createXRButton(fakeRenderer(), { offerSession: true });

    assert.equal(typeof system.offerSession, "function");
  });
});
