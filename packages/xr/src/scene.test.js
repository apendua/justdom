import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as THREE from "three";
import { Derived } from "justdom-signal";
import { Backdrop, clientRect, inputModels } from "./scene.js";

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
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://example.test/apps/euclid/?emulator" },
    });
    // Records what is asked for, and answers nothing, as a headset with no
    // network would.
    globalThis.fetch = async (input) => {
      fetched.push(input instanceof Request ? input.url : String(input));
      throw new TypeError("Failed to fetch");
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Let the promise callbacks queued so far run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("asks for a controller's model from the app's own profiles", async () => {
    const { createControllerModel } = inputModels("/apps/euclid/");
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
    assert.deepEqual(fetched, ["https://example.test/apps/euclid/profiles/profilesList.json"]);
  });

  it("and a tracked hand's from the same tree", async () => {
    const { createHandModel } = inputModels("/apps/euclid/");
    const hand = /** @type {THREE.XRHandSpace} */ (new THREE.Group());
    createHandModel(hand);
    hand.dispatchEvent(
      /** @type {any} */ ({ type: "connected", data: { handedness: "left", hand: {} } }),
    );
    await settle();
    assert.deepEqual(fetched, ["https://example.test/apps/euclid/profiles/generic-hand/left.glb"]);
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
