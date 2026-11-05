/**
 * jsdom keeps each element's computed style until the DOM changes, and a
 * rule rewritten through the CSSOM is no DOM change. A browser has no such
 * cache to clear.
 *
 * @returns {void}
 */
export function forgetComputedStyles() {
  document.body.appendChild(document.createComment("")).remove();
}
