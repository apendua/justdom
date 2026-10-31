import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Effect } from "justdom-signal";
import {
  CameraContext,
  createControllerHandle,
  frames,
  getCamera,
  getScene,
  onLateFrame,
  RendererContext,
  SceneContext,
} from "./render.js";

describe("frames", () => {
  test("a renderer has frames before the loop that emits them is installed", () => {
    // The order is not one a caller can see, and it does not favour them: a
    // scene is *built* before the loop is installed, because the tree has to
    // exist for there to be anything to draw. So everything the scene
    // constructs asks for frames strictly before the loop that will emit
    // them exists.
    //
    // This used to throw, and the throw was caught: a portal asking too early
    // was told there were no frames here and quietly fell back to the
    // browser's own. That works everywhere a page is being rendered — a
    // desktop browser, an emulator — and nowhere that matters, because inside
    // an immersive session the page is not rendered, `requestAnimationFrame`
    // never fires, and a mirror waiting on one stops updating at all. The
    // whole failure lived in the gap between those two, which is exactly the
    // gap no browser-based test can see.
    const renderer = /** @type {any} */ ({});
    const ctx = RendererContext.set({}, renderer);

    assert.doesNotThrow(() => frames(ctx));
    // And it is the same frames every time, so a subscriber from before the
    // loop was installed is on the stream the loop will feed.
    const first = frames(ctx);
    const second = frames(ctx);
    assert.ok(first);
    assert.ok(second);
  });

  test("without a renderer there are no frames, which callers rely on", () => {
    // The fallback to the browser's own frames is chosen by this throwing,
    // and that is right where there is genuinely no renderer — a test runner,
    // a portal mounted on a plain page.
    assert.throws(() => frames({}), /RendererContext not set/);
  });
});

describe("onLateFrame", () => {
  test("hands back the way off again, rather than something to subscribe to", () => {
    // The late phase used to be an observable, and both of its callers did the
    // same thing with it: subscribed on the line that built it and kept the
    // subscription only to unsubscribe later. Nothing was ever emitted through
    // it, so the teardown is the whole of what it had to say — and neither
    // caller has a surrounding computation to hand the lifetime to, which is
    // what keeps this from being a `useLateFrame`.
    const renderer = /** @type {any} */ ({});
    const ctx = RendererContext.set({}, renderer);

    const stop = onLateFrame(ctx, () => {});
    assert.equal(typeof stop, "function");
    // Called more than once, because a failure takes the callback off the loop
    // by itself and the caller's own teardown still runs afterwards.
    assert.doesNotThrow(() => {
      stop();
      stop();
    });
  });

  test("without a renderer there is no late phase, which the portal relies on", () => {
    // A portal on a plain page or under a test runner catches this and settles
    // its batches from the microtask alone. Nothing invalidates a batch from
    // inside a frame where there are no frames, so that is the whole mechanism
    // there — but only because this says so rather than quietly doing nothing.
    assert.throws(() => onLateFrame({}, () => {}), /RendererContext not set/);
  });
});

describe("getCamera", () => {
  test("hands back the camera this context renders through", () => {
    const camera = new THREE.PerspectiveCamera();
    assert.strictEqual(getCamera(CameraContext.set({}, camera)), camera);
  });

  test("says so when there is no camera, rather than handing back nothing", () => {
    assert.throws(() => getCamera({}), /CameraContext not set/);
  });
});

describe("getScene", () => {
  test("hands back the scene the renderer is drawing", () => {
    const scene = new THREE.Scene();
    assert.strictEqual(getScene(SceneContext.set({}, scene)), scene);
  });

  test("is the same scene every time, since `render` owns it", () => {
    // It did not use to be: the tree handed a scene back, so the answer was
    // whatever it had most recently emitted. `render` builds one now, before
    // anything can ask, and keeps it — which is what lets this be a plain read
    // rather than a dependency.
    const ctx = SceneContext.set({}, new THREE.Scene());
    assert.strictEqual(getScene(ctx), getScene(ctx));
  });

  test("says so when there is no scene", () => {
    assert.throws(() => getScene({}), /SceneContext not set/);
  });
});

describe("createControllerHandle", () => {
  /**
   * The three spaces of one controller slot, as `WebXRController` drives
   * them: plain `Object3D`s that the connection and pinch events are
   * dispatched on.
   */
  function slot() {
    const controller = /** @type {THREE.XRTargetRaySpace} */ (new THREE.Group());
    const grip = /** @type {THREE.XRGripSpace} */ (new THREE.Group());
    const hand = /** @type {THREE.XRHandSpace} */ (new THREE.Group());
    const ray = new THREE.Object3D();
    return {
      controller,
      grip,
      hand,
      ray,
      handle: createControllerHandle(0, controller, grip, hand, ray),
    };
  }

  /**
   * @param {THREE.Object3D} space
   * @param {unknown} data
   */
  function connect(space, data) {
    space.dispatchEvent(/** @type {any} */ ({ type: "connected", data }));
  }

  test("hands out the ray line it was given, for an app to hide", () => {
    const { ray, handle } = slot();
    assert.equal(handle.ray, ray);
  });

  test("tells a tracked hand from a controller the way three does: by the source's hand", () => {
    const { controller, handle } = slot();
    assert.equal(handle.tracked(), null);

    connect(controller, { handedness: "right", hand: null });
    assert.equal(handle.tracked(), "controller");

    // Controllers put down; the runtime reconnects the slot as a hand.
    controller.dispatchEvent(/** @type {any} */ ({ type: "disconnected" }));
    assert.equal(handle.tracked(), null);
    connect(controller, { handedness: "right", hand: {} });
    assert.equal(handle.tracked(), "hand");
    assert.equal(handle.inputSource.get()?.handedness, "right");
  });

  test("tracked is derived: reconnecting the same kind of source does not re-run a watcher", () => {
    const { controller, handle } = slot();
    /** @type {(string | null)[]} */
    const seen = [];
    const watcher = new Effect(() => {
      seen.push(handle.tracked());
    });
    connect(controller, { hand: null });
    // A new source object of the same kind — what a reconnect looks like —
    // is a change to `inputSource` and not to `tracked`.
    connect(controller, { hand: null, gamepad: {} });
    connect(controller, { hand: {} });
    assert.deepEqual(seen, [null, "controller", "hand"]);
    watcher.dispose();
  });

  test("pinching follows the hand space's pinch events, and ends with the hand", () => {
    const { controller, hand, handle } = slot();
    connect(controller, { hand: {} });
    assert.equal(handle.pinching(), false);

    hand.dispatchEvent(/** @type {any} */ ({ type: "pinchstart" }));
    assert.equal(handle.pinching(), true);
    hand.dispatchEvent(/** @type {any} */ ({ type: "pinchend" }));
    assert.equal(handle.pinching(), false);

    // Controllers picked up mid-pinch: three never sends the `pinchend`.
    hand.dispatchEvent(/** @type {any} */ ({ type: "pinchstart" }));
    controller.dispatchEvent(/** @type {any} */ ({ type: "disconnected" }));
    assert.equal(handle.pinching(), false);
  });
});
