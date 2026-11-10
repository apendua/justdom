import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { keepSubtreeMatrices, markMoved, place, placeAndScale } from "./place.js";
import { noteMatrixChange } from "../matrixEpoch.js";

/**
 * A scene shaped like an app holding a panel: a group the app moved once and
 * left alone on three's defaults, a perimeter the panel owns, and leaves that
 * keep their own matrices.
 *
 * @param {{ guard?: boolean }} [options]
 */
function scene({ guard = true } = {}) {
  const root = new THREE.Scene();

  const group = new THREE.Group();
  // Exactly what an app writes: once, from an effect, and never again.
  group.position.set(0, 0, -0.5);
  root.add(group);

  const perimeter = new THREE.Group();
  place(perimeter, 0, 1, 0);
  if (guard) {
    keepSubtreeMatrices(perimeter);
  }
  group.add(perimeter);

  /** @type {{ object: THREE.Object3D, worlds: number }[]} */
  const leaves = [];
  for (let i = 0; i < 4; i++) {
    const object = new THREE.Object3D();
    place(object, i, 0, 0);
    const entry = { object, worlds: 0 };
    const multiply = object.matrixWorld.multiplyMatrices.bind(object.matrixWorld);
    object.matrixWorld.multiplyMatrices = (a, b) => {
      entry.worlds += 1;
      return multiply(a, b);
    };
    leaves.push(entry);
    perimeter.add(object);
  }

  return {
    root,
    group,
    perimeter,
    leaves,
    /** @param {number} times */
    walk(times = 1) {
      for (let i = 0; i < times; i++) {
        root.updateMatrixWorld();
      }
    },
    recomputes() {
      return leaves.map((leaf) => leaf.worlds);
    },
    reset() {
      for (const leaf of leaves) {
        leaf.worlds = 0;
      }
    },
  };
}

