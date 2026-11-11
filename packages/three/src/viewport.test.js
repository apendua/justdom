import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { containerSize, followSize, putCanvasIn, windowSize } from "./viewport.js";
import { renderCamera, rendererParameters } from "./render.js";

/**
 * A renderer that records what it is told, with an XR manager whose
 * `isPresenting` a test sets and whose `sessionstart` and `sessionend` a
 * test fires, as three fires them: after the flag is up, and after it is
 * down.
 */
function fakeRenderer() {
  const xr = /** @type {any} */ (
    Object.assign(new THREE.EventDispatcher(), { isPresenting: false })
  );
  /** @type {[number, number][]} */
  const sizes = [];
  /** @type {number[]} */
  const ratios = [];
  const renderer = {
    xr,
    /** @param {number} r */
    setPixelRatio: (r) => void ratios.push(r),
    /** @param {number} w @param {number} h */
    setSize: (w, h) => void sizes.push([w, h]),
  };
  return {
    renderer,
    sizes,
    ratios,
    /** @param {boolean} on */
    present(on) {
      xr.isPresenting = on;
      xr.dispatchEvent({ type: on ? "sessionstart" : "sessionend" });
    },
  };
}

/**
 * A stand-in for `ResizeObserver`, which jsdom does not have: `resize()`
 * calls every observer watching the element.
 */
function fakeObserver() {
  /** @type {Set<{ callback: () => void; targets: Set<Element> }>} */
  const live = new Set();
  class Observer {
    /** @param {() => void} callback */
    constructor(callback) {
      this.entry = { callback, targets: new Set() };
      live.add(this.entry);
    }
    /** @param {Element} el */
    observe(el) {
      this.entry.targets.add(el);
    }
    disconnect() {
      live.delete(this.entry);
    }
  }
  return {
    Observer: /** @type {typeof ResizeObserver} */ (/** @type {unknown} */ (Observer)),
    /** @param {Element} el */
    resize(el) {
      for (const entry of live) {
        if (entry.targets.has(el)) {
          entry.callback();
        }
      }
    },
    get count() {
      return live.size;
    },
  };
}

/**
 * @param {HTMLElement} el
 * @param {number} width
 * @param {number} height
 */
function layOut(el, width, height) {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
}

