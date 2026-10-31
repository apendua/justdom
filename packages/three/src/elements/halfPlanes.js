import * as THREE from "three";

/*
 * The half-plane test every material that draws panel content carries
 * (`docs/freedom-paint-order.md`, _The cut_). A layer that crosses another
 * layer's plane is drawn once a piece (`layerTree.js`), and a piece is its
 * layer's draws cut down by the planes that split it out of the layer: a
 * fragment is drawn only on the kept side of each. The planes are in world
 * space, written by the panel's walk through the container's world matrix, and
 * tested against the fragment's world position, which is one frame for every
 * material, a batch's draw under the container as much as a picture nested
 * under its element's content group.
 *
 * The test is a fixed array with a count, so a new split never changes a
 * define and never links a program. The paint batch's material has it
 * (`paintBatch.js`), a box's own does (`sdfRect.js`), and so does every
 * material a mark draws itself with (`applyClip` and `applyReveal` in
 * `clip.js`), on every panel, from its build, at a count of 0 where
 * nothing is cut.
 */

/**
 * The most half-planes a piece is drawn with, the length of the uniform
 * array. A piece cut more often is drawn with its first ones.
 */
export const MAX_HALF_PLANES = 8;

/** What the vertex shader declares, before `main`. */
export const HALF_PLANES_VERTEX_GLSL = /* glsl */ `
varying vec3 vHalfPlaneWorld;
`;

/**
 * What the vertex shader writes, in `main`: the world position the test
 * reads.
 *
 * @param {string} world A `vec4` expression for the vertex in world space.
 * @returns {string}
 */
export function passHalfPlaneWorld(world) {
  return `vHalfPlaneWorld = (${world}).xyz;`;
}

/**
 * What the fragment shader declares, before `main`, and the function it
 * calls first in `main`. A side of 1 keeps the points at or in front of a
 * plane and -1 those behind it, so the two pieces of one cut share no
 * point.
 */
export const HALF_PLANES_FRAGMENT_GLSL = /* glsl */ `
varying vec3 vHalfPlaneWorld;
uniform vec4 uHalfPlanes[${MAX_HALF_PLANES}];
uniform float uHalfPlaneSides[${MAX_HALF_PLANES}];
uniform int uHalfPlaneCount;
void clipHalfPlanes() {
  for (int i = 0; i < ${MAX_HALF_PLANES}; i++) {
    if (i >= uHalfPlaneCount) {
      break;
    }
    float d = dot(uHalfPlanes[i].xyz, vHalfPlaneWorld) + uHalfPlanes[i].w;
    if (uHalfPlaneSides[i] > 0.0 ? d < 0.0 : d >= 0.0) {
      discard;
    }
  }
}
`;

/**
 * @typedef {object} HalfPlaneUniforms
 * @property {{ value: THREE.Vector4[] }} uHalfPlanes
 * @property {{ value: number[] }} uHalfPlaneSides
 * @property {{ value: number }} uHalfPlaneCount
 */

/**
 * A material's own half-plane uniforms, none of them cutting.
 *
 * @returns {HalfPlaneUniforms}
 */
export function createHalfPlaneUniforms() {
  return {
    uHalfPlanes: {
      value: Array.from({ length: MAX_HALF_PLANES }, () => new THREE.Vector4()),
    },
    uHalfPlaneSides: { value: new Array(MAX_HALF_PLANES).fill(1) },
    uHalfPlaneCount: { value: 0 },
  };
}

/**
 * Where a patched material (`applyClip` in `clip.js`) keeps its half-plane
 * uniforms, which its `onBeforeCompile` hands its shader.
 *
 * @type {WeakMap<THREE.Material, HalfPlaneUniforms>}
 */
const patchedUniforms = new WeakMap();

/**
 * Give a patched material half-plane uniforms of its own, and say what they
 * are. Its `onBeforeCompile` reads them back with `halfPlanesOf`.
 *
 * @param {THREE.Material} material
 * @returns {HalfPlaneUniforms}
 */
export function carryHalfPlanes(material) {
  let uniforms = patchedUniforms.get(material);
  if (!uniforms) {
    uniforms = createHalfPlaneUniforms();
    patchedUniforms.set(material, uniforms);
  }
  return uniforms;
}

/**
 * A material's half-plane uniforms, or null for one that draws no panel
 * content: a `ShaderMaterial`'s are among its uniforms, a patched one's
 * where `carryHalfPlanes` put them.
 *
 * @param {THREE.Material} material
 * @returns {HalfPlaneUniforms | null}
 */
export function halfPlanesOf(material) {
  const shader = /** @type {THREE.ShaderMaterial} */ (material);
  if (shader.isShaderMaterial && shader.uniforms.uHalfPlaneCount) {
    return /** @type {HalfPlaneUniforms} */ (/** @type {unknown} */ (shader.uniforms));
  }
  return patchedUniforms.get(material) ?? null;
}

/** Scratch for a plane on its way into world space. */
const plane = new THREE.Plane();

/**
 * Write a piece's half-planes, given in the panel's frame, into a
 * material's uniforms, in world space through `panelToWorld`.
 *
 * @param {HalfPlaneUniforms} uniforms
 * @param {readonly THREE.Plane[]} planes
 * @param {readonly number[]} sides
 * @param {THREE.Matrix4} panelToWorld
 */
export function writeHalfPlanes(uniforms, planes, sides, panelToWorld) {
  const count = Math.min(planes.length, MAX_HALF_PLANES);
  for (let i = 0; i < count; i += 1) {
    plane.copy(planes[i]).applyMatrix4(panelToWorld);
    uniforms.uHalfPlanes.value[i].set(
      plane.normal.x,
      plane.normal.y,
      plane.normal.z,
      plane.constant,
    );
    uniforms.uHalfPlaneSides.value[i] = sides[i];
  }
  uniforms.uHalfPlaneCount.value = count;
}

/**
 * Stop a material cutting anything.
 *
 * @param {HalfPlaneUniforms} uniforms
 */
export function clearHalfPlanes(uniforms) {
  uniforms.uHalfPlaneCount.value = 0;
}
