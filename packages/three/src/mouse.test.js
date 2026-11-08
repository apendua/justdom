import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "./interactions.js";
import {
  followMouse,
  HOLD_MS,
  MIN_REACH,
  mouse,
  PITCH_LIMIT,
  SLOP_PX,
  WHEEL_METRES_PER_PIXEL,
} from "./mouse.js";
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
  for (const type of /** @type {const} */ ([
    "pointerenter",
    "selectstart",
    "select",
    "selectmissed",
    "squeezestart",
    "squeeze",
    "squeezemissed",
  ])) {
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
  return Object.assign(new Event(type, { bubbles: true }), { clientX, clientY, button: 0 });
}

/**
 * The same with the right button.
 *
 * @param {string} type
 */
function rightButton(type) {
  return Object.assign(pointer(type), { button: 2 });
}

/**
 * A finger's event: a touch pointer, the first finger down unless `id` says
 * otherwise.
 *
 * @param {string} type
 * @param {number} [clientX]
 * @param {number} [clientY]
 * @param {number} [id]
 */
function finger(type, clientX = 50, clientY = 50, id = 1) {
  return Object.assign(pointer(type, clientX, clientY), {
    pointerType: "touch",
    pointerId: id,
    isPrimary: id === 1,
  });
}

/**
 * A group following `canvas`, registered with a manager that casts on
 * `loop`, and the events a box straight ahead of it hears.
 *
 * @param {HTMLElement} canvas
 * @param {HTMLElement} view
 */
function pointedAt(canvas, view) {
  const group = /** @type {THREE.Group<XREventMap>} */ (new THREE.Group());
  const stop = followMouse(
    group,
    new THREE.PerspectiveCamera(),
    canvas,
    /** @type {Window} */ (/** @type {unknown} */ (view)),
  );
  const manager = new InteractionManager();
  const loop = fakeFrameLoop();
  manager
    .addController(
      /** @type {THREE.XRTargetRaySpace} */ (/** @type {unknown} */ (group)),
      loop.onAnimationFrame,
    )
    .subscribe();
  const events = modelAhead(manager);
  return { group, stop, loop, events };
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

    assert.deepEqual(events, ["pointerenter", "selectstart", "selectmissed"]);
  });
});

describe("the mouse's right button", () => {
  test("is the grip: a press and release on a model squeeze it", () => {
    const canvas = pageCanvas();
    const view = document.createElement("div");
    view.append(canvas);
    const { loop, events } = pointedAt(canvas, view);
    canvas.dispatchEvent(pointer("pointermove"));
    loop.run();
    canvas.dispatchEvent(rightButton("pointerdown"));
    // Heard on the view, where it bubbles to.
    canvas.dispatchEvent(rightButton("pointerup"));
    assert.deepEqual(events, ["pointerenter", "squeezestart", "squeeze"]);
  });

  test("opens no context menu on the canvas while it follows, and does once it stops", () => {
    const canvas = pageCanvas();
    const view = document.createElement("div");
    const { stop } = pointedAt(canvas, view);
    const menu = new Event("contextmenu", { cancelable: true });
    canvas.dispatchEvent(menu);
    assert.equal(menu.defaultPrevented, true);
    stop();
    const after = new Event("contextmenu", { cancelable: true });
    canvas.dispatchEvent(after);
    assert.equal(after.defaultPrevented, false);
  });
});

