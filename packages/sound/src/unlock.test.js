import assert from "node:assert/strict";
import test, { afterEach, describe } from "node:test";
import { unlockAudio } from "./unlock.js";

/**
 * A context that resumes only when `allow` says so, the way a browser
 * resumes one only within a gesture's grace.
 *
 * @param {AudioContextState} state
 */
function fakeContext(state) {
  const target = new EventTarget();
  const context = {
    state,
    resumes: 0,
    allow: false,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    async resume() {
      context.resumes += 1;
      if (!context.allow) {
        throw new Error("not allowed to start");
      }
      context.state = "running";
      target.dispatchEvent(new Event("statechange"));
    },
  };
  return context;
}

/** Lets the rejected `resume()` promises settle. */
const settle = () => new Promise((done) => setTimeout(done, 0));

afterEach(() => {
  Reflect.deleteProperty(globalThis, "navigator");
});

describe("unlockAudio", () => {
  test("asks a suspended context to resume at once", async () => {
    const context = fakeContext("suspended");
    context.allow = true;
    const stop = unlockAudio(context, { page: new EventTarget() });
    await settle();
    assert.equal(context.resumes, 1);
    assert.equal(context.state, "running");
    stop();
  });

  test("asks again on a page gesture until the context runs", async () => {
    const context = fakeContext("suspended");
    const page = new EventTarget();
    const stop = unlockAudio(context, { page });
    await settle();
    assert.equal(context.state, "suspended");

    // A touch's start does not grant activation, so it is not heard.
    page.dispatchEvent(new Event("pointerdown"));
    page.dispatchEvent(new Event("touchend"));
    await settle();
    assert.equal(context.resumes, 2);

    context.allow = true;
    page.dispatchEvent(new Event("pointerup"));
    await settle();
    assert.equal(context.resumes, 3);
    assert.equal(context.state, "running");

    // Running now, so the listeners are gone.
    page.dispatchEvent(new Event("click"));
    await settle();
    assert.equal(context.resumes, 3);
    stop();
  });

  test("hears a session's select, where the page hears nothing", async () => {
    const context = fakeContext("suspended");
    const session = new EventTarget();
    const stop = unlockAudio(context, { page: new EventTarget(), session });
    context.allow = true;
    session.dispatchEvent(new Event("select"));
    await settle();
    assert.equal(context.state, "running");
    stop();
  });

  test("stops listening when the context starts running on its own", async () => {
    const context = fakeContext("suspended");
    const page = new EventTarget();
    unlockAudio(context, { page });
    await settle();
    context.allow = true;
    await context.resume();
    const before = context.resumes;
    page.dispatchEvent(new Event("click"));
    await settle();
    assert.equal(context.resumes, before);
  });

  test("stops listening when stopped, however suspended", async () => {
    const context = fakeContext("suspended");
    const page = new EventTarget();
    const session = new EventTarget();
    const stop = unlockAudio(context, { page, session });
    await settle();
    stop();
    stop();
    page.dispatchEvent(new Event("click"));
    session.dispatchEvent(new Event("select"));
    await settle();
    assert.equal(context.resumes, 1);
  });

  test("leaves a running or closed context alone", async () => {
    for (const state of /** @type {const} */ (["running", "closed"])) {
      const context = fakeContext(state);
      const page = new EventTarget();
      unlockAudio(context, { page });
      page.dispatchEvent(new Event("click"));
      await settle();
      assert.equal(context.resumes, 0, state);
    }
  });

  test("tells Safari the page plays audio, through the silent switch", () => {
    const audioSession = { type: "auto" };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { audioSession },
    });
    unlockAudio(fakeContext("running"), { page: new EventTarget() });
    assert.equal(audioSession.type, "playback");
  });
});
