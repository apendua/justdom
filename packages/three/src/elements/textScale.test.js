import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createTextScale } from "./textScale.js";
import { placeAndScale } from "./place.js";

/**
 * A camera whose projection is a round number: `2 / (t - b)` comes out at
 * exactly 2, so a viewport 1000 device pixels tall paints 1000 of them across
 * a world unit held one unit away. Every expectation below is that times the
 * panel's scale over its distance, worked out by hand.
 */
const FOV = (2 * Math.atan(0.5) * 180) / Math.PI;
const VIEWPORT_HEIGHT = 1000;
const PIXELS_PER_UNIT = 1000;

/**
 * Stands in for the renderer, which is asked two things: whether a headset is
 * presenting, and how big the buffer being drawn into is.
 */
function renderer() {
  return /** @type {THREE.WebGLRenderer} */ (
    /** @type {unknown} */ ({
      xr: { isPresenting: false },
      /** @param {THREE.Vector2} target */
      getDrawingBufferSize: (target) => target.set(VIEWPORT_HEIGHT, VIEWPORT_HEIGHT),
    })
  );
}

/**
 * A panel of `size` container pixels, `metresPerPixel` metres to each of
 * them, sitting `distance` metres straight ahead of a camera at the origin.
 *
 * @param {{ metresPerPixel: number, distance: number, size?: [number, number] }} options
 */
function panel({ metresPerPixel, distance, size = [0, 0] }) {
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const container = new THREE.Group();
  const scale = createTextScale(container, renderer(), camera);
  scale.setPanelSize(size[0], size[1]);
  /** @param {number} to */
  const moveTo = (to) => {
    placeAndScale(container, 0, 0, -to, metresPerPixel, metresPerPixel, metresPerPixel);
  };
  moveTo(distance);
  return { scale, moveTo };
}

describe("createTextScale", () => {
  test("the sanity of the fixture: a unit a unit away is a thousand pixels", () => {
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    camera.updateProjectionMatrix();
    assert.ok(Math.abs(camera.projectionMatrix.elements[5] - 2) < 1e-9);
    assert.equal(0.5 * VIEWPORT_HEIGHT * 2, PIXELS_PER_UNIT);
  });

  test("a panel drawing a pixel per pixel is rasterized one for one", () => {
    // 0.001 * 1000 / 1 === 1.
    const p = panel({ metresPerPixel: 0.001, distance: 1 });
    p.scale.measure();
    assert.equal(p.scale.read(), 1);
  });

  test("a panel drawing two device pixels per pixel asks for two", () => {
    // 0.001 * 1000 / 0.5 === 2, which is the step exactly.
    const p = panel({ metresPerPixel: 0.001, distance: 0.5 });
    p.scale.measure();
    assert.equal(p.scale.read(), 2);
  });

  test("a step is the power of two above the measurement, not the one below", () => {
    // 0.001 * 1000 / 0.4 === 2.5, which two would leave short.
    const p = panel({ metresPerPixel: 0.001, distance: 0.4 });
    p.scale.measure();
    assert.equal(p.scale.read(), 4);
  });

  test("a panel in the player's face stops at what a run is allowed to cost", () => {
    // 0.001 * 1000 / 0.05 === 20, which nothing is rasterized at.
    const p = panel({ metresPerPixel: 0.001, distance: 0.05 });
    p.scale.measure();
    assert.equal(p.scale.read(), 4);
  });

  test("sharpens the moment the player leans in", () => {
    const p = panel({ metresPerPixel: 0.001, distance: 1 });
    p.scale.measure();
    assert.equal(p.scale.read(), 1);
    p.moveTo(0.5);
    p.scale.measure();
    assert.equal(p.scale.read(), 2);
  });

  test("holds its step across the boundary, and lets go well past it", () => {
    const p = panel({ metresPerPixel: 0.001, distance: 0.5 });
    p.scale.measure();
    assert.equal(p.scale.read(), 2);

    // 0.909 of a device pixel each: under the step, but not under it far
    // enough to be worth re-drawing every label on the panel for.
    p.moveTo(1.1);
    p.scale.measure();
    assert.equal(p.scale.read(), 2);

    // 0.769, which is clear of the hold.
    p.moveTo(1.3);
    p.scale.measure();
    assert.equal(p.scale.read(), 1);
  });

  test("measures to the middle of the panel rather than to its corner", () => {
    // The container's own origin is half a metre away, which on its own is
    // two device pixels to the pixel. The middle of a panel 1800 pixels wide
    // is 0.9m off to the side of it, and a metre away.
    const middling = panel({ metresPerPixel: 0.001, distance: 0.5, size: [1800, 0] });
    middling.scale.measure();
    assert.equal(middling.scale.read(), 1);

    const cornered = panel({ metresPerPixel: 0.001, distance: 0.5 });
    cornered.scale.measure();
    assert.equal(cornered.scale.read(), 2);
  });

  test("says nothing at all about a panel it cannot see the projection of", () => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    camera.updateMatrixWorld();
    const container = new THREE.Group();
    const scale = createTextScale(container, renderer(), camera);
    scale.setPanelSize(0, 0);
    placeAndScale(container, 0, 0, -0.05, 0.001, 0.001, 0.001);
    scale.measure();
    assert.equal(scale.read(), 1);
  });
});
