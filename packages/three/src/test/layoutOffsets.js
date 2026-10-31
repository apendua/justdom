/**
 * Layout offsets that agree with the rects a test gives its boxes.
 * Importing this installs them on jsdom's `window`.
 *
 * A box on a transformed chain is measured off its layout offsets, which
 * jsdom leaves at 0. A test's rects (`clientRect.js`) are untransformed and
 * in page coordinates, so they serve as the offsets, against no offset
 * parent.
 */

for (const [name, read] of /** @type {const} */ ([
  ["offsetWidth", (/** @type {DOMRect} */ rect) => rect.width],
  ["offsetHeight", (/** @type {DOMRect} */ rect) => rect.height],
  ["offsetLeft", (/** @type {DOMRect} */ rect) => rect.left],
  ["offsetTop", (/** @type {DOMRect} */ rect) => rect.top],
])) {
  Object.defineProperty(window.HTMLElement.prototype, name, {
    configurable: true,
    get() {
      return read(this.getBoundingClientRect());
    },
  });
}
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get: () => null,
});
