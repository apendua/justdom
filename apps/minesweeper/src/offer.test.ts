import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** How often the scene module was loaded, and how often it was offered. */
const scene = vi.hoisted(() => {
  const counts = { loaded: 0, offered: 0 };
  return {
    counts,
    module: () => {
      counts.loaded += 1;
      return {
        offerXR: () => {
          counts.offered += 1;
        },
      };
    },
  };
});

vi.mock("./xr", scene.module);

/** A platform whose `navigator.xr` supports the given modes, or none at all. */
function platform(modes: XRSessionMode[] | null): void {
  Object.defineProperty(navigator, "xr", {
    configurable: true,
    value: modes && {
      isSessionSupported: async (mode: XRSessionMode) => modes.includes(mode),
    },
  });
}

/**
 * A service worker container controlled by `controller`, which the test
 * replaces by calling the returned function, as an activating worker that
 * claims its clients does.
 */
function workers(controller: object | null): (next: object) => void {
  const container = Object.assign(new EventTarget(), { controller });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  return (next) => {
    container.controller = next;
    container.dispatchEvent(new Event("controllerchange"));
  };
}

describe("offerHeadset", () => {
  const reload = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    scene.counts.loaded = 0;
    scene.counts.offered = 0;
    reload.mockReset();
    vi.stubGlobal("location", { search: "", reload });
  });
  afterEach(() => {
    platform(null);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
    vi.unstubAllGlobals();
  });

  const offer = async () => {
    const { offerHeadset } = await import("./offer");
    await offerHeadset(document.createElement("div"), document.createElement("div"));
  };

  it("does not load the scene, and three.js with it, where there is no WebXR", async () => {
    platform(null);
    await offer();
    expect(scene.counts.loaded).toBe(0);
  });

  it("does not load it where WebXR supports no immersive session", async () => {
    platform([]);
    await offer();
    expect(scene.counts.loaded).toBe(0);
  });

  it("loads and offers it where a session can be opened", async () => {
    platform(["immersive-vr"]);
    await offer();
    expect(scene.counts).toEqual({ loaded: 1, offered: 1 });
  });

  describe("when the scene's chunk is gone after a deploy", () => {
    beforeEach(() => {
      platform(["immersive-vr"]);
      // A failing factory, registered for each test: a factory's result
      // outlives `resetModules`.
      vi.doMock("./xr", () => {
        throw new Error("Failed to fetch dynamically imported module");
      });
    });
    afterEach(() => {
      vi.doMock("./xr", scene.module);
    });

    it("reloads once the new worker has taken the page over", async () => {
      const replace = workers({});
      await expect(offer()).rejects.toThrow();
      expect(reload).not.toHaveBeenCalled();
      replace({});
      await Promise.resolve();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("reloads at once if the new worker took over before the import failed", async () => {
      const replace = workers({});
      const { offerHeadset } = await import("./offer");
      const offered = offerHeadset(document.createElement("div"), document.createElement("div"));
      replace({});
      await expect(offered).rejects.toThrow();
      await Promise.resolve();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("does not reload a page no worker serves", async () => {
      await expect(offer()).rejects.toThrow();
      await Promise.resolve();
      expect(reload).not.toHaveBeenCalled();
    });
  });

  describe("when the emulator's chunk is gone after a deploy", () => {
    beforeEach(() => {
      // As on a laptop: no WebXR until the emulator installs one, which it
      // cannot.
      platform(null);
      vi.stubGlobal("location", { search: "?emulator", reload });
      vi.doMock("./emulator", () => {
        throw new Error("Failed to fetch dynamically imported module");
      });
    });
    afterEach(() => {
      vi.doUnmock("./emulator");
    });

    it("reloads once the new worker has taken the page over", async () => {
      const replace = workers({});
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await offer();
      logged.mockRestore();
      expect(reload).not.toHaveBeenCalled();
      replace({});
      await Promise.resolve();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });
});
