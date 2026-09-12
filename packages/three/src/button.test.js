import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createSessionButton, createUnsupportedButton } from "./button.js";

/**
 * @typedef {import('three').WebGLRenderer} WebGLRenderer
 */

/**
 * A session that behaves like the real thing where it matters: listeners that
 * can be added and taken off again, an `end()` that announces the end exactly
 * once, and a count of how many times it was asked to end — so that a button
 * calling `end()` on a session that is already over shows up as the no-op it
 * is rather than passing quietly.
 */
class FakeSession {
  /** @type {Map<string, ((event: { type: string }) => void)[]>} */
  #listeners = new Map();
  ended = false;
  endCalls = 0;
  /** Whether `end()` announces the end, or leaves the promise to say so. */
  announces = true;

  /**
   * @param {string} type
   * @param {(event: { type: string }) => void} handler
   */
  addEventListener(type, handler) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), handler]);
  }

  /**
   * @param {string} type
   * @param {(event: { type: string }) => void} handler
   */
  removeEventListener(type, handler) {
    this.#listeners.set(
      type,
      (this.#listeners.get(type) ?? []).filter((listener) => listener !== handler),
    );
  }

  /**
   * The runtime ending the session out from under the page — the system menu,
   * the headset coming off — which is the only way most of these end.
   *
   * @param {string} type
   */
  dispatch(type) {
    for (const handler of [...(this.#listeners.get(type) ?? [])]) {
      handler({ type });
    }
  }

  end() {
    this.endCalls += 1;
    if (!this.ended) {
      this.ended = true;
      if (this.announces) {
        this.dispatch("end");
      }
    }
    return Promise.resolve();
  }
}

/**
 * A renderer whose `setSession` is whatever the test needs it to be: resolved
 * by default, or held open so a session can be ended while three is still
 * setting it up, which is the window the whole state machine is arranged
 * around.
 *
 * @param {{ setSession?: (session: unknown) => Promise<void> }} [options]
 */
function fakeRenderer(options = {}) {
  /** @type {Record<string, (() => void)[]>} */
  const handlers = {};
  /** @type {unknown} */
  let session = null;
  const renderer = {
    /** @param {string} type */
    emit(type) {
      for (const handler of handlers[type] ?? []) {
        handler();
      }
    },
    /** @param {unknown} value */
    setPresenting(value) {
      session = value;
    },
    xr: {
      /** @param {string} type @param {() => void} handler */
      addEventListener(type, handler) {
        (handlers[type] ??= []).push(handler);
      },
      removeEventListener() {},
      getSession: () => session,
      /** @param {unknown} value */
      setSession: async (value) => {
        session = value;
        if (options.setSession) {
          await options.setSession(value);
        }
      },
    },
  };
  return renderer;
}

/** A promise with its settle functions to hand. */
function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve = () => {};
  /** @type {(reason?: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = /** @type {(value?: unknown) => void} */ (res);
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-queued microtask and promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * An `XRSystem` that hands out the sessions given to it, in order.
 *
 * @param {FakeSession[]} sessions
 */
function fakeXR(sessions) {
  /** @type {{ requested: number; offered: number; refuse: unknown }} */
  const state = { requested: 0, offered: 0, refuse: null };
  const system = {
    state,
    addEventListener() {},
    isSessionSupported: async () => true,
    requestSession: async () => {
      state.requested += 1;
      if (state.refuse) {
        throw state.refuse;
      }
      const session = sessions.shift();
      assert.ok(session, "the test ran out of sessions to hand out");
      return session;
    },
  };
  return system;
}

/**
 * @param {object} system
 */
function installXR(system) {
  Object.defineProperty(navigator, "xr", { value: system, configurable: true, writable: true });
}

describe("createSessionButton", () => {
  test("carries three's id and wording, so everything that selects on them still works", () => {
    installXR(fakeXR([]));
    const ar = createSessionButton(/** @type {never} */ (fakeRenderer()), {
      mode: "immersive-ar",
    });
    assert.equal(ar.id, "ARButton");
    assert.equal(ar.textContent, "START AR");

    const vr = createSessionButton(/** @type {never} */ (fakeRenderer()), {
      mode: "immersive-vr",
    });
    assert.equal(vr.id, "VRButton");
    assert.equal(vr.textContent, "ENTER VR");
  });

  test("enters on a click and comes back when the session ends", async () => {
    const session = new FakeSession();
    installXR(fakeXR([session]));
    const renderer = fakeRenderer();
    const button = createSessionButton(/** @type {never} */ (renderer), { mode: "immersive-ar" });

    button.click();
    await settle();
    assert.equal(button.textContent, "STOP AR");

    // The system menu, rather than the button: the session simply ends.
    session.dispatch("end");
    assert.equal(button.textContent, "START AR");
  });

  test("clicking while a session is up ends it, and does not ask for another", async () => {
    const session = new FakeSession();
    const xr = fakeXR([session]);
    installXR(xr);
    const renderer = fakeRenderer();
    const button = createSessionButton(/** @type {never} */ (renderer), { mode: "immersive-ar" });

    button.click();
    await settle();
    button.click();
    await settle();

    assert.equal(session.endCalls, 1);
    assert.equal(xr.state.requested, 1);
    assert.equal(button.textContent, "START AR");
  });

  /**
   * The regression this button was written for. three assigns its
   * `currentSession` only after `await renderer.xr.setSession(session)`, so a
   * session that ends inside that window throws out of its `end` handler with
   * the variable still null, and the page is left saying `STOP AR` for as long
   * as it is open — every later click calling `end()` on a session that is
   * already over.
   */
  test("a session that ends while three is still setting it up leaves the button usable", async () => {
    const held = deferred();
    const first = new FakeSession();
    const second = new FakeSession();
    const xr = fakeXR([first, second]);
    installXR(xr);
    const renderer = fakeRenderer({
      setSession: () => /** @type {Promise<void>} */ (held.promise),
    });
    const button = createSessionButton(/** @type {never} */ (renderer), { mode: "immersive-ar" });

    button.click();
    await settle();
    assert.equal(button.textContent, "STOP AR");

    // The headset is taken off, or the system menu is used, before three has
    // finished making the context XR-compatible.
    first.dispatch("end");
    assert.equal(button.textContent, "START AR", "the label follows the session, not the setup");

    // three finishes its side afterwards, against a session that is over. It
    // must not put the button back into a state it cannot leave.
    held.resolve();
    await settle();
    assert.equal(button.textContent, "START AR");

    // And the button still works: a click asks for a new session rather than
    // ending a dead one.
    button.click();
    await settle();
    assert.equal(xr.state.requested, 2);
    assert.equal(button.textContent, "STOP AR");
  });

  test("three failing to take a session hands the headset back rather than holding it", async (t) => {
    t.mock.method(console, "error", () => {});
    const session = new FakeSession();
    installXR(fakeXR([session]));
    const renderer = fakeRenderer({
      setSession: async () => {
        throw new Error("could not make the context XR compatible");
      },
    });
    const button = createSessionButton(/** @type {never} */ (renderer), { mode: "immersive-ar" });

    button.click();
    await settle();

    assert.equal(session.ended, true, "a session nothing can draw to is ended, not left running");
    assert.equal(button.textContent, "START AR");
  });

  test("a session that ends mid-setup does not report the rejection three raises about it", async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const held = deferred();
    const session = new FakeSession();
    installXR(fakeXR([session]));
    const renderer = fakeRenderer({
      setSession: () => /** @type {Promise<void>} */ (held.promise),
    });
    const button = createSessionButton(/** @type {never} */ (renderer), { mode: "immersive-ar" });

    button.click();
    await settle();
    session.dispatch("end");
    // three reads its own `session` back as null on the far side of the await
    // and throws about it. That is the race, not something to put on the page.
    held.reject(new Error("Cannot read properties of null"));
    await settle();

    assert.equal(errors.mock.callCount(), 0);
    assert.equal(button.textContent, "START AR");
  });

  test("a refused session leaves the button where it was, and says so", async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const xr = fakeXR([]);
    xr.state.refuse = new Error("NotSupportedError");
    installXR(xr);
    const button = createSessionButton(/** @type {never} */ (fakeRenderer()), {
      mode: "immersive-ar",
    });

    button.click();
    await settle();

    assert.equal(button.textContent, "START AR");
    assert.equal(errors.mock.callCount(), 1);

    // Still willing to try again, which a phase left at `requesting` would not be.
    xr.state.refuse = null;
    const session = new FakeSession();
    xr.state.requested = 0;
    installXR(fakeXR([session]));
    button.click();
    await settle();
    assert.equal(button.textContent, "STOP AR");
  });

  test("a runtime whose end event never arrives still gives the button back", async () => {
    const session = new FakeSession();
    session.announces = false;
    installXR(fakeXR([session]));
    const button = createSessionButton(/** @type {never} */ (fakeRenderer()), {
      mode: "immersive-vr",
    });

    button.click();
    await settle();
    assert.equal(button.textContent, "EXIT VR");

    button.click();
    await settle();
    // `end()` settling is the second of the three ways back to idle.
    assert.equal(button.textContent, "ENTER VR");
  });

  test("a session ended by something else entirely is noticed through the renderer", async () => {
    const session = new FakeSession();
    session.announces = false;
    installXR(fakeXR([session]));
    const renderer = fakeRenderer();
    const button = createSessionButton(/** @type {never} */ (renderer), { mode: "immersive-ar" });

    button.click();
    await settle();
    assert.equal(button.textContent, "STOP AR");

    // What the crash panel does: it ends the session itself, and three says so
    // on the renderer. The third way back to idle.
    renderer.setPresenting(null);
    renderer.emit("sessionend");
    assert.equal(button.textContent, "START AR");
  });

  test("never offers the browser a session unless it was asked to", async () => {
    const session = new FakeSession();
    const xr = /** @type {ReturnType<typeof fakeXR> & { offerSession: () => Promise<never> }} */ (
      Object.assign(fakeXR([session]), {
        offerSession: () => {
          xr.state.offered += 1;
          return new Promise(() => {});
        },
      })
    );
    installXR(xr);
    const button = createSessionButton(/** @type {never} */ (fakeRenderer()), {
      mode: "immersive-ar",
    });

    button.click();
    await settle();
    session.dispatch("end");
    await settle();

    assert.equal(xr.state.offered, 0);
    assert.equal(button.textContent, "START AR");
  });

  test("offers one when asked, and only once the last session is actually over", async () => {
    const session = new FakeSession();
    const xr = /** @type {ReturnType<typeof fakeXR> & { offerSession: () => Promise<never> }} */ (
      Object.assign(fakeXR([session]), {
        offerSession: () => {
          xr.state.offered += 1;
          return new Promise(() => {});
        },
      })
    );
    installXR(xr);
    const button = createSessionButton(/** @type {never} */ (fakeRenderer()), {
      mode: "immersive-ar",
      offerSession: true,
    });

    assert.equal(xr.state.offered, 1, "one standing offer while there is no session");

    button.click();
    await settle();
    assert.equal(xr.state.offered, 1, "and none at all while one is running");

    session.dispatch("end");
    assert.equal(
      xr.state.offered,
      2,
      "the next offer waits for the end rather than racing it, which is what three got wrong",
    );
  });
});

