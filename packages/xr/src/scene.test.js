import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as THREE from "three";
import { Derived } from "justdom-signal";
import { $, RendererContext } from "justdom-three";
import { setupJsdom } from "@apendua/jsdom-env";
import { Backdrop, clientRect, inputModels, sessionCanvas, whilePresenting } from "./scene.js";

/**
 * As much of a renderer as the session helpers read: a canvas, and an `xr`
 * that says which session it has and announces one starting and ending.
 */
function fakeRenderer() {
  /** @type {object | null} */
  let session = null;
  /** @type {THREE.EventDispatcher<{ sessionstart: {}; sessionend: {} }>} */
  const events = new THREE.EventDispatcher();
  const xr = Object.assign(events, { getSession: () => session });
  Object.defineProperty(xr, "isPresenting", { get: () => session !== null });
  return {
    renderer: /** @type {THREE.WebGLRenderer} */ (
      /** @type {unknown} */ ({ domElement: document.createElement("canvas"), xr })
    ),
    start: () => {
      session = {};
      xr.dispatchEvent({ type: "sessionstart" });
    },
    end: () => {
      session = null;
      xr.dispatchEvent({ type: "sessionend" });
    },
  };
}

describe("sessionCanvas", () => {
  beforeEach(() => {
    setupJsdom();
  });

  it("puts the canvas over the page, and shows it only while a session runs", () => {
    const { renderer, start, end } = fakeRenderer();
    const canvas = renderer.domElement;
    sessionCanvas(renderer);
    assert.equal(canvas.parentElement, document.body);
    assert.equal(canvas.style.position, "fixed");
    assert.equal(canvas.style.zIndex, "1");
    assert.equal(canvas.style.display, "none");

    start();
    assert.equal(canvas.style.display, "block");
    end();
    assert.equal(canvas.style.display, "none");
  });

  it("stands where the page says, and shows at once in a session already running", () => {
    const { renderer, start } = fakeRenderer();
    start();
    sessionCanvas(renderer, { zIndex: 60 });
    assert.equal(renderer.domElement.style.zIndex, "60");
    assert.equal(renderer.domElement.style.display, "block");
  });

  it("takes the canvas out and stops listening when it is undone", () => {
    const { renderer, start } = fakeRenderer();
    const canvas = renderer.domElement;
    const undo = sessionCanvas(renderer);
    undo();
    assert.equal(canvas.parentElement, null);
    start();
    assert.equal(canvas.style.display, "none");
  });
});

describe("whilePresenting", () => {
  it("mounts what it renders for each session, and takes it down as the session ends", () => {
    const { renderer, start, end } = fakeRenderer();
    const ctx = RendererContext.set({}, renderer);
    const parent = new THREE.Group();
    let rendered = 0;
    /** @type {(() => void) | undefined} */
    let remove;
    const subscription = whilePresenting(ctx, () => {
      rendered += 1;
      return $(new THREE.Object3D());
    }).subscribe((component) => {
      remove = component.addTo(parent);
    });
    assert.equal(parent.children.length, 0);
    assert.equal(rendered, 0);

    start();
    assert.equal(parent.children.length, 1);
    const first = parent.children[0];
    end();
    assert.equal(parent.children.length, 0);

    start();
    assert.equal(rendered, 2);
    assert.notEqual(parent.children[0], first, "a new object for the new session");

    remove?.();
    subscription.unsubscribe();
    assert.equal(parent.children.length, 0);
  });
});

describe("Backdrop", () => {
  it("lets its material go when it is taken down", () => {
    /** @type {THREE.Material[]} */
    const disposed = [];
    const dispose = THREE.MeshBasicMaterial.prototype.dispose;
    THREE.MeshBasicMaterial.prototype.dispose = function () {
      disposed.push(this);
      dispose.call(this);
    };
    try {
      const mounted = Backdrop("#1e2430").subscribe({});
      assert.equal(disposed.length, 0);
      mounted.unsubscribe();
      assert.equal(disposed.length, 1);
    } finally {
      THREE.MeshBasicMaterial.prototype.dispose = dispose;
    }
  });
});

