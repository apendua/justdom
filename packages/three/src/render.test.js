import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BehaviorSubject } from "rxjs";
import * as THREE from "three";
import { Effect } from "@apendua/signal";
import {
  CameraContext,
  frames,
  getCamera,
  getScene,
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
  test("hands back the scene being drawn", () => {
    const scene = new THREE.Scene();
    const ctx = SceneContext.set({}, new BehaviorSubject(scene));
    assert.strictEqual(getScene(ctx), scene);
  });

  test("re-runs a reader when the tree emits a different scene", () => {
    // The reason this one is a dependency and `getCamera` is not: `render`
    // holds whatever scene its tree emits, and a tree rooted in a `component`
    // may emit another.
    const first = new THREE.Scene();
    const second = new THREE.Scene();
    const held = new BehaviorSubject(first);
    const ctx = SceneContext.set({}, held);

    /** @type {THREE.Scene[]} */
    const seen = [];
    const effect = new Effect(() => {
      seen.push(getScene(ctx));
    });
    assert.deepStrictEqual(seen, [first]);

    held.next(second);
    assert.deepStrictEqual(seen, [first, second], "the reader is told, and reads the new one");

    effect.dispose();
    held.next(first);
    assert.strictEqual(seen.length, 2, "and stops being told once it is gone");
  });

  test("says so when there is no scene", () => {
    assert.throws(() => getScene({}), /SceneContext not set/);
  });
});
