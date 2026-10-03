import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** How often the scene module was loaded, and how often it was offered. */
const scene = vi.hoisted(() => ({ loaded: 0, offered: 0 }));

vi.mock("./xr", () => {
  scene.loaded += 1;
  return {
    offerXR: () => {
      scene.offered += 1;
    },
  };
});

/** A platform whose `navigator.xr` supports the given modes, or none at all. */
function platform(modes: XRSessionMode[] | null): void {
  Object.defineProperty(navigator, "xr", {
    configurable: true,
    value: modes && {
      isSessionSupported: async (mode: XRSessionMode) => modes.includes(mode),
    },
  });
}

describe("offerHeadset", () => {
  beforeEach(() => {
    vi.resetModules();
    scene.loaded = 0;
    scene.offered = 0;
  });
  afterEach(() => {
    platform(null);
  });

  const offer = async () => {
    const { offerHeadset } = await import("./offer");
    await offerHeadset(document.createElement("div"), document.createElement("div"));
  };

  it("does not load the scene, and three.js with it, where there is no WebXR", async () => {
    platform(null);
    await offer();
    expect(scene.loaded).toBe(0);
  });

  it("does not load it where WebXR supports no immersive session", async () => {
    platform([]);
    await offer();
    expect(scene.loaded).toBe(0);
  });

  it("loads and offers it where a session can be opened", async () => {
    platform(["immersive-vr"]);
    await offer();
    expect(scene).toEqual({ loaded: 1, offered: 1 });
  });
});
