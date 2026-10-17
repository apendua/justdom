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
});