describe("keepSubtreeMatrices", () => {
  test("a subtree that has not moved is not recomputed, whatever the scene above does", () => {
    const s = scene();
    s.walk();
    s.reset();
    // Ten walks in which nothing anywhere is touched. The group above the
    // perimeter is still on three's default and recomposes its own matrix on
    // every one of them.
    s.walk(10);
    assert.deepEqual(s.recomputes(), [0, 0, 0, 0]);
  });

  test("without it, that same scene recomputes the whole subtree every walk", () => {
    const s = scene({ guard: false });
    s.walk();
    s.reset();
    s.walk(10);
    assert.deepEqual(s.recomputes(), [10, 10, 10, 10]);
  });

  test("a subtree whose ancestor really moves is recomputed, and lands in the right place", () => {
    const s = scene();
    s.walk();
    s.reset();

    s.group.position.set(0, 0, -2);
    s.walk();

    assert.deepEqual(s.recomputes(), [1, 1, 1, 1]);
    const world = new THREE.Vector3().setFromMatrixPosition(s.leaves[2].object.matrixWorld);
    assert.deepEqual([world.x, world.y, world.z], [2, 1, -2]);
  });

  test("the perimeter's own move reaches the subtree", () => {
    const s = scene();
    s.walk();
    s.reset();

    placeAndScale(s.perimeter, 0, 1, 0, 2, 2, 2);
    s.walk();

    assert.deepEqual(s.recomputes(), [1, 1, 1, 1]);
    const world = new THREE.Vector3().setFromMatrixPosition(s.leaves[2].object.matrixWorld);
    assert.deepEqual([world.x, world.y, world.z], [4, 1, -0.5]);
  });

  test("a leaf that moves is recomputed on its own", () => {
    const s = scene();
    s.walk();
    s.reset();

    place(s.leaves[1].object, 7, 0, 0);
    s.walk();

    assert.deepEqual(s.recomputes(), [0, 1, 0, 0]);
    const world = new THREE.Vector3().setFromMatrixPosition(s.leaves[1].object.matrixWorld);
    assert.deepEqual([world.x, world.y, world.z], [7, 1, -0.5]);
  });

  test("an object added after the panel settled still gets its world matrix", () => {
    const s = scene();
    s.walk(2);

    const late = new THREE.Object3D();
    place(late, 5, 0, 0);
    s.perimeter.add(late);
    s.walk();

    const world = new THREE.Vector3().setFromMatrixPosition(late.matrixWorld);
    assert.deepEqual([world.x, world.y, world.z], [5, 1, -0.5]);
  });

  test("an idle panel's walk stops at its edge", () => {
    const s = scene();
    const calls = spyOnWalk(s.leaves[2].object);
    s.walk();
    calls.count = 0;
    // The loop's walk and the renderer's, for five frames in which nothing
    // anywhere moved.
    s.walk(10);
    assert.equal(calls.count, 0);
  });

  test("a write anywhere wakes the walk for one descent, and a second walk stops again", () => {
    const s = scene();
    const calls = spyOnWalk(s.leaves[2].object);
    s.walk();
    calls.count = 0;

    place(s.leaves[1].object, 7, 0, 0);
    s.walk(2);

    assert.equal(calls.count, 1);
    const world = new THREE.Vector3().setFromMatrixPosition(s.leaves[1].object.matrixWorld);
    assert.deepEqual([world.x, world.y, world.z], [7, 1, -0.5]);
  });

  test("a matrix composed by hand reaches the walk through markMoved", () => {
    const s = scene();
    s.walk(2);

    const leaf = s.leaves[3].object;
    leaf.matrix.makeTranslation(9, 0, 0);
    markMoved(leaf);
    s.walk();

    const world = new THREE.Vector3().setFromMatrixPosition(leaf.matrixWorld);
    assert.deepEqual([world.x, world.y, world.z], [9, 1, -0.5]);
  });

  test("a write made during a descent wakes the next walk", () => {
    const s = scene();
    s.walk(2);
    const early = s.leaves[0].object;
    // A leaf walked after `early` that moves it, once: `early` has been
    // walked already in that descent, so only the next walk can carry it.
    const late = s.leaves[3].object;
    let pending = true;
    late.updateMatrixWorld = function (force) {
      if (pending) {
        pending = false;
        place(early, 0, 5, 0);
      }
      THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
    };
    noteMatrixChange();
    s.walk();
    s.walk();

    const world = new THREE.Vector3().setFromMatrixPosition(early.matrixWorld);
    assert.deepEqual([world.x, world.y, world.z], [0, 6, -0.5]);
  });

  test("an object on three's defaults under the panel keeps moving by assignment", () => {
    const s = scene();
    const calls = spyOnWalk(s.leaves[2].object);
    s.walk(2);

    // A plugin's object, or an app's, which moves itself by assignment and
    // tells nobody. Its attachment is noted, as every attachment is.
    const spinner = new THREE.Object3D();
    s.perimeter.add(spinner);
    noteMatrixChange();
    s.walk();

    calls.count = 0;
    for (const x of [1, 2, 3]) {
      spinner.position.x = x;
      s.walk();
      const world = new THREE.Vector3().setFromMatrixPosition(spinner.matrixWorld);
      assert.deepEqual([world.x, world.y, world.z], [x, 1, -0.5]);
    }
    // The whole panel is walked while it holds such an object, as before.
    assert.equal(calls.count, 3);

    // And once it is gone, the walk stops at the edge again, after the one
    // descent that finds it gone.
    s.perimeter.remove(spinner);
    s.walk(3);
    assert.equal(calls.count, 4);
  });

  test("a nested panel is skipped with the one around it, and woken with it", () => {
    const s = scene();
    const inner = new THREE.Group();
    place(inner, 0, 0, 1);
    keepSubtreeMatrices(inner);
    const leaf = new THREE.Object3D();
    place(leaf, 1, 0, 0);
    inner.add(leaf);
    s.perimeter.add(inner);
    const calls = spyOnWalk(leaf);
    s.walk();
    calls.count = 0;

    s.walk(4);
    assert.equal(calls.count, 0);

    s.group.position.set(0, 0, -2);
    s.walk();
    assert.equal(calls.count, 1);
    const world = new THREE.Vector3().setFromMatrixPosition(leaf.matrixWorld);
    assert.deepEqual([world.x, world.y, world.z], [1, 1, -1]);

    place(leaf, 3, 0, 0);
    s.walk(2);
    assert.equal(calls.count, 2);
    world.setFromMatrixPosition(leaf.matrixWorld);
    assert.deepEqual([world.x, world.y, world.z], [3, 1, -1]);
  });

  test("a nested panel holding an object on three's defaults keeps the outer walk going", () => {
    const s = scene();
    const inner = new THREE.Group();
    place(inner, 0, 0, 1);
    keepSubtreeMatrices(inner);
    const spinner = new THREE.Object3D();
    inner.add(spinner);
    s.perimeter.add(inner);
    s.walk(2);

    spinner.position.x = 4;
    s.walk();
    const world = new THREE.Vector3().setFromMatrixPosition(spinner.matrixWorld);
    assert.deepEqual([world.x, world.y, world.z], [4, 1, 0.5]);
  });
});

/**
 * Count the walks that reach an object, by giving it a walk of its own that
 * does what three's does.
 *
 * @param {THREE.Object3D} object
 * @returns {{ count: number }}
 */
function spyOnWalk(object) {
  const calls = { count: 0 };
  object.updateMatrixWorld = function (force) {
    calls.count += 1;
    THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
  };
  return calls;
}

describe("matrix writes under a panel", () => {
  /**
   * Every module of the package, but its tests and test helpers.
   *
   * @param {string} directory
   * @returns {string[]}
   */
  const modules = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "test" ? [] : modules(path);
      }
      return entry.name.endsWith(".js") && !entry.name.endsWith(".test.js") ? [path] : [];
    });

  test("go through place.js, or note the change themselves", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    /** @type {string[]} */
    const found = [];
    for (const path of modules(src)) {
      const name = relative(src, path);
      if (name === join("elements", "place.js")) {
        continue;
      }
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, i) => {
        const writes =
          /\.matrixWorldNeedsUpdate\s*=[^=]/.test(line) || /\.updateMatrix\(\)/.test(line);
        if (!writes) {
          return;
        }
        // A write followed at once by the note keeps the rule; so does one
        // the line before explains with the marker.
        const noted = /noteMatrixChange\(\)/.test(lines[i + 1] ?? "");
        const exempt = /matrix-epoch:/.test(lines[i - 1] ?? "");
        if (!noted && !exempt) {
          found.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(found, []);
  });
});
