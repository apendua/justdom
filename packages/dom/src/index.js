export { $, $$, children, list } from "./dom.js";
export { stylesheet } from "./stylesheet.js";
export { render, text, textNode } from "./text.js";
export { on, set, attr, data, style } from "./operators.js";

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
