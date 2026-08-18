import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { createXRButton } from "./xr.js";

// ARButton and VRButton build real DOM elements, which this plain node:test
// environment has no `document` for. The decision this module makes —
// which one to call, with which session init, and when the reference space
// is set — does not depend on what they return, so their `createButton`
// statics are stubbed out per test instead of exercising the real thing.

/**
 * @typedef {import('three').WebGLRenderer} WebGLRenderer
 */

/**
 * @returns {WebGLRenderer & { calls: string[]; listeners: string[] }}
 */
function fakeRenderer() {
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const listeners = [];
  return /** @type {WebGLRenderer & { calls: string[]; listeners: string[] }} */ (
    /** @type {unknown} */ ({
      calls,
      listeners,
      xr: {
        setReferenceSpaceType(/** @type {string} */ value) {
          calls.push(value);
        },
        // What the viewer anchor hangs itself on when it is installed.
        addEventListener(/** @type {string} */ type) {
          listeners.push(type);
        },
        removeEventListener() {},
        getSession: () => null,
        getReferenceSpace: () => null,
      },
    })
  );
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
    await createXRButton(anchored);
    // The anchor waits for sessions on the renderer; the subscription is how
    // it is installed at all.
    assert.deepEqual(anchored.listeners, ["sessionstart", "sessionend"]);

    const unanchored = fakeRenderer();
    await createXRButton(unanchored, { anchor: false });
    assert.deepEqual(unanchored.listeners, []);
  });

  test("passes the ar/vr session init through to whichever button is used", async (t) => {
    const arInit = { optionalFeatures: ["hand-tracking"] };
    const vrInit = { optionalFeatures: ["local-floor"] };
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
    await createXRButton(fakeRenderer(), { ar: arInit, vr: vrInit });
    assert.equal(seenAr, arInit);

    navigator.xr = /** @type {XRSystem} */ (
      /** @type {unknown} */ ({
        isSessionSupported: async (/** @type {string} */ mode) => mode === "immersive-vr",
      })
    );
    await createXRButton(fakeRenderer(), { ar: arInit, vr: vrInit });
    assert.equal(seenVr, vrInit);
  });
});
