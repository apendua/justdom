import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { $ as $dom, attr as domAttr, children as domChildren } from "@apendua/justdom";
import { InteractionContext, InteractionManager } from "./interactions.js";
import { createBakery } from "./bakery.js";

// jsdom-env exposes the common DOM globals, but not MutationObserver, which
// the portals under the oven use to mirror their trees.
if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

// jsdom has no FontFaceSet, and VisualProperties consults it for x-height.
// Nothing here closes a loading period, so the stub only has to exist.
/** @type {Map<string, Set<(event: unknown) => void>>} */
const fontListeners = new Map();
if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: {
      status: "loaded",
      ready: Promise.resolve(),
      /**
       * @param {string} event
       * @param {(event: unknown) => void} handler
       */
      addEventListener(event, handler) {
        let handlers = fontListeners.get(event);
        if (!handlers) {
          handlers = new Set();
          fontListeners.set(event, handlers);
        }
        handlers.add(handler);
      },
      /**
       * @param {string} event
       * @param {(event: unknown) => void} handler
       */
      removeEventListener(event, handler) {
        fontListeners.get(event)?.delete(handler);
      },
    },
  });
}

// jsdom runs no animation frames, and both the portals and the oven borrow
// them. A queue flushed by hand is a frame source the test can stop.
/** @type {Array<FrameRequestCallback>} */
const frameCallbacks = [];
globalThis.requestAnimationFrame = (callback) => frameCallbacks.push(callback);
globalThis.cancelAnimationFrame = () => {};

function flushFrame() {
  for (const callback of frameCallbacks.splice(0, frameCallbacks.length)) {
    callback(0);
  }
}

function nextMacrotask() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Mount an oven and drive frames until it is ready, or give up. Bounded, so a
 * bakery that never bakes fails its test instead of hanging it.
 *
 * The oven stays mounted afterwards, and has to: unmounting it disconnects
 * the portals under it, which disposes the geometry and materials every stamp
 * is holding, and the copies come out empty. That is the constraint the
 * module's own comment is about, met here first.
 *
 * @param {ReturnType<typeof createBakery>} bakery
 * @returns {Promise<THREE.Group>}
 */
async function heat(bakery) {
  const scene = new THREE.Group();
  /** @type {(() => void) | undefined} */
  let stop;
  bakery.oven().subscribe((component) => {
    stop = component.addTo(scene);
  });
  assert.ok(stop, "the oven mounted nothing");
  for (let index = 0; index < 500 && !bakery.ready(); index++) {
    flushFrame();
    await nextMacrotask();
  }
  return scene;
}

/**
 * Every mesh under an object, which is what a stamp is made of.
 *
 * @param {THREE.Object3D | null} object
 * @returns {THREE.Mesh[]}
 */
function meshesOf(object) {
  assert.ok(object, "nothing to look inside");
  /** @type {THREE.Mesh[]} */
  const found = [];
  object.traverse((/** @type {THREE.Object3D} */ child) => {
    if (child instanceof THREE.Mesh) {
      found.push(child);
    }
  });
  return found;
}

/**
 * A face with something to draw: the portal builds a box for an element that
 * has a surface, and nothing at all for one that is only a container.
 */
const face = () =>
  $dom("div", [
    // A surface and a size: the portal draws a box for an element that has
    // something to draw, and jsdom lays nothing out that is not given
    // dimensions, so a face without both is a face with no geometry in it.
    domAttr("style", () => "background: #123456; width: 60px; height: 40px"),
    domChildren(
      $dom("div", [domAttr("style", () => "background: #abcdef; width: 20px; height: 10px")]),
      $dom("div", [domAttr("style", () => "background: #fedcba; width: 20px; height: 10px")]),
    ),
  ]);

describe("createBakery", () => {
  test("hands out nothing until the oven is done, and then copies", async () => {
    const ctx = InteractionContext.set({}, new InteractionManager());
    const bakery = createBakery(ctx, { card: face }, { settleFrames: 1 });

    assert.equal(bakery.ready(), false);
    assert.equal(bakery.stamp("card"), null, "a stamp before the oven is done");

    await heat(bakery);

    assert.equal(bakery.ready(), true);
    const first = bakery.stamp("card");
    const second = bakery.stamp("card");
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first, second, "two stamps are two objects");
  });

  test("stamps share what they are made of, which is the whole point", async () => {
    const ctx = InteractionContext.set({}, new InteractionManager());
    const bakery = createBakery(ctx, { card: face }, { settleFrames: 1 });
    await heat(bakery);

    const first = meshesOf(bakery.stamp("card"));
    const second = meshesOf(bakery.stamp("card"));
    assert.ok(first.length > 0, "the face drew nothing to copy");
    assert.equal(first.length, second.length);
    for (let index = 0; index < first.length; index++) {
      // Geometry and material are shared by reference: a stamp is a few
      // objects, not a second upload of everything the panel built.
      assert.equal(first[index].geometry, second[index].geometry);
      assert.equal(first[index].material, second[index].material);
    }
  });

  test("a stamp keeps its matrices, as the panel it came from does", async () => {
    const ctx = InteractionContext.set({}, new InteractionManager());
    const bakery = createBakery(ctx, { card: face }, { settleFrames: 1 });
    await heat(bakery);

    const stamp = bakery.stamp("card");
    assert.ok(stamp);
    // The override is `keepSubtreeMatrices`: an own property rather than the
    // prototype's, which is exactly why `clone()` loses it and why the bakery
    // puts it back.
    assert.ok(
      Object.prototype.hasOwnProperty.call(stamp, "updateMatrixWorld"),
      "the stamp was handed back three's own matrix walk",
    );

    // And it does the job: a subtree that has not moved is not marked as
    // having moved.
    const parent = new THREE.Group();
    parent.add(stamp);
    stamp.position.set(1, 2, 3);
    parent.updateMatrixWorld(true);
    const placed = stamp.matrixWorld.elements.slice();
    parent.updateMatrixWorld(true);
    assert.deepEqual(stamp.matrixWorld.elements.slice(), placed);
  });

  test("bakes every face it was given, and only those", async () => {
    const ctx = InteractionContext.set({}, new InteractionManager());
    const bakery = createBakery(ctx, { front: face, back: face }, { settleFrames: 1 });
    await heat(bakery);

    assert.ok(bakery.stamp("front"));
    assert.ok(bakery.stamp("back"));
    // A name nobody registered is a typo, not something to wait for.
    assert.throws(() => bakery.stamp("middle"), /No face called "middle"/);
  });

  test("the oven leaves the render walk once it is done", async () => {
    const ctx = InteractionContext.set({}, new InteractionManager());
    const bakery = createBakery(ctx, { card: face }, { settleFrames: 1 });
    const scene = await heat(bakery);

    const oven = scene.children[0];
    assert.ok(oven);
    assert.equal(oven.visible, false, "a finished oven is still being drawn");
  });
});
