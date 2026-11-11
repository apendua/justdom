import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { coverBox, createBlocker } from "./blocker.js";
import { intersectVisible } from "../interactions.js";

/**
 * @import {XREventMap} from '../core.js';
 */

describe("a blocker", () => {
  test("stops a ray in the hit test's walk, though its material is not drawn", () => {
    const blocker = createBlocker();
    coverBox(blocker, 100, 50, 0);
    blocker.updateMatrixWorld(true);
    // Off the quad's diagonal, which both its triangles share.
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(30, 10, 10),
      new THREE.Vector3(0, 0, -1),
    );
    /** @type {THREE.Intersection<THREE.Object3D<XREventMap>>[]} */
    const intersections = [];
    intersectVisible(raycaster, blocker, intersections);
    assert.equal(intersections.length, 1);
    assert.equal(intersections[0].object, blocker);
  });

  /**
   * A blocker 2 px behind a 100 by 50 box, in the box's frame, and a ray
   * from in front of the box towards `x` on the box's plane, slanting
   * towards smaller x.
   *
   * @param {number} x
   */
  const castBehindBox = (x) => {
    /** @type {THREE.Object3D<XREventMap>} */
    const box = new THREE.Object3D();
    const blocker = createBlocker();
    box.add(blocker);
    coverBox(blocker, 100, 50, 2);
    box.updateMatrixWorld(true);
    const direction = new THREE.Vector3(-0.05, 0, 1).normalize();
    const origin = new THREE.Vector3(x, 25, 0).addScaledVector(direction, -100);
    /** @type {THREE.Intersection<THREE.Object3D<XREventMap>>[]} */
    const intersections = [];
    intersectVisible(new THREE.Raycaster(origin, direction), box, intersections);
    return intersections;
  };

  test("is met where the ray crosses the box's plane, and only inside the box", () => {
    // Past the box's right edge on its plane, and inside it 2 px behind.
    assert.deepEqual(castBehindBox(100.05), []);
    const [hit] = castBehindBox(60);
    assert.ok(hit);
    assert.deepEqual(
      hit.point.toArray().map((v) => Math.round(v * 1000) / 1000),
      [60, 25, 0],
    );
  });
});