describe("inputModels", () => {
  /** @type {string[]} */
  let fetched = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetched = [];
    // Records what is asked for, and answers nothing, as a headset with no
    // network would.
    globalThis.fetch = async (input) => {
      fetched.push(input instanceof Request ? input.url : String(input));
      throw new TypeError("Failed to fetch");
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (/** @type {any} */ (globalThis).location);
  });

  /** Let the promise callbacks queued so far run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("asks for a controller's model from three's default CDN", async () => {
    const { createControllerModel } = inputModels();
    const grip = /** @type {THREE.XRGripSpace} */ (new THREE.Group());
    createControllerModel(grip);
    // three warns that the fetch failed, which is the point here.
    const warn = console.warn;
    console.warn = () => {};
    grip.dispatchEvent(
      /** @type {any} */ ({
        type: "connected",
        data: {
          targetRayMode: "tracked-pointer",
          handedness: "right",
          profiles: ["meta-quest-touch-plus"],
          gamepad: {},
        },
      }),
    );
    await settle();
    console.warn = warn;
    assert.deepEqual(fetched, [
      "https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/profilesList.json",
    ]);
  });

  it("and a tracked hand's from the same tree", async () => {
    const { createHandModel } = inputModels();
    const hand = /** @type {THREE.XRHandSpace} */ (new THREE.Group());
    createHandModel(hand);
    hand.dispatchEvent(
      /** @type {any} */ ({ type: "connected", data: { handedness: "left", hand: {} } }),
    );
    await settle();
    assert.deepEqual(fetched, [
      "https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/left.glb",
    ]);
  });

  it("asks for a controller's model from the app's own profiles when named", async () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://example.test/apps/euclid/?emulator" },
    });
    const { createControllerModel } = inputModels("/apps/euclid/profiles");
    const grip = /** @type {THREE.XRGripSpace} */ (new THREE.Group());
    createControllerModel(grip);
    const warn = console.warn;
    console.warn = () => {};
    grip.dispatchEvent(
      /** @type {any} */ ({
        type: "connected",
        data: {
          targetRayMode: "tracked-pointer",
          handedness: "right",
          profiles: ["meta-quest-touch-plus"],
          gamepad: {},
        },
      }),
    );
    await settle();
    console.warn = warn;
    assert.deepEqual(fetched, ["https://example.test/apps/euclid/profiles/profilesList.json"]);
  });

  it("and a tracked hand's from the same tree, with or without a trailing slash", async () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://example.test/apps/euclid/?emulator" },
    });
    for (const profiles of ["profiles", "profiles/"]) {
      fetched = [];
      const { createHandModel } = inputModels(profiles);
      const hand = /** @type {THREE.XRHandSpace} */ (new THREE.Group());
      createHandModel(hand);
      hand.dispatchEvent(
        /** @type {any} */ ({ type: "connected", data: { handedness: "left", hand: {} } }),
      );
      await settle();
      assert.deepEqual(fetched, [
        "https://example.test/apps/euclid/profiles/generic-hand/left.glb",
      ]);
    }
  });
});

describe("clientRect", () => {
  /** @type {Set<(entries: ResizeObserverEntry[]) => void>} */
  const observing = new Set();

  beforeEach(() => {
    globalThis.ResizeObserver = /** @type {any} */ (
      class {
        /** @param {(entries: ResizeObserverEntry[]) => void} callback */
        constructor(callback) {
          this.callback = callback;
        }
        observe() {
          observing.add(this.callback);
        }
        disconnect() {
          observing.delete(this.callback);
        }
      }
    );
  });
  afterEach(() => {
    observing.clear();
    // @ts-expect-error Node has none, and the test put one there.
    delete globalThis.ResizeObserver;
  });

  /** An element whose rect is whatever `size` says when it is read. */
  function element() {
    const size = { width: 400, height: 300 };
    const rect = () => /** @type {DOMRect} */ ({ ...size, left: 0, top: 0 });
    return { size, element: /** @type {Element} */ ({ getBoundingClientRect: rect }) };
  }

  /** Tell every observer its element was resized. */
  const resized = () => {
    for (const callback of observing) {
      callback([]);
    }
  };

  it("is read again when the element is resized", () => {
    const { size, element: board } = element();
    let reads = 0;
    const width = new Derived(() => {
      reads += 1;
      return clientRect(board).width;
    });
    const watching = width.subscribe({});
    assert.equal(width.get(), 400);
    size.width = 600;
    resized();
    assert.equal(width.get(), 600);
    assert.equal(reads, 2);
    watching.unsubscribe();
  });

  it("stops observing the element once nothing reads it", () => {
    const { element: board } = element();
    const width = new Derived(() => clientRect(board).width);
    const watching = width.subscribe({});
    width.get();
    assert.equal(observing.size, 1);
    watching.unsubscribe();
    assert.equal(observing.size, 0);
  });

  it("keeps observing the element through the reads a resize causes", () => {
    const { element: board } = element();
    const width = new Derived(() => clientRect(board).width);
    const watching = width.subscribe({});
    width.get();
    const [observer] = observing;
    resized();
    width.get();
    // The same observer, not a new one per read: a new one would report the
    // element's size on its first observation, and that would be read as a
    // resize and run the reader again, for ever.
    assert.deepEqual([...observing], [observer]);
    watching.unsubscribe();
  });
});
