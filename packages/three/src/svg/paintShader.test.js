import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyClip } from "../elements/clip.js";
import { rampAtlas, RampSlot } from "../elements/gradient.js";
import { apply, IDENTITY } from "./geometry.js";
import { applyPaint, createPaintUniforms, toGradientSpace, writePaint } from "./paintShader.js";
import { SPREAD_REFLECT } from "./paintServer.js";

/**
 * @import {GradientServer} from './paintServer.js';
 */

/**
 * @param {Partial<GradientServer>} [overrides]
 * @returns {GradientServer}
 */
function linear(overrides = {}) {
  return {
    kind: "linear",
    objectBox: true,
    transform: null,
    spread: SPREAD_REFLECT,
    coords: [0, 0, 1, 0],
    ramp: {
      repeating: false,
      start: 0,
      period: 1,
      stops: [
        { color: [1, 0, 0, 1], position: 0 },
        { color: [0, 0, 1, 1], position: 1 },
      ],
      hints: [null, null],
      straight: true,
    },
    ...overrides,
  };
}

/**
 * @param {readonly number[]} actual
 * @param {readonly number[]} expected
 */
function assertClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => {
    assert.ok(Math.abs(value - expected[i]) < 1e-9, `[${actual}] is not [${expected}]`);
  });
}

describe("the paint patch", () => {
  test("it lands in three's basic shader, after the clip patch", () => {
    const material = new THREE.MeshBasicMaterial();
    applyClip(material, { value: new THREE.Vector4() }, { value: new THREE.Matrix3() });
    const uniforms = createPaintUniforms();
    applyPaint(material, uniforms);
    const shader = {
      uniforms: /** @type {Record<string, { value: unknown }>} */ ({}),
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    };
    material.onBeforeCompile(/** @type {never} */ (shader), /** @type {never} */ (null));
    assert.equal(shader.uniforms.paintKind, uniforms.paintKind);
    assert.ok(shader.uniforms.clipBox, "the clip patch still runs");
    assert.ok(shader.uniforms.uRamp, "the ramp atlas is bound");
    // Every replacement found its anchor: a chunk renamed in three would
    // leave the patch silently undone.
    assert.match(shader.vertexShader, /vPaintPosition = position\.xy;/);
    assert.match(shader.fragmentShader, /diffuseColor \*= paintColor\(vPaintPosition\)/);
    assert.match(shader.fragmentShader, /vec4 paintColor\(vec2 position\)/);
    assert.match(material.customProgramCacheKey(), /freedom-clip-matrix\+svg-paint/);
  });

  test("objectBoundingBox lays the gradient over the box, then undoes the transform", () => {
    const box = { x: 10, y: 20, width: 40, height: 10 };
    const plain = /** @type {import('./geometry.js').Matrix2D} */ (
      toGradientSpace(linear(), () => box)
    );
    assertClose(apply(plain, 10, 20), [0, 0]);
    assertClose(apply(plain, 50, 30), [1, 1]);
    const turned = /** @type {import('./geometry.js').Matrix2D} */ (
      toGradientSpace(linear({ transform: [2, 0, 0, 2, 0, 0] }), () => box)
    );
    assertClose(apply(turned, 50, 30), [0.5, 0.5]);
  });

  test("user space reads no box", () => {
    let read = false;
    const matrix = toGradientSpace(linear({ objectBox: false }), () => {
      read = true;
      return null;
    });
    assert.deepEqual(matrix, IDENTITY);
    assert.equal(read, false);
  });

  test("nothing is drawn over a box with no area or through a flat transform", () => {
    assert.equal(
      toGradientSpace(linear(), () => ({ x: 0, y: 0, width: 10, height: 0 })),
      null,
    );
    assert.equal(
      toGradientSpace(linear(), () => null),
      null,
    );
    const flat = linear({ objectBox: false, transform: [1, 0, 0, 0, 0, 0] });
    assert.equal(
      toGradientSpace(flat, () => null),
      null,
    );
  });

  test("a gradient takes a ramp row and a flat colour gives it back", () => {
    const uniforms = createPaintUniforms();
    const slot = new RampSlot();
    const before = rampAtlas.size;
    writePaint(uniforms, linear(), [2, 0, 0, 3, 4, 5], slot);
    assert.equal(uniforms.paintKind.value, 1);
    assert.equal(uniforms.paintSpread.value, SPREAD_REFLECT);
    assert.equal(rampAtlas.size, before + 1);
    // Column-major, as GLSL reads it: x' = 2x + 4, y' = 3y + 5.
    const at = new THREE.Vector3(1, 1, 1).applyMatrix3(uniforms.paintMatrix.value);
    assertClose([at.x, at.y], [6, 8]);
    writePaint(uniforms, null, null, slot);
    assert.equal(uniforms.paintKind.value, 0);
    assert.equal(rampAtlas.size, before);
  });
});
