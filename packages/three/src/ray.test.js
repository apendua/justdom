import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { OVERLAY_PANEL_ORDER } from "./drawOrder.js";
import { HANDLE_RENDER_ORDER } from "./elements/panelHandles.js";
import {
  createRay,
  RAY_FADE_IN,
  RAY_OPACITY,
  RAY_REACH,
  RAY_WIDTH_FAR,
  RAY_WIDTH_NEAR,
} from "./ray.js";

describe("createRay", () => {
  test("is a quad from the origin down -z to z = -1, so its length is its z scale", () => {
    const ray = createRay();
    ray.geometry.computeBoundingBox();
    const box = /** @type {THREE.Box3} */ (ray.geometry.boundingBox);
    assert.equal(box.max.z, 0);
    assert.equal(box.min.z, -1);
    // Two triangles, whatever the length.
    assert.equal(ray.geometry.index?.count, 6);
  });

  test("is a soft beam faded with distance, not a line", () => {
    const ray = createRay();
    assert.ok(ray instanceof THREE.Mesh);
    /** @type {THREE.Object3D} */
    const drawn = ray;
    assert.equal(drawn instanceof THREE.Line, false);
    const { material } = ray;
    assert.equal(material.transparent, true);
    assert.equal(material.depthWrite, false);
    assert.equal(material.uniforms.reach.value, RAY_REACH);
    assert.equal(material.uniforms.fadeIn.value, RAY_FADE_IN);
    assert.ok(RAY_FADE_IN < RAY_REACH);
    assert.equal(material.uniforms.opacity.value, RAY_OPACITY);
    assert.equal(material.uniforms.widthNear.value, RAY_WIDTH_NEAR);
    assert.equal(material.uniforms.widthFar.value, RAY_WIDTH_FAR);
    assert.ok(RAY_WIDTH_FAR > RAY_WIDTH_NEAR, "the beam spreads as it fades");
    assert.match(material.fragmentShader, /reach/);
  });

  test("draws after the world's panels and their strips, and before the overlays", () => {
    const ray = createRay();
    // Three sorts the transparent pass by `renderOrder` first, and the beam
    // writes no depth, so a panel drawn after it would paint over it.
    assert.ok(ray.renderOrder > HANDLE_RENDER_ORDER, "after a world panel's strips");
    assert.ok(ray.renderOrder < OVERLAY_PANEL_ORDER, "before the overlays' depth clear");
    // Still hidden by what stands in front of it.
    assert.equal(ray.material.depthTest, true);
  });

  test("is no target for a raycaster", () => {
    const ray = createRay();
    ray.scale.z = 2;
    ray.updateMatrixWorld();
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(0.5, 1, -1),
      new THREE.Vector3(0, -1, 0),
    );
    assert.deepEqual(raycaster.intersectObject(ray), []);
  });

  test("every clone draws from one geometry and one material", () => {
    const ray = createRay();
    const left = ray.clone();
    const right = ray.clone();
    assert.equal(left.geometry, right.geometry);
    assert.equal(left.material, right.material);
    // The length is each clone's own.
    left.scale.z = 0.4;
    assert.equal(right.scale.z, 1);
  });

  test("takes its colour", () => {
    const ray = createRay("#ff0000");
    assert.equal(ray.material.uniforms.color.value.getHexString(), "ff0000");
  });
});
