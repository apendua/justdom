import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  backdropShown,
  canPassThrough,
  canPresent,
  enterSession,
  passthrough,
  xrSession,
} from "./session.js";

/**
 * A session with nothing on it but the one thing these read.
 *
 * @param {XREnvironmentBlendMode} environmentBlendMode
 * @returns {XRSession}
 */
function session(environmentBlendMode) {
  return /** @type {XRSession} */ (/** @type {unknown} */ ({ environmentBlendMode }));
}

describe("the passthrough", () => {
  beforeEach(() => enterSession(null));

  it("is on offer only in a session that composites the room behind the frame", () => {
    assert.equal(canPassThrough(), false);
    enterSession(session("opaque"));
    assert.equal(canPassThrough(), false);
    enterSession(session("additive"));
    assert.equal(canPassThrough(), false);
    enterSession(session("alpha-blend"));
    assert.equal(canPassThrough(), true);
  });

  it("starts off in every session, whatever the last one was left at", () => {
    enterSession(session("alpha-blend"));
    passthrough.set(true);
    enterSession(null);
    enterSession(session("alpha-blend"));
    assert.equal(passthrough.get(), false);
    assert.notEqual(xrSession.get(), null);
  });
});

describe("the backdrop", () => {
  beforeEach(() => enterSession(null));

  it("is not needed on the page", () => {
    assert.equal(backdropShown(), false);
  });

  it("stands round the viewer in a session until the room is asked for", () => {
    enterSession(session("alpha-blend"));
    assert.equal(backdropShown(), true);
    passthrough.set(true);
    assert.equal(backdropShown(), false);
  });

  it("stays up where the room cannot be shown, whatever the switch says", () => {
    enterSession(session("opaque"));
    passthrough.set(true);
    assert.equal(backdropShown(), true);
  });
});

describe("canPresent", () => {
  /**
   * A platform whose WebXR supports `modes`, or one with no WebXR at all.
   *
   * @param {XRSessionMode[] | null} modes
   * @param {boolean} [throws] Whether asking about a mode rejects instead.
   */
  function platform(modes, throws = false) {
    Object.defineProperty(globalThis.navigator, "xr", {
      configurable: true,
      value: modes && {
        /** @param {XRSessionMode} mode */
        isSessionSupported: async (mode) => {
          if (throws) {
            throw new Error("SecurityError");
          }
          return modes.includes(mode);
        },
      },
    });
  }

  afterEach(() => platform(null));

  it("is false with no WebXR", async () => {
    platform(null);
    assert.equal(await canPresent(), false);
  });

  it("is false where WebXR supports no immersive session", async () => {
    platform(["inline"]);
    assert.equal(await canPresent(), false);
  });

  it("is false where asking is refused", async () => {
    platform(["immersive-vr"], true);
    assert.equal(await canPresent(), false);
  });

  it("is true for either immersive mode", async () => {
    platform(["immersive-vr"]);
    assert.equal(await canPresent(), true);
    platform(["immersive-ar"]);
    assert.equal(await canPresent(), true);
  });
});
