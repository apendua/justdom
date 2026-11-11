import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { markChanged } from "./instanceUploads.js";

/** A buffer of four instances of two floats each, numbered from one. */
const buffer = () =>
  new THREE.InstancedBufferAttribute(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), 2);

describe("marking instance buffers that changed", () => {
  test("marks a buffer the first time it is seen", () => {
    const attribute = buffer();
    markChanged(attribute, 4);
    assert.equal(attribute.version, 1);
  });

  test("leaves a buffer whose drawn instances hold what they held", () => {
    const attribute = buffer();
    markChanged(attribute, 4);
    attribute.array[3] = 4;
    markChanged(attribute, 4);
    assert.equal(attribute.version, 1);
  });

  test("marks a buffer when one of its drawn instances changed", () => {
    const attribute = buffer();
    markChanged(attribute, 4);
    attribute.array[5] = 60;
    markChanged(attribute, 4);
    assert.equal(attribute.version, 2);
    // And remembers the change, so the same numbers again are no change.
    markChanged(attribute, 4);
    assert.equal(attribute.version, 2);
  });

  test("compares only the instances that are drawn", () => {
    const attribute = buffer();
    markChanged(attribute, 4);
    attribute.array[7] = 80;
    markChanged(attribute, 3);
    assert.equal(attribute.version, 1);
    // Drawn again, the fourth is a change.
    markChanged(attribute, 4);
    assert.equal(attribute.version, 2);
  });
});
