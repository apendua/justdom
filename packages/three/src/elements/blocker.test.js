import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { coverBox, createBlocker } from "./blocker.js";

describe("a blocker", () => {
  test("is left out of the draw, as it writes neither colour nor depth", () => {
    const blocker = createBlocker();
    // Three leaves a mesh whose material is not visible out of its render
    // list, the way a batched box's is, so a blocker costs no draw call.
    assert.equal(blocker.material.visible, false);
    assert.equal(blocker.visible, true, "while the mesh itself stays visible");
  });

  test("still stops a ray", () => {
    const blocker = createBlocker();
    coverBox(blocker, 100, 50, 0);
    blocker.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(30, 10, 10),
      new THREE.Vector3(0, 0, -1),
    );
    const hits = raycaster.intersectObject(blocker);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].object, blocker);
  });
});
