export {
  object,
  mesh,
  lineSegments,
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
  positionalAudio,
} from "./entities.js";
export {
  on,
  add,
  set,
  copy,
  effect,
  just,
  disposable,
  toComponent,
  Nothing,
  $,
} from "./operators.js";
export { collection, addDynamic } from "./core.js";
export { render, animate, size, camera, session } from "./render.js";
export { stopPropagation, interactive, resetMatrix } from "./interactions.js";

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
