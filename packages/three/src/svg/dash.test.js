import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { dashRuns, normalizeDashArray } from "./dash.js";

/**
 * @param {number[][]} coordinates
 * @returns {THREE.Vector2[]}
 */
function polyline(coordinates) {
  return coordinates.map(([x, y]) => new THREE.Vector2(x, y));
}

/**
 * @param {THREE.Vector2[][]} runs
 * @returns {number[][][]}
 */
function plain(runs) {
  return runs.map((run) => run.map((point) => [round(point.x), round(point.y)]));
}

/**
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * @param {THREE.Vector2[]} run
 */
function length(run) {
  let total = 0;
  for (let i = 1; i < run.length; i++) {
    total += run[i].distanceTo(run[i - 1]);
  }
  return round(total);
}

describe("normalizeDashArray", () => {
  test("doubles an odd list, as the specification says", () => {
    assert.deepEqual(normalizeDashArray([5, 3, 2]), [5, 3, 2, 5, 3, 2]);
    assert.deepEqual(normalizeDashArray([4, 2]), [4, 2]);
  });

  test("a solid line for nothing, a negative, or all zeros", () => {
    assert.equal(normalizeDashArray([]), null);
    assert.equal(normalizeDashArray([4, -1]), null);
    assert.equal(normalizeDashArray([0, 0]), null);
    assert.equal(normalizeDashArray([Number.NaN, 2]), null);
  });
});

describe("dashRuns", () => {
  test("cuts a straight line into dashes and gaps", () => {
    const runs = dashRuns(
      polyline([
        [0, 0],
        [10, 0],
      ]),
      [2, 3],
      0,
    );
    assert.deepEqual(plain(runs), [
      [
        [0, 0],
        [2, 0],
      ],
      [
        [5, 0],
        [7, 0],
      ],
    ]);
  });

  test("a dash that reaches the end is kept", () => {
    // Pattern 2 on, 2 off, over 6: on 0–2, off 2–4, on 4–6 ends exactly at
    // the end of the line.
    const runs = dashRuns(
      polyline([
        [0, 0],
        [6, 0],
      ]),
      [2, 2],
      0,
    );
    assert.deepEqual(plain(runs), [
      [
        [0, 0],
        [2, 0],
      ],
      [
        [4, 0],
        [6, 0],
      ],
    ]);
  });

  test("a positive offset pulls the pattern back along the line", () => {
    // Starting one unit into the first dash leaves one unit of it.
    const runs = dashRuns(
      polyline([
        [0, 0],
        [10, 0],
      ]),
      [2, 3],
      1,
    );
    assert.deepEqual(plain(runs), [
      [
        [0, 0],
        [1, 0],
      ],
      [
        [4, 0],
        [6, 0],
      ],
      [
        [9, 0],
        [10, 0],
      ],
    ]);
  });

  test("an offset wraps in either direction", () => {
    const forward = dashRuns(
      polyline([
        [0, 0],
        [10, 0],
      ]),
      [2, 3],
      6,
    );
    const backward = dashRuns(
      polyline([
        [0, 0],
        [10, 0],
      ]),
      [2, 3],
      -4,
    );
    assert.deepEqual(plain(forward), plain(backward));
    assert.deepEqual(plain(forward), [
      [
        [0, 0],
        [1, 0],
      ],
      [
        [4, 0],
        [6, 0],
      ],
      [
        [9, 0],
        [10, 0],
      ],
    ]);
  });

  test("an offset into a gap starts off", () => {
    const runs = dashRuns(
      polyline([
        [0, 0],
        [10, 0],
      ]),
      [2, 3],
      3,
    );
    assert.deepEqual(plain(runs), [
      [
        [2, 0],
        [4, 0],
      ],
      [
        [7, 0],
        [9, 0],
      ],
    ]);
  });

  test("a dash carries across a corner", () => {
    // 3 on, 1 off, along two sides of a square: the first dash runs to
    // (3, 0); the second starts at (4, 0), turns the corner at (5, 0) and
    // ends one unit down.
    const runs = dashRuns(
      polyline([
        [0, 0],
        [5, 0],
        [5, 5],
      ]),
      [3, 1],
      0,
    );
    assert.deepEqual(plain(runs), [
      [
        [0, 0],
        [3, 0],
      ],
      [
        [4, 0],
        [5, 0],
        [5, 2],
      ],
      [
        [5, 3],
        [5, 5],
      ],
    ]);
  });

  test("the pattern follows arc length, not the sampling", () => {
    // The same line sampled at two densities cuts at the same places.
    const coarse = dashRuns(
      polyline([
        [0, 0],
        [10, 0],
      ]),
      [4, 1],
      0,
    );
    const fine = dashRuns(
      polyline([
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
        [5, 0],
        [6, 0],
        [7, 0],
        [8, 0],
        [9, 0],
        [10, 0],
      ]),
      [4, 1],
      0,
    );
    assert.deepEqual(
      fine.map((run) => [run[0].x, run[run.length - 1].x]),
      coarse.map((run) => [run[0].x, run[run.length - 1].x]),
    );
  });

  test("zero-length dashes are dropped under butt caps and become dots otherwise", () => {
    const line = polyline([
      [0, 0],
      [10, 0],
    ]);
    assert.deepEqual(dashRuns(line, [0, 4], 0, 0), []);
    const dots = dashRuns(line, [0, 4], 0, 0.5);
    // Dots at 0, 4 and 8, each half a unit long and centred.
    assert.deepEqual(plain(dots), [
      [
        [-0.25, 0],
        [0.25, 0],
      ],
      [
        [3.75, 0],
        [4.25, 0],
      ],
      [
        [7.75, 0],
        [8.25, 0],
      ],
    ]);
    for (const dot of dots) {
      assert.equal(length(dot), 0.5);
    }
  });

  test("a closed path is dashed like an open one", () => {
    const square = polyline([
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0, 0],
    ]);
    const runs = dashRuns(square, [2, 2], 0);
    // Perimeter 16, pattern 4: four dashes, each of length 2.
    assert.equal(runs.length, 4);
    for (const run of runs) {
      assert.equal(length(run), 2);
    }
  });

  test("duplicate points do not stall the pattern", () => {
    const runs = dashRuns(
      polyline([
        [0, 0],
        [0, 0],
        [5, 0],
        [5, 0],
        [10, 0],
      ]),
      [2, 3],
      0,
    );
    assert.deepEqual(plain(runs), [
      [
        [0, 0],
        [2, 0],
      ],
      [
        [5, 0],
        [7, 0],
      ],
    ]);
  });

  test("nothing for fewer than two points", () => {
    assert.deepEqual(dashRuns(polyline([[0, 0]]), [2, 3], 0), []);
    assert.deepEqual(dashRuns([], [2, 3], 0), []);
  });
});
