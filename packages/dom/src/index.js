export { svg } from "./svg.js";
export { html } from "./html.js";
export { list, fragment, textNode, css, text, string } from "./core.js";
export {
  on,
  set,
  attr,
  data,
  style,
  append,
  effect,
  just,
  sharedResource,
} from "./operators.js";

/**
 * @template {object} T
 * @typedef {import('./core.js').WritableProps<T>} WritableProps
 */

/**
 * @typedef {import('./core.js').Primitive} Primitive
 */

/**
 * @typedef {import('./operators.js').ObjectWithAttributes} ObjectWithAttributes
 */

/**
 * @typedef {import('./operators.js').ObjectWithData} ObjectWithData
 */

/**
 * @typedef {import('./operators.js').ObjectWithStyle} ObjectWithStyle
 */
