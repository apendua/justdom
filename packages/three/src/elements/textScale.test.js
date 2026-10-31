import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ABANDON_MS, createTextScale, PREPARE_SHARE, stepAbove, stepBelow } from "./textScale.js";
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
 * @param {{
 *   metresPerPixel: number,
 *   distance: number,
 *   size?: [number, number],
 *   maxScale?: number,
 *   now?: () => number,
 * }} options
 */
function panel({ metresPerPixel, distance, size = [0, 0], maxScale, now }) {
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const container = new THREE.Group();
  const scale = createTextScale(container, renderer(), camera, maxScale, { now });
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

  test("a step is the root two above the measurement, not the one below", () => {
    // 0.001 * 1000 / 0.4 === 2.5, which 2 would leave short and 4 would
    // overshoot by three quarters of the memory it costs.
    const p = panel({ metresPerPixel: 0.001, distance: 0.4 });
    p.scale.measure();
    assert.equal(p.scale.read(), 2 ** 1.5);
  });

  test("a panel can ask to stay soft rather than get large", () => {
    const p = panel({ metresPerPixel: 0.001, distance: 0.4, maxScale: 2 });
    p.scale.measure();
    assert.equal(p.scale.read(), 2);
  });

  test("and cannot ask for more than a run is allowed to cost", () => {
    // 0.001 * 1000 / 0.05 === 20, asked for at 8, given the ceiling.
    const p = panel({ metresPerPixel: 0.001, distance: 0.05, maxScale: 8 });
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

    // 1.25 device pixels each. The boundary this step sits on is root two,
    // so this is under the step — but not under it far enough to be worth
    // re-drawing every label on the panel for.
    p.moveTo(0.8);
    p.scale.measure();
    assert.equal(p.scale.read(), 2);

    // 1.0, which is clear of the hold at (2 / root two) * 0.8 === 1.131.
    p.moveTo(1);
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

describe("held steps", () => {
  test("a panel holds the step it shows and the one below it, and no other", () => {
    // 2.1 device pixels to the pixel: shown at 2.83, and under the share of
    // it that starts preparing 4.
    const p = panel({ metresPerPixel: 0.001, distance: 1 / 2.1 });
    p.scale.measure();
    const shown = p.scale.read();
    assert.equal(shown, 2 ** 1.5);
    assert.equal(p.scale.holds(shown), true);
    assert.equal(p.scale.holds(2), true);
    assert.equal(p.scale.holds(Math.SQRT2), false);
    assert.equal(p.scale.holds(4), false);
  });

  test("what it holds moves with the step it shows", () => {
    const p = panel({ metresPerPixel: 0.001, distance: 0.4 });
    p.scale.measure();
    p.moveTo(1);
    p.scale.measure();
    assert.equal(p.scale.read(), 1);
    assert.equal(p.scale.holds(1), true);
    assert.equal(p.scale.holds(2 ** 1.5), false, "the step it left is above it");
    assert.equal(p.scale.holds(2), false);
  });

  test("the step below is the very number the ladder hands out for it", () => {
    // Compared with `===` by the runs that keep rasters under it, so the
    // ones between the octaves have to come out exactly as `read` gives them.
    for (const distance of [1, 0.7, 0.5, 0.4, 0.3]) {
      const p = panel({ metresPerPixel: 0.001, distance });
      p.scale.measure();
      const step = p.scale.read();
      const below = stepBelow(step);
      if (below === null) {
        assert.equal(step, 1);
        continue;
      }
      // Measured a hair under the step below, which rounds up to it.
      const lower = panel({ metresPerPixel: 0.001, distance: 1.001 / below });
      lower.scale.measure();
      assert.equal(lower.scale.read(), below);
    }
  });

  test("a step a panel's cap put off the ladder has the ladder step under it below it", () => {
    assert.equal(stepBelow(3), 2 ** 1.5);
    assert.equal(stepBelow(1), null);
  });
});

/**
 * The distance at which the fixture's panel measures `measured` device
 * pixels to the pixel.
 *
 * @param {number} measured
 */
const at = (measured) => 1 / measured;

describe("prepared steps", () => {
  test("a panel prepares the step above once the measurement nears the step it shows", () => {
    const p = panel({ metresPerPixel: 0.001, distance: at(0.8) });
    p.scale.measure();
    assert.equal(p.scale.read(), 1);
    assert.equal(p.scale.prepared(), null, "0.8 is under 0.85 of 1");

    p.moveTo(at(0.9));
    p.scale.measure();
    assert.equal(p.scale.read(), 1);
    assert.equal(p.scale.prepared(), Math.SQRT2);
    assert.equal(p.scale.holds(Math.SQRT2), true, "what is being prepared is held");
  });

  test("crossing into the prepared step clears it, and the next is weighed afresh", () => {
    const p = panel({ metresPerPixel: 0.001, distance: at(0.9) });
    p.scale.measure();
    assert.equal(p.scale.prepared(), Math.SQRT2);

    // 1.1 publishes 1.41, and is under 0.85 of it (1.2).
    p.moveTo(at(1.1));
    p.scale.measure();
    assert.equal(p.scale.read(), Math.SQRT2);
    assert.equal(p.scale.prepared(), null);

    // 1.3 publishes nothing new, and is over 0.85 of 1.41.
    p.moveTo(at(1.3));
    p.scale.measure();
    assert.equal(p.scale.read(), Math.SQRT2);
    assert.equal(p.scale.prepared(), 2);
  });

  test("a measurement that falls back is given a second before the step is let go", () => {
    let time = 0;
    const p = panel({ metresPerPixel: 0.001, distance: at(0.9), now: () => time });
    p.scale.measure();
    assert.equal(p.scale.prepared(), Math.SQRT2);

    p.moveTo(at(0.7));
    p.scale.measure();
    time = ABANDON_MS - 1;
    p.scale.measure();
    assert.equal(p.scale.prepared(), Math.SQRT2, "not yet");
    time = ABANDON_MS;
    p.scale.measure();
    assert.equal(p.scale.prepared(), null);
    assert.equal(p.scale.holds(Math.SQRT2), false);
  });

  test("coming back over the share before the second is up starts the count again", () => {
    let time = 0;
    const p = panel({ metresPerPixel: 0.001, distance: at(0.9), now: () => time });
    p.scale.measure();
    p.moveTo(at(0.7));
    p.scale.measure();
    time = ABANDON_MS / 2;
    p.moveTo(at(0.9));
    p.scale.measure();
    p.moveTo(at(0.7));
    p.scale.measure();
    time = ABANDON_MS;
    p.scale.measure();
    assert.equal(p.scale.prepared(), Math.SQRT2, "half a second under, since it came back");
    time = ABANDON_MS * 1.5;
    p.scale.measure();
    assert.equal(p.scale.prepared(), null);
  });

  test("a panel at its cap prepares nothing", () => {
    const p = panel({ metresPerPixel: 0.001, distance: at(1.9), maxScale: 2 });
    p.scale.measure();
    assert.equal(p.scale.read(), 2);
    assert.ok(1.9 >= PREPARE_SHARE * 2);
    assert.equal(p.scale.prepared(), null);
  });

  test("the step above is the very number the ladder publishes for it", () => {
    assert.equal(stepAbove(1, 4), Math.SQRT2);
    assert.equal(stepAbove(2, 4), 2 ** 1.5);
    assert.equal(stepAbove(2 ** 1.5, 4), 4);
    assert.equal(stepAbove(2 ** 1.5, 3), 3, "capped");
    assert.equal(stepAbove(3, 3), null);
    assert.equal(stepAbove(4, 4), null);
    // And what a panel publishes when it crosses: 2.1 past 2.
    const p = panel({ metresPerPixel: 0.001, distance: at(2.1) });
    p.scale.measure();
    assert.equal(p.scale.read(), stepAbove(2, 4));
  });
});
