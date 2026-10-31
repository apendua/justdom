import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  carryHalfPlanes,
  clearHalfPlanes,
  createHalfPlaneUniforms,
  halfPlanesOf,
  MAX_HALF_PLANES,
  writeHalfPlanes,
} from "./halfPlanes.js";
import { applyClip, applyReveal } from "./clip.js";
import { createRectMaterial } from "./sdfRect.js";

/**
 * What `onBeforeCompile` makes of a built-in material's shaders, cut down to
 * the chunks the clip patch looks for.
 *
 * @param {THREE.Material} material
 */
function compile(material) {
  const shader = {
    uniforms: /** @type {Record<string, { value: unknown }>} */ ({}),
    vertexShader: "void main() {\n#include <begin_vertex>\n#include <project_vertex>\n}",
    fragmentShader: "void main() {\n#include <alphatest_fragment>\n}",
  };
  material.onBeforeCompile(/** @type {never} */ (shader), /** @type {never} */ (null));
  return shader;
}

describe("half-plane uniforms", () => {
  test("cut nothing until a piece is written into them", () => {
    const uniforms = createHalfPlaneUniforms();
    assert.equal(uniforms.uHalfPlaneCount.value, 0);
    assert.equal(uniforms.uHalfPlanes.value.length, MAX_HALF_PLANES);
    assert.equal(uniforms.uHalfPlaneSides.value.length, MAX_HALF_PLANES);
  });

  test("take a piece's planes into world space, with the sides it keeps", () => {
    const uniforms = createHalfPlaneUniforms();
    // The plane x = 10 in the panel's frame, the panel 100 px to the right.
    const planes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), -10)];
    const panelToWorld = new THREE.Matrix4().makeTranslation(100, 0, 0);
    writeHalfPlanes(uniforms, planes, [-1], panelToWorld);
    assert.equal(uniforms.uHalfPlaneCount.value, 1);
    assert.deepEqual(uniforms.uHalfPlanes.value[0].toArray(), [1, 0, 0, -110]);
    assert.equal(uniforms.uHalfPlaneSides.value[0], -1);
    assert.equal(planes[0].constant, -10, "the piece's own plane is left as it was");

    clearHalfPlanes(uniforms);
    assert.equal(uniforms.uHalfPlaneCount.value, 0);
  });

  test("hold a piece's first half-planes when it has more than fit", () => {
    const uniforms = createHalfPlaneUniforms();
    const count = MAX_HALF_PLANES + 3;
    const planes = Array.from(
      { length: count },
      (_, i) => new THREE.Plane(new THREE.Vector3(0, 1, 0), -i),
    );
    writeHalfPlanes(uniforms, planes, new Array(count).fill(1), new THREE.Matrix4());
    assert.equal(uniforms.uHalfPlaneCount.value, MAX_HALF_PLANES);
    assert.equal(uniforms.uHalfPlanes.value[MAX_HALF_PLANES - 1].w, -(MAX_HALF_PLANES - 1));
  });
});

describe("the materials that carry half-planes", () => {
  test("a clipped material has its own, which its shader tests first", () => {
    const one = new THREE.MeshBasicMaterial();
    const other = new THREE.MeshBasicMaterial();
    const clip = { value: new THREE.Vector4(0, 0, 10, 10) };
    applyClip(one, clip);
    applyClip(other, clip);
    const shader = compile(one);
    const own = halfPlanesOf(one);
    assert.ok(own);
    assert.notEqual(own, halfPlanesOf(other));
    assert.equal(carryHalfPlanes(one), own, "asked again, the same ones");
    assert.equal(shader.uniforms.uHalfPlanes, own.uHalfPlanes);
    assert.equal(shader.uniforms.uHalfPlaneCount, own.uHalfPlaneCount);
    assert.match(shader.vertexShader, /vHalfPlaneWorld = \(modelMatrix \* vec4\(transformed/);
    assert.match(shader.fragmentShader, /void main\(\) \{\n\tclipHalfPlanes\(\);/);
  });

  test("so does a revealed run's", () => {
    const material = new THREE.MeshBasicMaterial();
    applyReveal(material, { value: new THREE.Vector4() }, { value: new THREE.Vector4() });
    const shader = compile(material);
    assert.equal(shader.uniforms.uHalfPlanes, halfPlanesOf(material)?.uHalfPlanes);
    assert.match(shader.fragmentShader, /clipHalfPlanes\(\);/);
  });

  test("a box's material has them among its uniforms", () => {
    const material = createRectMaterial();
    const own = halfPlanesOf(material);
    assert.ok(own);
    assert.equal(own.uHalfPlaneCount, material.uniforms.uHalfPlaneCount);
    assert.match(material.vertexShader, /vHalfPlaneWorld = \(modelMatrix \* vec4\(position/);
    assert.match(material.fragmentShader, /clipHalfPlanes\(\);/);
  });

  test("a material that draws no panel content has none", () => {
    assert.equal(halfPlanesOf(new THREE.MeshBasicMaterial()), null);
    assert.equal(halfPlanesOf(new THREE.ShaderMaterial()), null);
  });
});
