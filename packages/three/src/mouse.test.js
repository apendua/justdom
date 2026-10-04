import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionManager } from "./interactions.js";
import { followMouse } from "./mouse.js";

/**
 * @import { XREventMap } from './core.js';
 */

/**
 * A canvas 100 px square at the page's corner. An element of the test's
 * document rather than a bare `EventTarget`, since Node's own refuses the
 * document's events.
 *
 * @returns {HTMLElement}
 */
function stubCanvas() {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () =>
    /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 100 });
  return canvas;
}

/**
 * An event carrying what a `PointerEvent` would: where the mouse is and
 * which button.
 *
 * @param {string} type
 * @param {number} [clientX]
 * @param {number} [clientY]
 */
function pointer(type, clientX = 50, clientY = 50) {
  return Object.assign(new Event(type), { clientX, clientY, button: 0 });
}

describe("the mouse's stand-in controller", () => {
  /** @type {HTMLElement} */
  let canvas;
  /** @type {HTMLElement} */
  let view;
  /** @type {THREE.Group<XREventMap>} */
  let group;
  /** @type {() => void} */
  let stop;

  beforeEach(() => {
    canvas = stubCanvas();
    view = document.createElement("div");
    group = /** @type {THREE.Group<XREventMap>} */ (new THREE.Group());
    stop = followMouse(
      group,
      new THREE.PerspectiveCamera(),
      canvas,
      /** @type {Window} */ (/** @type {unknown} */ (view)),
    );
  });

  test("starts hidden, is shown by a move on the canvas and hidden when the mouse leaves it", () => {
    // A group is visible when it is made; following the mouse is what hides it.
    assert.equal(group.visible, false);
    canvas.dispatchEvent(pointer("pointermove"));
    assert.equal(group.visible, true);
    canvas.dispatchEvent(pointer("pointerleave"));
    assert.equal(group.visible, false);
  });

  test("aims from the camera through the point under the mouse", () => {
    // The middle of the canvas is straight down the camera's -Z.
    canvas.dispatchEvent(pointer("pointermove"));
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(group.quaternion);
    assert.ok(forward.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-9);
    // The right edge is off to the right.
    canvas.dispatchEvent(pointer("pointermove", 100, 50));
    forward.set(0, 0, -1).applyQuaternion(group.quaternion);
    assert.ok(forward.x > 0.1);
  });

  test("stays hidden for a release off the canvas, such as a click on the panel", () => {
    // The panel's own click: its press never reaches the canvas, and its
    // release reaches the window.
    canvas.dispatchEvent(pointer("pointermove"));
    canvas.dispatchEvent(pointer("pointerleave"));
    view.dispatchEvent(pointer("pointerup"));
    assert.equal(group.visible, false);
  });

  test("is hidden when it stops, so the next start points at nothing", () => {
    // A session starting with the mouse over the canvas: the listeners come
    // off, and whatever the mouse does meanwhile is not heard.
    canvas.dispatchEvent(pointer("pointermove"));
    stop();
    assert.equal(group.visible, false);
    canvas.dispatchEvent(pointer("pointermove"));
    assert.equal(group.visible, false);
  });

  test("misses when a press on a model is let go over the panel", () => {
    // Through the manager the pages use: a model straight ahead of the
    // camera, under the middle of the canvas.
    const manager = new InteractionManager();
    /** @type {Set<() => void>} */
    const frames = new Set();
    manager
      .addController(
        /** @type {THREE.XRTargetRaySpace} */ (/** @type {unknown} */ (group)),
        (fn) => {
          const frame = /** @type {() => void} */ (fn);
          frames.add(frame);
          return () => frames.delete(frame);
        },
      )
      .subscribe();
    const model = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    model.position.set(0, 0, -5);
    model.updateMatrixWorld();
    const target = /** @type {THREE.Object3D<XREventMap>} */ (/** @type {unknown} */ (model));
    manager.add(target);
    /** @type {string[]} */
    const events = [];
    for (const type of /** @type {const} */ (["select", "selectmissed"])) {
      target.addEventListener(type, () => events.push(type));
    }

    canvas.dispatchEvent(pointer("pointermove"));
    frames.forEach((fn) => fn());
    canvas.dispatchEvent(pointer("pointerdown"));
    canvas.dispatchEvent(pointer("pointerleave"));
    view.dispatchEvent(pointer("pointerup"));

    assert.deepEqual(events, ["selectmissed"]);
  });
});
