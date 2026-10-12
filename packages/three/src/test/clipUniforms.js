import * as THREE from "three";

/**
 * @import { Mesh } from "three";
 */

/**
 * The clip patch's uniforms, read the way three reads them: by letting the
 * material patch a shader.
 *
 * @param {Mesh} mesh
 * @returns {Record<string, { value: unknown }>}
 */
export function clipUniformsOf(mesh) {
  const shader = {
    uniforms: /** @type {Record<string, { value: unknown }>} */ ({}),
    vertexShader: "void main() {\n#include <begin_vertex>\n}",
    fragmentShader: "void main() {\n#include <alphatest_fragment>\n}",
  };
  /** @type {THREE.Material} */ (mesh.material).onBeforeCompile(
    /** @type {never} */ (shader),
    /** @type {never} */ (null),
  );
  return shader.uniforms;
}

/**
 * The clip patch's `clipMatrix`: the matrix from the mesh's vertices to the
 * root's frame, where the clip box is and where the browser draws.
 *
 * @param {Mesh} mesh
 * @returns {THREE.Matrix3}
 */
export function clipMatrixOf(mesh) {
  return /** @type {THREE.Matrix3} */ (clipUniformsOf(mesh).clipMatrix.value);
}
