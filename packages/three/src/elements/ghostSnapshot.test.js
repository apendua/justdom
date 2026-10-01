import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { cameraFor, NO_SNAPSHOTS, snapshotsFor, takeSnapshot } from "./ghostSnapshot.js";

/**
 * An element's object as a panel places one: in px, top-left origin, y
 * down, under a container turned half a turn about x and scaled to a
 * millimetre a px, and here also turned and moved, as a panel in a room is.
 */
function frame() {
  const room = new THREE.Group();
  room.position.set(0.3, 1.4, -0.6);
  room.rotation.set(0, 0.7, 0);
  const container = new THREE.Group();
  container.rotation.set(Math.PI, 0, 0);
  container.scale.setScalar(0.001);
  const element = new THREE.Object3D();
  element.position.set(40, 120, -4);
  room.add(container);
  container.add(element);
  room.updateMatrixWorld(true);
  return element;
}

/**
 * A renderer that records what is done to it, for a test with no WebGL.
 */
function recordingRenderer() {
  const previousTarget = new THREE.WebGLRenderTarget(1, 1);
  /** @type {unknown[][]} */
  const calls = [];
  let target = previousTarget;
  let clearColor = new THREE.Color(0x123456);
  let clearAlpha = 0.5;
  const renderer = {
    isWebGLRenderer: true,
    xr: { enabled: true },
    getRenderTarget: () => target,
    /** @param {THREE.WebGLRenderTarget} next */
    setRenderTarget: (next) => {
      target = next;
    },
    /** @param {THREE.Color} into */
    getClearColor: (into) => into.copy(clearColor),
    getClearAlpha: () => clearAlpha,
    /**
     * @param {THREE.ColorRepresentation} color
     * @param {number} alpha
     */
    setClearColor: (color, alpha) => {
      clearColor = new THREE.Color(color);
      clearAlpha = alpha;
    },
    clear: () => calls.push(["clear", target, clearAlpha]),
    /**
     * @param {THREE.Object3D} scene
     * @param {THREE.Camera} camera
     */
    render: (scene, camera) => calls.push(["render", scene, camera, target, renderer.xr.enabled]),
    /**
     * @param {THREE.Object3D} scene
     * @param {THREE.Camera} camera
     */
    compileAsync: (scene, camera) => {
      calls.push(["compile", scene, camera, target, renderer.xr.enabled]);
      return Promise.resolve(scene);
    },
  };
  return {
    renderer: /** @type {THREE.WebGLRenderer} */ (/** @type {unknown} */ (renderer)),
    calls,
    previousTarget,
    state: () => ({ target, clearColor: clearColor.getHex(), clearAlpha, xr: renderer.xr.enabled }),
  };
}

describe("cameraFor", () => {
  test("frames the box exactly, the way round the panel shows it", () => {
    // Three takes the scale out of a camera's view matrix, so a frustum in
    // the panel's px would be a thousand times too big here.
    const element = frame();
    const box = { x: -8, y: -10, width: 352, height: 40 };
    const camera = cameraFor(element, box);
    /**
     * @param {number} x
     * @param {number} y
     */
    const project = (x, y) =>
      element
        .localToWorld(new THREE.Vector3(x, y, 0))
        .project(camera)
        .toArray()
        .slice(0, 2)
        .map((n) => Math.round(n * 1000) / 1000);
    assert.deepEqual(project(box.x, box.y), [-1, 1], "the top left corner, top left");
    assert.deepEqual(project(box.x + box.width, box.y + box.height), [1, -1]);
  });
});

describe("takeSnapshot", () => {
  test("renders the panel once into a target, and puts the renderer back", () => {
    const { renderer, calls, previousTarget, state } = recordingRenderer();
    const panel = new THREE.Group();
    const target = takeSnapshot(renderer, panel, frame(), { x: 0, y: 0, width: 100, height: 40 });
    assert.ok(target);
    assert.equal(target.width, 200, "two texels a px");
    const render = calls.find(([name]) => name === "render");
    assert.ok(render);
    assert.equal(render[1], panel, "the panel on its own");
    assert.equal(render[3], target, "into the target");
    assert.equal(render[4], false, "with the headset's eyes off");
    assert.deepEqual(calls.find(([name]) => name === "clear")?.[2], 0, "on a transparent clear");
    assert.deepEqual(state(), {
      target: previousTarget,
      clearColor: 0x123456,
      clearAlpha: 0.5,
      xr: true,
    });
  });

  test("puts the renderer back when the render throws", () => {
    const { renderer, previousTarget, state } = recordingRenderer();
    renderer.render = () => {
      throw new Error("lost context");
    };
    assert.throws(() =>
      takeSnapshot(renderer, new THREE.Group(), frame(), { x: 0, y: 0, width: 10, height: 10 }),
    );
    assert.deepEqual(state(), {
      target: previousTarget,
      clearColor: 0x123456,
      clearAlpha: 0.5,
      xr: true,
    });
  });

  test("takes nothing of an empty box", () => {
    const { renderer, calls } = recordingRenderer();
    assert.equal(
      takeSnapshot(renderer, new THREE.Group(), frame(), { x: 0, y: 0, width: 0, height: 10 }),
      null,
    );
    assert.equal(calls.length, 0);
  });

  test("keeps a long box within the largest picture", () => {
    const { renderer } = recordingRenderer();
    const target = takeSnapshot(renderer, new THREE.Group(), frame(), {
      x: 0,
      y: 0,
      width: 2048,
      height: 64,
    });
    assert.equal(target?.width, 1024);
    assert.equal(target?.height, 32);
  });
});

describe("snapshotsFor", () => {
  test("takes no pictures without a WebGL renderer", () => {
    assert.equal(snapshotsFor(null), NO_SNAPSHOTS);
    // What a test stands in for a renderer, and a renderer of another kind.
    assert.equal(snapshotsFor({}), NO_SNAPSHOTS);
  });

  test("compiles a panel's programs as a snapshot would draw them", () => {
    const { renderer, calls, previousTarget, state } = recordingRenderer();
    const snapshots = snapshotsFor(renderer);
    const panel = new THREE.Group();
    snapshots.prepare(panel);
    const compiles = calls.filter(([name]) => name === "compile");
    assert.equal(compiles.length, 1);
    assert.equal(compiles[0][1], panel);
    assert.ok(compiles[0][3] instanceof THREE.WebGLRenderTarget, "into a target, as a snapshot");
    assert.notEqual(compiles[0][3], previousTarget);
    assert.equal(compiles[0][4], false, "with the headset's eyes off");
    assert.deepEqual(state(), {
      target: previousTarget,
      clearColor: 0x123456,
      clearAlpha: 0.5,
      xr: true,
    });
    // At every press, for what the panel has come to draw since its last.
    snapshots.prepare(panel);
    assert.equal(calls.filter(([name]) => name === "compile").length, 2);
  });

  test("takes pictures with the renderer it was given", () => {
    const { renderer, calls } = recordingRenderer();
    const panel = new THREE.Group();
    const target = snapshotsFor(renderer).take(panel, frame(), {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    assert.ok(target);
    assert.equal(calls.find(([name]) => name === "render")?.[1], panel);
  });
});
