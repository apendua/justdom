import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { keepSubtreeMatrices, place, placeAndScale } from "./place.js";

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
});
