import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { frameLoop } from "./render.js";
import { stubGlRenderer } from "./test/stubGl.js";

/**
 * Three's own renderer over a stub context, a scene with a mesh in it, and
 * `render`'s frame loop drawing it. Every frame gives the mesh a material of
 * its own, so every frame links a program, as a frame does that shows
 * something for the first time.
 */
function stage() {
  const { renderer, counts, loseContext, restoreContext } = stubGlRenderer();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry());
  scene.add(mesh);
  let frames = 0;
  let stopped = false;
  const setAnimationLoop = renderer.setAnimationLoop.bind(renderer);
  renderer.setAnimationLoop = (callback) => {
    stopped ||= callback === null;
    setAnimationLoop(callback);
  };
  /** What a frame does before it draws, if anything. */
  let before = () => {};
  const loop = frameLoop(renderer, () => {
    frames += 1;
    before();
    // A different colour is a different material, not a different program:
    // the colour is a uniform. A different side is a different program.
    mesh.material = new THREE.MeshBasicMaterial({
      side: frames % 2 ? THREE.FrontSide : THREE.BackSide,
    });
    renderer.render(scene, camera);
  });
  const xrFrame = /** @type {XRFrame} */ (/** @type {unknown} */ (null));
  return {
    counts,
    loseContext,
    restoreContext,
    frame: () => loop(0, xrFrame),
    /** @param {() => void} fn */
    beforeDraw: (fn) => {
      before = fn;
    },
    get frames() {
      return frames;
    },
    get stopped() {
      return stopped;
    },
  };
}

describe("frameLoop", () => {
  test("runs no frame between the context going and three hearing of it", () => {
    const s = stage();
    s.frame();
    assert.equal(s.counts.draws, 1);
    s.loseContext();
    // Without the check this frame links a program, `shaderSource` throws on
    // the null shader, and the loop is taken down for good.
    s.frame();
    s.frame();
    assert.equal(s.frames, 1);
    assert.equal(s.counts.draws, 1);
    assert.equal(s.stopped, false);
  });

  test("draws again once the context is back", () => {
    const s = stage();
    s.frame();
    s.loseContext();
    s.frame();
    s.restoreContext();
    s.frame();
    assert.equal(s.frames, 2);
    assert.equal(s.counts.draws, 2);
    assert.equal(s.stopped, false);
  });

  test("lets go of a frame the context went in the middle of", () => {
    const s = stage();
    s.frame();
    s.beforeDraw(s.loseContext);
    s.frame();
    assert.equal(s.frames, 2);
    assert.equal(s.counts.draws, 1);
    assert.equal(s.stopped, false);
    s.beforeDraw(() => {});
    s.restoreContext();
    s.frame();
    assert.equal(s.counts.draws, 2);
  });

  test("still takes the loop down on a throw with the context there", () => {
    const s = stage();
    const fault = new Error("the app's own");
    s.beforeDraw(() => {
      throw fault;
    });
    assert.throws(() => s.frame(), fault);
    assert.equal(s.stopped, true);
  });
});
