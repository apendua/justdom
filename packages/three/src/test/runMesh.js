import * as THREE from "three";

/**
 * Whether an object is the mesh of a rasterized run: a field's value, a
 * list marker or a text node, whose material carries the run's texture as
 * a mask or a map.
 *
 * @param {THREE.Object3D} object
 * @returns {object is THREE.Mesh}
 */
export function isRunMesh(object) {
  if (!(object instanceof THREE.Mesh)) {
    return false;
  }
  const material = /** @type {THREE.MeshBasicMaterial} */ (object.material);
  return !!(material && (material.alphaMap || material.map));
}