describe("a finger on the canvas", () => {
  /** @type {HTMLElement} */
  let canvas;
  /** @type {HTMLElement} */
  let view;
  /** @type {ReturnType<typeof pointedAt>} */
  let at;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    canvas = pageCanvas();
    view = document.createElement("div");
    view.append(canvas);
    at = pointedAt(canvas, view);
  });

  afterEach(() => {
    at.stop();
    mock.timers.reset();
  });

  test("keeps the browser's pan and zoom off the canvas until it stops", () => {
    // A canvas of its own, which nothing else is following.
    const own = pageCanvas();
    own.style.touchAction = "pan-y";
    const group = /** @type {THREE.Group<XREventMap>} */ (new THREE.Group());
    const stop = followMouse(group, new THREE.PerspectiveCamera(), own);
    assert.equal(own.style.touchAction, "none");
    stop();
    assert.equal(own.style.touchAction, "pan-y");
  });

  test("taps: lifted where it landed, before the hold, it selects", () => {
    canvas.dispatchEvent(finger("pointerdown"));
    assert.equal(at.group.visible, true);
    canvas.dispatchEvent(finger("pointerup"));
    assert.deepEqual(at.events, ["selectstart", "select"]);
    // No hover on a touch screen: the ray goes with the finger.
    assert.equal(at.group.visible, false);
  });

  test("taps when it wanders no further than the slop", () => {
    canvas.dispatchEvent(finger("pointerdown"));
    canvas.dispatchEvent(finger("pointermove", 50 + SLOP_PX, 50));
    canvas.dispatchEvent(finger("pointerup", 50 + SLOP_PX, 50));
    assert.deepEqual(at.events, ["selectstart", "select"]);
  });

  test("held still, grips what it landed on, and lets go when it lifts", () => {
    canvas.dispatchEvent(finger("pointerdown"));
    mock.timers.tick(HOLD_MS - 1);
    assert.deepEqual(at.events, []);
    mock.timers.tick(1);
    assert.deepEqual(at.events, ["squeezestart"]);
    canvas.dispatchEvent(finger("pointerup"));
    assert.deepEqual(at.events, ["squeezestart", "squeeze"]);
  });

  test("dragged, presses the trigger where it landed, not where the drag has got to", () => {
    // Lands on the model, then leaves it for the edge of the canvas: the
    // press is the model's, and the release off it is a miss.
    canvas.dispatchEvent(finger("pointerdown"));
    canvas.dispatchEvent(finger("pointermove", 100, 0));
    assert.deepEqual(at.events, ["selectstart"]);
    canvas.dispatchEvent(finger("pointerup", 100, 0));
    assert.deepEqual(at.events, ["selectstart", "selectmissed"]);
    // And no hold comes after a drag.
    mock.timers.tick(HOLD_MS);
    assert.deepEqual(at.events, ["selectstart", "selectmissed"]);
  });

  test("dragged from nothing onto the model, presses nothing", () => {
    canvas.dispatchEvent(finger("pointerdown", 0, 0));
    canvas.dispatchEvent(finger("pointermove", 50, 50));
    canvas.dispatchEvent(finger("pointerup", 50, 50));
    assert.deepEqual(at.events, []);
  });

  test("ignores a second finger while the first is down", () => {
    canvas.dispatchEvent(finger("pointerdown"));
    canvas.dispatchEvent(finger("pointerdown", 0, 0, 2));
    canvas.dispatchEvent(finger("pointermove", 0, 0, 2));
    canvas.dispatchEvent(finger("pointerup", 0, 0, 2));
    assert.deepEqual(at.events, []);
    canvas.dispatchEvent(finger("pointerup"));
    assert.deepEqual(at.events, ["selectstart", "select"]);
  });

  test("cancelled by the browser mid-grip, lets go as a hand that went", () => {
    canvas.dispatchEvent(finger("pointerdown"));
    mock.timers.tick(HOLD_MS);
    canvas.dispatchEvent(finger("pointercancel"));
    assert.deepEqual(at.events, ["squeezestart", "squeezemissed"]);
    assert.equal(at.group.visible, false);
  });

  test("cancelled before anything was decided, presses nothing, then or later", () => {
    canvas.dispatchEvent(finger("pointerdown"));
    canvas.dispatchEvent(finger("pointercancel"));
    mock.timers.tick(HOLD_MS);
    canvas.dispatchEvent(finger("pointerup"));
    assert.deepEqual(at.events, []);
    assert.equal(at.group.visible, false);
  });
});

