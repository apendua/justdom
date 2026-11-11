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
   * A blocker 2 px behind a 100 by 50 box, under a box frame moved, turned
   * and scaled as a portal's container or an overlay's object is, and a ray
   * from in front of the box towards `x` on the box's plane, slanting by
   * `slant` in x. Where the ray meets the blocker, in the box's frame.
   *
   * @param {number} x
   * @param {number} slant
   */
  const castBehindBox = (x, slant) => {
    /** @type {THREE.Object3D<XREventMap>} */
    const box = new THREE.Object3D();
    box.position.set(0.3, 1.2, -0.5);
    box.rotation.set(Math.PI, 0.4, 0);
    box.scale.setScalar(0.001);
    const blocker = createBlocker();
    box.add(blocker);
    coverBox(blocker, 100, 50, 2);
    box.updateMatrixWorld(true);
    const direction = new THREE.Vector3(slant, 0, 1).normalize();
    const origin = new THREE.Vector3(x, 25, 0).addScaledVector(direction, -100);
    box.localToWorld(origin);
    direction.transformDirection(box.matrixWorld);
    /** @type {THREE.Intersection<THREE.Object3D<XREventMap>>[]} */
    const intersections = [];
    intersectVisible(new THREE.Raycaster(origin, direction), box, intersections);
    return intersections.map(({ point }) =>
      box
        .worldToLocal(point.clone())
        .toArray()
        .map((v) => Math.round(v * 1000) / 1000 + 0),
    );
  };

  test("is met where the ray crosses the box's plane, and only inside the box", () => {
    // Past the right edge on the box's plane, and over the quad 2 px behind.
    assert.deepEqual(castBehindBox(100.05, -0.05), []);
    // Inside the right edge on the box's plane, and past the quad behind.
    assert.deepEqual(castBehindBox(99.95, 0.05), [[99.95, 25, 0]]);
    assert.deepEqual(castBehindBox(60, -0.05), [[60, 25, 0]]);
  });
});
