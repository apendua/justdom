/**
 * A client rect at a place on the page, which jsdom does not lay out: what
 * a test hands back from a stubbed `getBoundingClientRect`.
 *
 * @param {number} left
 * @param {number} top
 * @param {number} width
 * @param {number} height
 * @returns {DOMRect}
 */
export function clientRect(left, top, width, height) {
  return /** @type {DOMRect} */ ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  });
}
