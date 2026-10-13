import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GlobalSpace, XRReferenceSpace, XRReferenceSpaceType, XRRigidTransform } from "iwer";
import { offsetByTransform } from "./offsetSpaces.js";

/**
 * The offset a space carries, as the pose of its origin in its parent:
 * read the way IWER's own frames read it, from the space's private state.
 *
 * @param {XRReferenceSpace} space
 */
function offsetOf(space) {
  const state = Object.getOwnPropertySymbols(space)
    .map((symbol) => /** @type {any} */ (space)[symbol])
    .find((value) => typeof value === "object" && value !== null && "offsetMatrix" in value);
  return Array.from(/** @type {Float32Array} */ (state.offsetMatrix));
}

// IWER's transforms are built of the browser's DOMPointReadOnly, which node
// does not have. Only its four fields are read.
const GLOBAL = /** @type {{ DOMPointReadOnly?: unknown }} */ (/** @type {unknown} */ (globalThis));
GLOBAL.DOMPointReadOnly ??= class {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    Object.assign(this, { x, y, z, w });
  }
};

describe("offsetByTransform", () => {
  it("offsets the new space by the transform's matrix", () => {
    class Space extends XRReferenceSpace {}
    offsetByTransform(Space);
    const local = new Space(XRReferenceSpaceType.Local, new GlobalSpace());
    const transform = new XRRigidTransform({ x: 0, y: 1.6, z: -2 }, { x: 0, y: 0, z: 0, w: 1 });
    // IWER types the argument as the matrix it wrongly expects; three
    // passes a transform, as the WebXR spec has it do, and so does freedom
    // until a space comes out as NaN.
    const offset = local.getOffsetReferenceSpace(/** @type {any} */ (transform));
    assert.deepEqual(offsetOf(offset), Array.from(transform.matrix));
  });

  it("is needed: IWER on its own offsets the space by NaN", () => {
    // When IWER fixes this, the test fails, and the shim can go.
    const local = new XRReferenceSpace(XRReferenceSpaceType.Local, new GlobalSpace());
    const transform = new XRRigidTransform({ x: 0, y: 1, z: 0 });
    const offset = local.getOffsetReferenceSpace(/** @type {any} */ (transform));
    assert.ok(offsetOf(offset).every(Number.isNaN));
  });
});
