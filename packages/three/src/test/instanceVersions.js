import * as THREE from "three";

/**
 * How many times each of a batch's instance buffers has been marked for
 * upload, keyed by the bucket's index among the container's children and the
 * buffer's name: the bucket's `instanceMatrix` and every instanced attribute
 * on its geometry.
 *
 * @param {THREE.Object3D} container
 * @returns {Record<string, number>}
 */
export function instanceVersions(container) {
  /** @type {Record<string, number>} */
  const versions = {};
  for (const [index, child] of container.children.entries()) {
    if (!(child instanceof THREE.InstancedMesh)) {
      continue;
    }
    versions[`${index}:instanceMatrix`] = child.instanceMatrix.version;
    for (const [name, attribute] of Object.entries(child.geometry.attributes)) {
      if (attribute instanceof THREE.InstancedBufferAttribute) {
        versions[`${index}:${name}`] = attribute.version;
      }
    }
  }
  return versions;
}
