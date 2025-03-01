export {
  object,
  mesh,
  group,
  skinnedMesh,
  scene,
  perspectiveCamera,
  orthographicCamera,
  directionalLight,
  ambientLight,
  pointLight,
  spotLight,
  hemisphereLight,
  rectAreaLight,
  lightProbe,
} from "./entities.js";
export {
  on,
  add,
  set,
  copy,
  effect,
  just,
  sharedResource,
} from "./operators.js";
export { collection } from "./core.js";
export { render, animate, size } from "./render.js";
export { stopPropagation, interactive } from "./interactions.js";

/**
 * @template {object} T
 * @typedef {import('./core.js').WritableProps<T>} WritableProps
 */

/**
 * @template {object} T
 * @typedef {import('./core.js').CopyableProps<T>} CopyableProps
 */

/**
 * @typedef {import('./core.js').XREventMap} XREventMap
 */
