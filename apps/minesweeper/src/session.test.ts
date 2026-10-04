import { beforeEach, describe, expect, it } from "vitest";
import { backdropShown, canPassThrough, enterSession, passthrough, xrSession } from "./session.js";

/** A session with nothing on it but the one thing these read. */
function session(environmentBlendMode: XREnvironmentBlendMode): XRSession {
  return { environmentBlendMode } as XRSession;
}

describe("the passthrough", () => {
  beforeEach(() => enterSession(null));

  it("is on offer only in a session that composites the room behind the frame", () => {
    expect(canPassThrough()).toBe(false);
    enterSession(session("opaque"));
    expect(canPassThrough()).toBe(false);
    enterSession(session("additive"));
    expect(canPassThrough()).toBe(false);
    enterSession(session("alpha-blend"));
    expect(canPassThrough()).toBe(true);
  });

  it("starts off in every session, whatever the last one was left at", () => {
    enterSession(session("alpha-blend"));
    passthrough.set(true);
    enterSession(null);
    enterSession(session("alpha-blend"));
    expect(passthrough.get()).toBe(false);
    expect(xrSession.get()).not.toBe(null);
  });
});

describe("the backdrop", () => {
  beforeEach(() => enterSession(null));

  it("is not needed on the page", () => {
    expect(backdropShown()).toBe(false);
  });

  it("stands round the viewer in a session until the room is asked for", () => {
    enterSession(session("alpha-blend"));
    expect(backdropShown()).toBe(true);
    passthrough.set(true);
    expect(backdropShown()).toBe(false);
  });

  it("stays up where the room cannot be shown, whatever the switch says", () => {
    enterSession(session("opaque"));
    passthrough.set(true);
    expect(backdropShown()).toBe(true);
  });
});
