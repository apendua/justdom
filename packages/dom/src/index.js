/**
 * @typedef {import('./context.js').Context} Context
 */

export { svg, SVGBuilder } from "./svg.js";
export { html, HTMLBuilder } from "./html.js";
export { list, fragment, textNode, css, text, string } from "./core.js";
export { createProperty } from "./context.js";

/**
 * @template {object} T
 * @typedef {import('./core.js').WritableProps<T>} WritableProps
 */

/**
 * @typedef {import('./core.js').Primitive} Primitive
 */