/**
 * A camera following the mouse on `canvas` with `look: "orbit"`, told what
 * the pointer is on by a box straight ahead, the way `mouse(ctx)` tells it.
 *
 * @param {HTMLElement} canvas
 * @param {import("./mouse.js").PointerOptions} [options]
 */
function orbiting(canvas, options = { look: "orbit" }) {
  const camera = new THREE.PerspectiveCamera();
  const group = /** @type {THREE.Group<XREventMap>} */ (new THREE.Group());
  const manager = new InteractionManager();
  modelAhead(manager);
  const stop = followMouse(group, camera, canvas, window, {
    ...options,
    pointsAtNothing: () =>
      !manager.getIntersection(
        /** @type {THREE.XRTargetRaySpace} */ (/** @type {unknown} */ (group)),
      ),
  });
  return { camera, stop };
}

/** The angle one pixel of the 100 px canvas shows to a default camera. */
const PER_PIXEL = THREE.MathUtils.degToRad(50) / 100;

/** @param {THREE.Camera} camera */
function heading(camera) {
  return new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
}

describe("a drag on nothing, with look: orbit", () => {
  /** @type {HTMLElement} */
  let canvas;
  /** @type {(() => void) | undefined} */
  let stop;

  beforeEach(() => {
    canvas = pageCanvas();
    document.body.append(canvas);
  });

  afterEach(() => {
    stop?.();
    canvas.remove();
  });

  test("turns the camera by the angle the screen shows over the drag", () => {
    const at = orbiting(canvas);
    stop = at.stop;
    // The corner is off the box.
    canvas.dispatchEvent(pointer("pointerdown", 0, 0));
    canvas.dispatchEvent(pointer("pointermove", 20, 10));
    const { x: pitch, y: yaw } = heading(at.camera);
    assert.ok(Math.abs(yaw - 20 * PER_PIXEL) < 1e-6);
    assert.ok(Math.abs(pitch - 10 * PER_PIXEL) < 1e-6);
  });

  test("stops turning it when the button comes up", () => {
    const at = orbiting(canvas);
    stop = at.stop;
    canvas.dispatchEvent(pointer("pointerdown", 0, 0));
    canvas.dispatchEvent(pointer("pointermove", 20, 0));
    canvas.dispatchEvent(pointer("pointerup", 20, 0));
    canvas.dispatchEvent(pointer("pointermove", 60, 0));
    assert.ok(Math.abs(heading(at.camera).y - 20 * PER_PIXEL) < 1e-6);
  });

  test("clamps the pitch short of straight up", () => {
    const at = orbiting(canvas);
    stop = at.stop;
    canvas.dispatchEvent(pointer("pointerdown", 0, 0));
    for (let y = 0; y <= 1000; y += 100) {
      canvas.dispatchEvent(pointer("pointermove", 0, y));
    }
    assert.ok(Math.abs(heading(at.camera).x - PITCH_LIMIT) < 1e-6);
  });

  test("leaves the camera alone when the press is on something", () => {
    const at = orbiting(canvas);
    stop = at.stop;
    canvas.dispatchEvent(pointer("pointerdown"));
    canvas.dispatchEvent(pointer("pointermove", 90, 90));
    assert.equal(at.camera.quaternion.angleTo(new THREE.Quaternion()), 0);
  });

  test("leaves it alone without look", () => {
    const at = orbiting(canvas, {});
    stop = at.stop;
    canvas.dispatchEvent(pointer("pointerdown", 0, 0));
    canvas.dispatchEvent(pointer("pointermove", 20, 10));
    assert.equal(at.camera.quaternion.angleTo(new THREE.Quaternion()), 0);
  });

  test("swings the camera about around, keeping its distance", () => {
    // Standing 3 m back from the point, as a camera orbiting a table would.
    const at = orbiting(canvas, { look: "orbit", around: { x: 0, y: 0, z: -3 } });
    stop = at.stop;
    canvas.dispatchEvent(pointer("pointerdown", 0, 0));
    canvas.dispatchEvent(pointer("pointermove", 40, 0));
    const point = new THREE.Vector3(0, 0, -3);
    assert.ok(Math.abs(at.camera.position.distanceTo(point) - 3) < 1e-6);
    // And still faces it.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(at.camera.quaternion);
    const toPoint = point.clone().sub(at.camera.position).normalize();
    assert.ok(forward.distanceTo(toPoint) < 1e-6);
    // A drag right swings the camera to the left of the point, so what is
    // at the point moves right with the drag.
    assert.ok(at.camera.position.x < 0);
  });

  test("is a finger's too, once it has moved past the slop", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const at = orbiting(canvas);
      stop = at.stop;
      canvas.dispatchEvent(finger("pointerdown", 0, 0));
      canvas.dispatchEvent(finger("pointermove", 5, 0));
      assert.equal(at.camera.quaternion.angleTo(new THREE.Quaternion()), 0);
      canvas.dispatchEvent(finger("pointermove", 30, 0));
      // From where it landed, not from where it crossed the slop.
      assert.ok(Math.abs(heading(at.camera).y - 30 * PER_PIXEL) < 1e-6);
      canvas.dispatchEvent(finger("pointerup", 30, 0));
    } finally {
      mock.timers.reset();
    }
  });
});