describe("followSize", () => {
  test("a container's size and aspect reach the renderer, then and after a resize", () => {
    const { renderer, sizes } = fakeRenderer();
    const camera = new THREE.PerspectiveCamera();
    const el = document.createElement("div");
    layOut(el, 400, 300);
    const resizes = fakeObserver();
    /** @type {{ width: number; height: number }[]} */
    const reported = [];

    const stop = followSize(renderer, camera, containerSize(el, resizes.Observer), {
      onSize: (s) => reported.push({ width: s.width, height: s.height }),
    });
    assert.deepEqual(sizes, [[400, 300]]);
    assert.equal(camera.aspect, 400 / 300);

    layOut(el, 200, 200);
    resizes.resize(el);
    assert.deepEqual(sizes.at(-1), [200, 200]);
    assert.equal(camera.aspect, 1);
    assert.deepEqual(reported, [
      { width: 400, height: 300 },
      { width: 200, height: 200 },
    ]);

    stop();
    assert.equal(resizes.count, 0);
  });

  test("a container's padding is not drawn on", () => {
    const el = document.createElement("div");
    el.style.padding = "10px 20px";
    layOut(el, 440, 320);
    const size = containerSize(el, fakeObserver().Observer).read();
    assert.equal(size.width, 400);
    assert.equal(size.height, 300);
  });

  test("nothing is applied during a session, and the size is read again when it ends", () => {
    // three refuses a setSize while presenting and puts back the size from
    // the session's start when it ends; a resize in between was lost.
    const { renderer, sizes, present } = fakeRenderer();
    const camera = new THREE.PerspectiveCamera();
    const el = document.createElement("div");
    layOut(el, 400, 300);
    const resizes = fakeObserver();
    followSize(renderer, camera, containerSize(el, resizes.Observer), { onSize: () => {} });

    present(true);
    layOut(el, 600, 300);
    resizes.resize(el);
    assert.deepEqual(sizes, [[400, 300]]);

    present(false);
    assert.deepEqual(sizes.at(-1), [600, 300]);
    assert.equal(camera.aspect, 2);
  });

  test("a session's projection is taken off the camera when it ends", () => {
    // three writes the headset's projection onto the flat camera, `fov` and
    // `zoom` included, and leaves it there.
    const { renderer, present } = fakeRenderer();
    const camera = new THREE.PerspectiveCamera(50);
    followSize(renderer, camera, windowSize(), { onSize: () => {} });
    // A zoom pinched before the session is the one it comes back to.
    camera.zoom = 1.5;
    present(true);
    camera.fov = 100;
    camera.zoom = 2;
    present(false);
    assert.equal(camera.fov, 50);
    assert.equal(camera.zoom, 1.5);
    assert.equal(camera.projectionMatrix.elements[5], (1.5 * 1) / Math.tan((25 * Math.PI) / 180));
  });

  test("a resize keeps the zoom and field of view the page set", () => {
    const { renderer } = fakeRenderer();
    const camera = new THREE.PerspectiveCamera(50);
    followSize(renderer, camera, windowSize(), { onSize: () => {} });
    camera.zoom = 2;
    camera.fov = 60;
    window.dispatchEvent(new Event("resize"));
    assert.equal(camera.zoom, 2);
    assert.equal(camera.fov, 60);
  });

  test("a resize is drawn in the same turn, and the first size is not", () => {
    // A container's observer reports after the frame's draw and before its
    // paint, and setting the size clears the canvas.
    const { renderer, sizes, present } = fakeRenderer();
    const el = document.createElement("div");
    layOut(el, 400, 300);
    const resizes = fakeObserver();
    /** @type {number[]} */
    const drawnAt = [];
    followSize(renderer, new THREE.PerspectiveCamera(), containerSize(el, resizes.Observer), {
      onSize: () => {},
      draw: () => drawnAt.push(sizes.length),
    });
    assert.deepEqual(drawnAt, [], "no scene yet");
    layOut(el, 200, 200);
    resizes.resize(el);
    assert.deepEqual(drawnAt, [2], "after the new size");
    present(true);
    resizes.resize(el);
    assert.deepEqual(drawnAt, [2], "nothing while presenting");
    present(false);
    assert.deepEqual(drawnAt, [2, 3], "and the size put back at the end");
  });

  test("the pixel ratio is read again on every resize", () => {
    const { renderer, ratios } = fakeRenderer();
    const before = window.devicePixelRatio;
    try {
      followSize(renderer, new THREE.PerspectiveCamera(), windowSize(), { onSize: () => {} });
      Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
      window.dispatchEvent(new Event("resize"));
      assert.deepEqual(ratios, [before, 2]);
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { value: before, configurable: true });
    }
  });

  test("without a container it is the window, as it always was", () => {
    const { renderer, sizes, ratios } = fakeRenderer();
    const camera = new THREE.PerspectiveCamera();
    const stop = followSize(renderer, camera, windowSize(), { onSize: () => {} });
    assert.deepEqual(sizes, [[window.innerWidth, window.innerHeight]]);
    assert.deepEqual(ratios, [window.devicePixelRatio]);
    assert.equal(camera.aspect, window.innerWidth / window.innerHeight);
    stop();
    window.dispatchEvent(new Event("resize"));
    assert.equal(sizes.length, 1);
  });
});

describe("putCanvasIn", () => {
  test("puts the canvas in as a block and takes it out again", () => {
    const el = document.createElement("div");
    const canvas = document.createElement("canvas");
    const remove = putCanvasIn(el, canvas);
    assert.equal(canvas.parentElement, el);
    assert.equal(canvas.style.display, "block");
    remove();
    assert.equal(canvas.parentElement, null);
  });
});

describe("render()'s camera and renderer options", () => {
  test("the camera takes the field of view and planes it is given", () => {
    const camera = renderCamera({ fov: 50, far: 100 });
    assert.equal(camera.fov, 50);
    assert.equal(camera.near, 0.1);
    assert.equal(camera.far, 100);
  });

  test("without options the camera and renderer are what they were", () => {
    const camera = renderCamera();
    assert.deepEqual([camera.fov, camera.near, camera.far], [70, 0.1, 20]);
    assert.deepEqual(rendererParameters({}), {
      antialias: true,
      powerPreference: "high-performance",
    });
  });

  test("the renderer's parameters reach it over render()'s defaults", () => {
    assert.deepEqual(
      rendererParameters({ renderer: { alpha: true, powerPreference: "low-power" } }),
      { alpha: true, antialias: true, powerPreference: "low-power" },
    );
    assert.equal(rendererParameters({ antialias: false }).antialias, false);
  });

  test("antialias is said by its own option, and the parameters refuse it", () => {
    // @ts-expect-error -- one setting, said in one place.
    rendererParameters({ renderer: { antialias: false } });
    // @ts-expect-error -- render() makes the canvas.
    rendererParameters({ renderer: { canvas: document.createElement("canvas") } });
  });
});