describe("createSessionButton, entering on its own", () => {
  /**
   * Stands in for an installed app, or for a browser tab.
   *
   * @param {boolean} installed What `(display-mode: standalone)` answers.
   */
  function installDisplayMode(installed) {
    Object.defineProperty(globalThis, "matchMedia", {
      value: (/** @type {string} */ query) => ({
        matches: installed && query.includes("standalone"),
      }),
      configurable: true,
      writable: true,
    });
  }

  /** Back to a runtime with no `matchMedia` at all, which is where it starts. */
  function clearDisplayMode() {
    // @ts-expect-error -- putting the environment back as jsdom left it.
    delete globalThis.matchMedia;
  }

  test("asks for a session without being clicked, once installed", async () => {
    installDisplayMode(true);
    const session = new FakeSession();
    const xr = fakeXR([session]);
    installXR(xr);
    const renderer = fakeRenderer();

    const button = createSessionButton(/** @type {never} */ (renderer), {
      mode: "immersive-vr",
      autoEnter: true,
    });
    await settle();

    assert.equal(xr.state.requested, 1);
    assert.equal(button.textContent, "EXIT VR");
    clearDisplayMode();
  });

  test("waits to be asked in a browser tab, where there is no activation to spend", async () => {
    installDisplayMode(false);
    const xr = fakeXR([new FakeSession()]);
    installXR(xr);

    const button = createSessionButton(/** @type {never} */ (fakeRenderer()), {
      mode: "immersive-vr",
      autoEnter: true,
    });
    await settle();

    assert.equal(xr.state.requested, 0, "a tab was asked for a session it could not have");
    assert.equal(button.textContent, "ENTER VR");
    clearDisplayMode();
  });

  test("stays off unless it is asked for", async () => {
    installDisplayMode(true);
    const xr = fakeXR([new FakeSession()]);
    installXR(xr);

    createSessionButton(/** @type {never} */ (fakeRenderer()), { mode: "immersive-vr" });
    await settle();

    assert.equal(xr.state.requested, 0);
    clearDisplayMode();
  });

  test("leaves a button to press when the automatic request is refused", async () => {
    installDisplayMode(true);
    const xr = fakeXR([new FakeSession()]);
    xr.state.refuse = new Error("no activation");
    installXR(xr);
    const renderer = fakeRenderer();

    const button = createSessionButton(/** @type {never} */ (renderer), {
      mode: "immersive-vr",
      autoEnter: true,
    });
    await settle();

    // The whole point: a refusal is not a black screen. The button is built,
    // says the way in, and the next request is the player's.
    assert.equal(button.textContent, "ENTER VR");
    assert.equal(xr.state.requested, 1);

    xr.state.refuse = null;
    button.click();
    await settle();
    assert.equal(button.textContent, "EXIT VR");
    clearDisplayMode();
  });

  test("hands the headset back through the button, and can be re-entered", async () => {
    installDisplayMode(true);
    const first = new FakeSession();
    const second = new FakeSession();
    const xr = fakeXR([first, second]);
    installXR(xr);
    const renderer = fakeRenderer();

    const button = createSessionButton(/** @type {never} */ (renderer), {
      mode: "immersive-vr",
      autoEnter: true,
    });
    await settle();
    assert.equal(button.textContent, "EXIT VR");

    // The system menu, not the button: the player left of their own accord.
    // Nothing walks them straight back in -- the button is the way back.
    first.dispatch("end");
    await settle();
    assert.equal(button.textContent, "ENTER VR");
    assert.equal(xr.state.requested, 1);

    button.click();
    await settle();
    assert.equal(button.textContent, "EXIT VR");
    assert.equal(xr.state.requested, 2);
    clearDisplayMode();
  });
});

describe("createUnsupportedButton", () => {
  test("says which mode is missing, and cannot be clicked into one", () => {
    installXR(fakeXR([]));
    const button = /** @type {HTMLButtonElement} */ (createUnsupportedButton("immersive-ar"));
    assert.equal(button.id, "ARButton");
    assert.equal(button.textContent, "AR NOT SUPPORTED");
    assert.equal(button.disabled, true);
  });

  test("points a browser with no WebXR at all somewhere useful", () => {
    delete navigator.xr;
    const message = createUnsupportedButton();
    assert.equal(message.tagName, "A");
    assert.match(message.textContent ?? "", /^WEBXR (NOT AVAILABLE|NEEDS HTTPS)$/);
  });
});
