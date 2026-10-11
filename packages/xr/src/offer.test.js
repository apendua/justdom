import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

// The emulator's chunk, gone after a deploy: a copy of `offer.js` loaded
// with `gone` in its query cannot import `./emulator.js`, as a page whose
// precache names a chunk the server no longer has cannot. A hook, since
// the import is `offer.js`'s own and the test cannot hand it another.
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === "./emulator.js" && context.parentURL?.includes("gone")) {
        throw new Error("Failed to fetch dynamically imported module");
      }
      return next(specifier, context);
    }
  `)}`,
);

/** How many times the page asked to be reloaded. */
let reloads = 0;

/** A page at an address with this query, which counts its reloads. */
function at(search = "") {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { search, reload: () => (reloads += 1) },
  });
}

/**
 * A platform whose `navigator.xr` supports the given modes, or none at all.
 *
 * @param {XRSessionMode[] | null} modes
 */
function platform(modes) {
  Object.defineProperty(navigator, "xr", {
    configurable: true,
    value: modes && {
      isSessionSupported: async (/** @type {XRSessionMode} */ mode) => modes.includes(mode),
    },
  });
}

/**
 * A service worker container controlled by `controller`, which the test
 * replaces by calling the returned function, as an activating worker that
 * claims its clients does.
 *
 * @param {object | null} controller
 * @returns {(next: object) => void}
 */
function workers(controller) {
  const container = Object.assign(new EventTarget(), { controller });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  return (next) => {
    container.controller = next;
    container.dispatchEvent(new Event("controllerchange"));
  };
}

/** How many copies of the module have been loaded. */
let loads = 0;

/**
 * A fresh copy of the module, as a page loads it: it reads the worker that
 * served the page as it loads, and remembers a reload it has asked for.
 * With `gone`, the copy cannot import the emulator (see the hook above).
 *
 * @param {"gone"} [emulator]
 * @returns {Promise<typeof import("./offer.js")>}
 */
const offerModule = (emulator) =>
  import(`./offer.js?load=${(loads += 1)}${emulator ? `&${emulator}` : ""}`);

/** Let the promise callbacks queued so far run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A scene module, as a dynamic import resolves to it, counting its loads. */
function sceneLoader() {
  const loader = async () => {
    loader.loaded += 1;
    return { offerXR() {} };
  };
  loader.loaded = 0;
  return loader;
}

/** An import of a chunk a deploy has taken away. */
const gone = () => Promise.reject(new Error("Failed to fetch dynamically imported module"));

describe("offerHeadset", () => {
  beforeEach(() => {
    reloads = 0;
    at();
  });
  afterEach(() => {
    platform(null);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
  });

  it("does not load the scene, and three.js with it, where there is no WebXR", async () => {
    platform(null);
    const scene = sceneLoader();
    const { offerHeadset } = await offerModule();
    assert.equal(await offerHeadset(scene), null);
    assert.equal(scene.loaded, 0);
  });

  it("does not load it where WebXR supports no immersive session", async () => {
    platform([]);
    const scene = sceneLoader();
    const { offerHeadset } = await offerModule();
    assert.equal(await offerHeadset(scene), null);
    assert.equal(scene.loaded, 0);
  });

  it("loads it, and hands it over, where a session can be opened", async () => {
    platform(["immersive-vr"]);
    const scene = sceneLoader();
    const { offerHeadset } = await offerModule();
    const loaded = await offerHeadset(scene);
    assert.equal(scene.loaded, 1);
    assert.equal(typeof loaded?.offerXR, "function");
  });

  describe("when the scene's chunk is gone after a deploy", () => {
    beforeEach(() => platform(["immersive-vr"]));

    it("reloads once the new worker has taken the page over", async () => {
      const replace = workers({});
      const { offerHeadset } = await offerModule();
      await assert.rejects(offerHeadset(gone));
      await settle();
      assert.equal(reloads, 0);
      replace({});
      await settle();
      assert.equal(reloads, 1);
    });

    it("reloads at once if the new worker took over before the import failed", async () => {
      const replace = workers({});
      const { offerHeadset } = await offerModule();
      const offered = offerHeadset(gone);
      replace({});
      await assert.rejects(offered);
      await settle();
      assert.equal(reloads, 1);
    });

    it("asks for one reload however many imports fail", async () => {
      const replace = workers({});
      const { offerHeadset } = await offerModule();
      await assert.rejects(offerHeadset(gone));
      await assert.rejects(offerHeadset(gone));
      replace({});
      await settle();
      assert.equal(reloads, 1);
    });

    it("does not reload a page no worker serves", async () => {
      const { offerHeadset } = await offerModule();
      await assert.rejects(offerHeadset(gone));
      await settle();
      assert.equal(reloads, 0);
    });
  });

  describe("when the emulator's chunk is gone after a deploy", () => {
    beforeEach(() => {
      // As on a laptop: no WebXR until the emulator installs one, which it
      // cannot.
      platform(null);
      at("?emulator");
    });

    it("says so, offers nothing, and reloads once the new worker has the page", async () => {
      const replace = workers({});
      const scene = sceneLoader();
      const { offerHeadset } = await offerModule("gone");
      /** @type {unknown[][]} */
      const logged = [];
      const error = console.error;
      console.error = (...args) => logged.push(args);
      try {
        assert.equal(await offerHeadset(scene), null);
      } finally {
        console.error = error;
      }
      assert.equal(logged.length, 1);
      assert.equal(scene.loaded, 0);
      await settle();
      assert.equal(reloads, 0);
      replace({});
      await settle();
      assert.equal(reloads, 1);
    });
  });
});
