import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "./interactions.js";
import { followMouse, mouse } from "./mouse.js";
import { CameraContext, RendererContext, runFrame } from "./render.js";
import { clientRect } from "./test/clientRect.js";
import { fakeFrameLoop } from "./test/frameLoop.js";

/**
 * @import { XREventMap } from './core.js';
 */

/**
 * The page's canvas, 100 px square at its corner. An element of the test's
 * document rather than a bare `EventTarget`, since Node's own refuses the
 * document's events.
 *
 * @returns {HTMLElement}
 */
function pageCanvas() {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => clientRect(0, 0, 100, 100);
  return canvas;
}

/**
 * A box straight ahead of the camera, under the middle of the canvas,
 * registered with `manager`, and the events it hears.
 *
 * @param {InteractionManager} manager
 */
function modelAhead(manager) {
  const model = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  model.position.set(0, 0, -5);
  model.updateMatrixWorld();
  const target = /** @type {THREE.Object3D<XREventMap>} */ (/** @type {unknown} */ (model));
  manager.add(target);
  /** @type {string[]} */
  const events = [];
  for (const type of /** @type {const} */ (["pointerenter", "select", "selectmissed"])) {
    target.addEventListener(type, () => events.push(type));
  }
  return events;
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
    canvas = pageCanvas();
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
    // Through the manager the pages use.
    const manager = new InteractionManager();
    const loop = fakeFrameLoop();
    manager
      .addController(
        /** @type {THREE.XRTargetRaySpace} */ (/** @type {unknown} */ (group)),
        loop.onAnimationFrame,
      )
      .subscribe();
    const events = modelAhead(manager);

    canvas.dispatchEvent(pointer("pointermove"));
    loop.run();
    canvas.dispatchEvent(pointer("pointerdown"));
    canvas.dispatchEvent(pointer("pointerleave"));
    view.dispatchEvent(pointer("pointerup"));

    assert.deepEqual(events, ["pointerenter", "selectmissed"]);
  });
});

describe("mouse(ctx)", () => {
  test("casts in the late phase, after what moves the scene in useFrame", () => {
    const manager = new InteractionManager();
    const canvas = pageCanvas();
    // A renderer with no session, which is all `mouse` reads of one.
    const xr = Object.assign(document.createElement("div"), { getSession: () => null });
    const renderer = /** @type {THREE.WebGLRenderer} */ (
      /** @type {unknown} */ ({ domElement: canvas, xr })
    );
    const ctx = RendererContext.set(
      CameraContext.set(InteractionContext.set({}, manager), new THREE.PerspectiveCamera()),
      renderer,
    );
    const events = modelAhead(manager);
    const scene = new THREE.Scene();
    const subscription = mouse(ctx).subscribe((component) => {
      component.addTo(scene);
    });

    canvas.dispatchEvent(pointer("pointermove"));
    // Mounted, and following the mouse.
    assert.equal(scene.children[0]?.visible, true);
    // The early phase only: what `useFrame` callbacks are run in. A cast
    // here would read the matrices before this frame's moves.
    runFrame(renderer, 0, /** @type {XRFrame} */ (/** @type {unknown} */ ({})));
    assert.deepEqual(events, []);
    subscription.unsubscribe();
  });
});
