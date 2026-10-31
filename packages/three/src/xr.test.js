import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createXRButton, requestFrameRate, suppressSessionOffers } from "./xr.js";

// The button is freedom's own now (see `button.js`), and it is a real element
// built against the jsdom the test setup installs — so these check the choice
// this module makes by looking at what came back and at what it asks the
// runtime for, rather than by intercepting three's button factories. The state
// machine behind the element has its own tests in `button.test.js`.

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

/**
 * The session init a button actually asks for, which is now observable by
 * clicking it rather than by intercepting three's button factories: the init
 * goes to `requestSession`, and this is what hears it.
 *
 * @param {(mode: string) => boolean} supports
 */
function captureInit(supports) {
  /** @type {{ mode?: string; init?: XRSessionInit }} */
  const seen = {};
  navigator.xr = /** @type {XRSystem} */ (
    /** @type {unknown} */ ({
      isSessionSupported: async (/** @type {string} */ mode) => supports(mode),
      addEventListener() {},
      requestSession: async (/** @type {string} */ mode, /** @type {XRSessionInit} */ init) => {
        seen.mode = mode;
        seen.init = init;
        // Nothing is presented; the test only wants what was asked for.
        return new Promise(() => {});
      },
    })
  );
  return seen;
}

/** Lets every already-queued microtask and promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createXRButton", () => {
  afterEach(() => {
    delete navigator.xr;
  });

  test("prefers immersive-ar when the platform supports it", async () => {
    const seen = captureInit((mode) => mode === "immersive-ar");

    const button = await createXRButton(fakeRenderer());

    assert.equal(button.id, "ARButton");
    assert.equal(button.textContent, "START AR");
    button.click();
    await settle();
    assert.equal(seen.mode, "immersive-ar");
  });

  test("falls back to immersive-vr on a headset with no passthrough", async () => {
    const seen = captureInit((mode) => mode === "immersive-vr");

    const button = await createXRButton(fakeRenderer());

    assert.equal(button.id, "VRButton");
    assert.equal(button.textContent, "ENTER VR");
    button.click();
    await settle();
    assert.equal(seen.mode, "immersive-vr");
  });

  test("falls back to the dead-end button when neither mode is available", async () => {
    captureInit(() => false);

    const button = /** @type {HTMLButtonElement} */ (await createXRButton(fakeRenderer()));

    assert.equal(button.id, "ARButton");
    assert.equal(button.textContent, "AR NOT SUPPORTED");
    assert.equal(button.disabled, true);
  });

  test("falls back the same way when navigator.xr does not exist at all", async () => {
    delete navigator.xr;

    const message = await createXRButton(fakeRenderer());

    // No `navigator.xr` at all is the one case that is a link rather than a
    // button: over plain HTTP the fix is a URL, and that is what it offers.
    assert.equal(message.tagName, "A");
    assert.match(message.textContent ?? "", /^WEBXR (NOT AVAILABLE|NEEDS HTTPS)$/);
  });

  test("treats a rejected immersive-ar check the same as unsupported, and still checks immersive-vr", async () => {
    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({
        addEventListener() {},
        isSessionSupported: async (/** @type {string} */ mode) => {
          if (mode === "immersive-ar") {
            throw new Error("NotSupportedError");
          }
          return mode === "immersive-vr";
        },
      })
    );

    const button = await createXRButton(fakeRenderer());

    assert.equal(button.id, "VRButton");
  });

  test("sets the reference space to local, so the fallback lands where AR content is authored for", async () => {
    captureInit((mode) => mode === "immersive-vr");
    const renderer = fakeRenderer();

    await createXRButton(renderer);

    // three's own default is `local-floor`, whose origin is on the floor
    // rather than at the head; every scene here is laid out around `local`.
    assert.deepEqual(renderer.calls, ["local"]);
  });

  test("installs the viewer anchor by default, and not when opted out", async () => {
    // A supported mode, so the real button is built: the dead-end one never
    // touches the renderer, and would leave nothing here to tell apart.
    captureInit(() => true);

    const anchored = fakeRenderer();
    // The frame rate is asked for on `sessionstart` too, and this test is
    // about the anchor, so it is left out of the way here.
    await createXRButton(anchored, { frameRate: false });
    // The anchor's pair, and then the button's own resync listener.
    assert.deepEqual(anchored.listeners, ["sessionstart", "sessionend", "sessionend"]);

    const unanchored = fakeRenderer();
    await createXRButton(unanchored, { anchor: false, frameRate: false });
    assert.deepEqual(unanchored.listeners, ["sessionend"]);
  });

  test("installs the crash panel unless told not to", async (t) => {
    captureInit(() => true);
    const listen = t.mock.method(window, "addEventListener");
    const listening = () => listen.mock.calls.map((call) => call.arguments[0]);

    await createXRButton(fakeRenderer(), { anchor: false, frameRate: false });
    assert.deepEqual(listening(), ["error", "unhandledrejection"]);

    listen.mock.resetCalls();
    await createXRButton(fakeRenderer(), { anchor: false, frameRate: false, crashPanel: false });
    assert.deepEqual(listening(), []);
  });

  test("asks for hand tracking on both session kinds, keeping whatever else was asked for", async () => {
    // Nothing asked for: the feature is the whole of the AR init.
    let seen = captureInit((mode) => mode === "immersive-ar");
    let button = await createXRButton(fakeRenderer(), { anchor: false, frameRate: false });
    button.click();
    await settle();
    assert.deepEqual(seen.init, { optionalFeatures: ["hand-tracking"] });

    // Other features asked for: the request is added, not put in their place,
    // and an app that asked for it itself is not asking twice. The VR init
    // also carries what three's own VRButton always added.
    seen = captureInit((mode) => mode === "immersive-vr");
    button = await createXRButton(fakeRenderer(), {
      anchor: false,
      frameRate: false,
      ar: { optionalFeatures: ["hand-tracking"], requiredFeatures: ["hit-test"] },
      vr: { optionalFeatures: ["local-floor"] },
    });
    button.click();
    await settle();
    assert.deepEqual(seen.init, {
      optionalFeatures: ["local-floor", "hand-tracking", "bounded-floor", "layers"],
    });

    seen = captureInit(() => true);
    button = await createXRButton(fakeRenderer(), {
      anchor: false,
      frameRate: false,
      ar: { optionalFeatures: ["hand-tracking"], requiredFeatures: ["hit-test"] },
    });
    button.click();
    await settle();
    assert.deepEqual(seen.init, {
      optionalFeatures: ["hand-tracking"],
      requiredFeatures: ["hit-test"],
    });
  });

  test("handTracking: false leaves the session init exactly as given", async () => {
    let seen = captureInit(() => true);

    let button = await createXRButton(fakeRenderer(), {
      anchor: false,
      frameRate: false,
      handTracking: false,
    });
    button.click();
    await settle();
    assert.equal(seen.init, undefined);

    seen = captureInit(() => true);
    button = await createXRButton(fakeRenderer(), {
      anchor: false,
      frameRate: false,
      handTracking: false,
      ar: { optionalFeatures: ["local-floor"] },
    });
    button.click();
    await settle();
    assert.deepEqual(seen.init, { optionalFeatures: ["local-floor"] });
  });

  test("asks an AR session for local-floor, which the anchor measures upright in", async () => {
    let seen = captureInit(() => true);
    let button = await createXRButton(fakeRenderer(), { frameRate: false, handTracking: false });
    button.click();
    await settle();
    assert.deepEqual(seen.init, { optionalFeatures: ["local-floor"] });

    // Without the anchor there is nothing to ask for it.
    seen = captureInit(() => true);
    button = await createXRButton(fakeRenderer(), {
      anchor: false,
      frameRate: false,
      handTracking: false,
    });
    button.click();
    await settle();
    assert.equal(seen.init, undefined);
  });

  test("does not ask for dom-overlay, which three's ARButton added and nothing here used", async () => {
    const seen = captureInit(() => true);

    const button = await createXRButton(fakeRenderer(), { anchor: false, frameRate: false });
    button.click();
    await settle();

    assert.ok(!(seen.init?.optionalFeatures ?? []).includes("dom-overlay"));
    assert.equal(document.querySelector("#ARButton ~ div"), null);
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
        // Left pending: a real offer settles only if the browser decides to
        // open the session, and no test here is about what happens when it does.
        return new Promise(() => {});
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

  test("the button no longer needs to hide anything, and does not", async () => {
    const { offered, system } = fakeXRSystem();
    navigator.xr = /** @type {XRSystem} */ (/** @type {unknown} */ (system));

    await createXRButton(fakeRenderer());

    // freedom's own button never reaches for this, so shadowing it would only
    // be taking something away from whoever else is on the page. What matters
    // is that nothing was offered.
    assert.equal(typeof system.offerSession, "function");
    assert.deepEqual(offered, []);
  });

  test("offerSession: true makes the offer itself, from a standing start", async () => {
    const { offered, system } = fakeXRSystem();
    navigator.xr = /** @type {XRSystem} */ (/** @type {unknown} */ (system));

    await createXRButton(fakeRenderer(), { offerSession: true });

    assert.deepEqual(offered, ["immersive-ar"]);
  });
});