describe("the wheel", () => {
  /** @type {HTMLElement} */
  let canvas;
  /** @type {THREE.Group<XREventMap>} */
  let group;
  /** @type {() => void} */
  let stop;

  beforeEach(() => {
    canvas = pageCanvas();
    group = /** @type {THREE.Group<XREventMap>} */ (new THREE.Group());
    stop = followMouse(group, new THREE.PerspectiveCamera(), canvas);
  });

  afterEach(() => {
    stop();
  });

  /**
   * @param {number} deltaY
   * @param {number} [deltaMode]
   */
  function wheel(deltaY, deltaMode = 0) {
    // What a `WheelEvent` carries, on an event the test's document takes.
    const event = Object.assign(new Event("wheel", { cancelable: true }), { deltaY, deltaMode });
    canvas.dispatchEvent(event);
    return event;
  }

  /** Something held 2 m out along the ray, a little off it, as `drag` leaves it. */
  function held() {
    const thing = new THREE.Object3D();
    thing.position.set(0.1, 0, -2);
    group.add(thing);
    return thing;
  }

  test("pushes what the group holds further along the ray when turned away", () => {
    const thing = held();
    const event = wheel(-100);
    assert.ok(Math.abs(thing.position.z - (-2 - 100 * WHEEL_METRES_PER_PIXEL)) < 1e-9);
    // Along the ray: the offset from it stays.
    assert.equal(thing.position.x, 0.1);
    // And the page does not scroll as well.
    assert.equal(event.defaultPrevented, true);
  });

  test("brings it nearer when turned towards the screen, never nearer than the floor", () => {
    const thing = held();
    wheel(100);
    assert.ok(Math.abs(thing.position.z - (-2 + 100 * WHEEL_METRES_PER_PIXEL)) < 1e-9);
    wheel(100_000);
    assert.equal(thing.position.z, -MIN_REACH);
  });

  test("counts a wheel that scrolls by lines in lines", () => {
    const thing = held();
    // DOM_DELTA_LINE.
    wheel(-1, 1);
    assert.ok(Math.abs(thing.position.z - (-2 - 16 * WHEEL_METRES_PER_PIXEL)) < 1e-9);
  });

  test("is the page's while the group holds nothing", () => {
    assert.equal(wheel(-100).defaultPrevented, false);
  });

  test("is the page's again once it stops", () => {
    const thing = held();
    stop();
    assert.equal(wheel(-100).defaultPrevented, false);
    assert.equal(thing.position.z, -2);
  });
});

test("around is refused without look: orbit", () => {
  // @ts-expect-error -- nothing orbits without look: "orbit".
  mouse({}, { around: { x: 0, y: 0, z: 0 } });
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
