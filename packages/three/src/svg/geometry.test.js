import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { UNBOUNDED } from "../elements/clip.js";

/**
 * @import { Matrix2D, Rect } from "./geometry.js";
 */
import {
  aboutOrigin,
  apply,
  IDENTITY,
  matrixScale,
  multiply,
  parseCssMatrix,
  parsePreserveAspectRatio,
  parseViewBox,
  samplingScale,
  toMatrix3,
  toMatrix4,
  transformPositions,
  transformRect,
  translation,
  viewportMatrix,
} from "./geometry.js";

/**
 * @param {readonly number[]} actual
 * @param {readonly number[]} expected
 * @param {string} [message]
 */
function assertClose(actual, expected, message) {
  assert.equal(actual.length, expected.length, message);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) < 1e-9,
      `${message ?? "matrix"}: element ${i} is ${actual[i]}, expected ${expected[i]} (${actual})`,
    );
  }
}

describe("svg geometry", () => {
  test("multiply applies the right-hand matrix first", () => {
    // Scale by two, then move by (10, 0): a point at x = 1 lands at 12.
    const m = multiply(translation(10, 0), [2, 0, 0, 2, 0, 0]);
    assert.deepEqual(apply(m, 1, 0), [12, 0]);
    // The other way round: move, then scale — (1 + 10) * 2.
    const n = multiply([2, 0, 0, 2, 0, 0], translation(10, 0));
    assert.deepEqual(apply(n, 1, 0), [22, 0]);
  });

  test("aboutOrigin rotates about the given point", () => {
    // A quarter turn about (10, 10): the point (20, 10) goes to (10, 20).
    const quarter = /** @type {const} */ ([0, 1, -1, 0, 0, 0]);
    const [x, y] = apply(aboutOrigin(quarter, 10, 10), 20, 10);
    assert.ok(Math.abs(x - 10) < 1e-9 && Math.abs(y - 20) < 1e-9, `(${x}, ${y})`);
    // About the origin it is the matrix itself, identically.
    assert.equal(aboutOrigin(quarter, 0, 0), quarter);
  });

  test("matrixScale is the geometric mean of the axis scales", () => {
    assert.equal(matrixScale([2, 0, 0, 8, 5, 5]), 4);
    assert.equal(matrixScale(IDENTITY), 1);
    // A rotation scales nothing.
    assert.ok(Math.abs(matrixScale([0.6, 0.8, -0.8, 0.6, 0, 0]) - 1) < 1e-9);
  });

  test("transformPositions leaves z alone", () => {
    const positions = new Float32Array([1, 2, 7, 3, 4, 7]);
    transformPositions(positions, [2, 0, 0, 2, 1, 1]);
    assert.deepEqual([...positions], [3, 5, 7, 7, 9, 7]);
  });

  test("parseCssMatrix reads matrix() and the plane of matrix3d()", () => {
    assert.deepEqual(parseCssMatrix("matrix(1, 0, 0, 1, 10, 5)"), [1, 0, 0, 1, 10, 5]);
    assert.deepEqual(
      parseCssMatrix("matrix3d(2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1)"),
      [2, 0, 0, 3, 10, 20],
    );
    assert.equal(parseCssMatrix("none"), null);
    assert.equal(parseCssMatrix(""), null);
    assert.equal(parseCssMatrix("matrix(1, 0, 0)"), null);
  });

  test("transformRect keeps a rect with no area empty, under any matrix", () => {
    /** @type {Matrix2D} */
    const turn = [0.866, 0.5, -0.5, 0.866, 0, 0];
    const empty = (/** @type {Rect} */ r) => r.right <= r.left || r.bottom <= r.top;
    // A line and an inverted rect, which `intersectRects` gives for two
    // that share nothing.
    assert.ok(empty(transformRect(turn, { left: 5, top: 2, right: 5, bottom: 7 })), "a line");
    assert.ok(empty(transformRect(turn, { left: 9, top: 0, right: 3, bottom: 4 })), "inverted");
    // A matrix that flattens the plane leaves no area either.
    assert.ok(
      empty(transformRect([0, 0.5, 0, 0.866, 0, 0], { left: 0, top: 0, right: 1, bottom: 1 })),
      "flattened",
    );
    // Inverted, so no pixel of it is drawn, as one at a point would be.
    assert.deepEqual(transformRect(turn, { left: 0, top: 0, right: 0, bottom: 0 }), {
      left: 0,
      top: 0,
      right: -UNBOUNDED,
      bottom: -UNBOUNDED,
    });
  });

  test("parseViewBox takes spaces or commas and refuses an empty box", () => {
    assert.deepEqual(parseViewBox("0 0 24 24"), { x: 0, y: 0, width: 24, height: 24 });
    assert.deepEqual(parseViewBox(" -5, 10,20,40 "), { x: -5, y: 10, width: 20, height: 40 });
    assert.equal(parseViewBox("0 0 0 24"), null);
    assert.equal(parseViewBox("0 0 24"), null);
    assert.equal(parseViewBox(null), null);
  });

  test("parsePreserveAspectRatio defaults to xMidYMid meet", () => {
    assert.deepEqual(parsePreserveAspectRatio(null), { align: "xMidYMid", meet: true });
    assert.deepEqual(parsePreserveAspectRatio("xMinYMax slice"), {
      align: "xMinYMax",
      meet: false,
    });
    assert.deepEqual(parsePreserveAspectRatio("none"), { align: "none", meet: true });
    assert.deepEqual(parsePreserveAspectRatio("sideways"), { align: "xMidYMid", meet: true });
  });

  describe("viewportMatrix", () => {
    const box = { x: 0, y: 0, width: 100, height: 50 };

    test("is the identity without a viewBox", () => {
      assert.equal(viewportMatrix(null, parsePreserveAspectRatio(null), 200, 100), IDENTITY);
    });

    test("scales uniformly and centres under meet", () => {
      // A 100×50 box in a 200×200 viewport: scale 2, 100px of slack in y,
      // half of it above.
      assertClose(
        viewportMatrix(box, parsePreserveAspectRatio(null), 200, 200),
        [2, 0, 0, 2, 0, 50],
        "meet",
      );
    });

    test("aligns to the start and the end", () => {
      assertClose(
        viewportMatrix(box, parsePreserveAspectRatio("xMinYMin meet"), 200, 200),
        [2, 0, 0, 2, 0, 0],
        "min",
      );
      assertClose(
        viewportMatrix(box, parsePreserveAspectRatio("xMaxYMax meet"), 200, 200),
        [2, 0, 0, 2, 0, 100],
        "max",
      );
    });

    test("covers under slice", () => {
      // Scale 4 to cover the height; the box is then 400 wide in a 200
      // viewport, centred by pulling 100 to the left.
      assertClose(
        viewportMatrix(box, parsePreserveAspectRatio("xMidYMid slice"), 200, 200),
        [4, 0, 0, 4, -100, 0],
        "slice",
      );
    });

    test("stretches under none", () => {
      assertClose(
        viewportMatrix(box, parsePreserveAspectRatio("none"), 200, 200),
        [2, 0, 0, 4, 0, 0],
        "none",
      );
    });

    test("subtracts the viewBox origin", () => {
      const offset = { x: 10, y: 20, width: 100, height: 50 };
      const m = viewportMatrix(offset, parsePreserveAspectRatio("none"), 100, 50);
      // The box's own corner lands on the viewport's.
      assert.deepEqual(apply(m, 10, 20), [0, 0]);
    });
  });

  test("a matrix reaches three's 4×4 and 3×3 as the same map of the plane", () => {
    const m = multiply(translation(7, -3), [0, 1, -1, 0, 0, 0]);
    const [x, y] = apply(m, 2, 5);
    const four = new THREE.Vector3(2, 5, 4).applyMatrix4(toMatrix4(m, new THREE.Matrix4()));
    assertClose([four.x, four.y, four.z], [x, y, 4], "4×4, z passed through");
    const three = new THREE.Vector3(2, 5, 1).applyMatrix3(toMatrix3(m, new THREE.Matrix3()));
    assertClose([three.x, three.y, three.z], [x, y, 1], "3×3, homogeneous");
  });

  test("the sampling scale climbs in half-octaves and never rounds down", () => {
    assert.equal(samplingScale(1), 1);
    assert.equal(samplingScale(2), 2);
    assert.equal(samplingScale(1.1), Math.SQRT2);
    assert.equal(samplingScale(1.3), Math.SQRT2, "a small zoom is the same rung");
    assert.ok(samplingScale(1.5) > 1.5);
    assert.ok(samplingScale(0.3) >= 0.3 && samplingScale(0.3) < 0.3 * Math.SQRT2);
    assert.equal(samplingScale(0), 1, "a degenerate matrix samples as if unscaled");
    assert.equal(samplingScale(Number.NaN), 1);
  });
});
