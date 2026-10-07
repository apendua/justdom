import { resetMeasuringRangeForTests } from "../elements/mirror.js";

// The text helpers resolve colours through a bare `getComputedStyle`, which
// jsdom-env installs on `window` and not on the global, so a test that draws
// a run needs it there too.
if (typeof globalThis.getComputedStyle === "undefined") {
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
}

/**
 * jsdom lays nothing out, and a run is measured through a range: every
 * character 10px wide on a single 16px line is enough to rasterize one.
 *
 * @returns {() => void} Puts the real range back.
 */
export function installRange() {
  const original = document.createRange;
  resetMeasuringRangeForTests();
  document.createRange = () => {
    let start = 0;
    let end = 0;
    const rect = () =>
      /** @type {DOMRect} */ ({
        left: start * 10,
        top: 0,
        right: end * 10,
        bottom: 16,
        width: (end - start) * 10,
        height: 16,
      });
    return /** @type {Range} */ (
      /** @type {unknown} */ ({
        selectNodeContents: (/** @type {Node} */ node) => {
          start = 0;
          end = (node.textContent || "").length;
        },
        setStart: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
          start = offset;
        },
        setEnd: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
          end = offset;
        },
        getBoundingClientRect: rect,
        getClientRects: () => /** @type {DOMRectList} */ (/** @type {unknown} */ ([rect()])),
      })
    );
  };
  return () => {
    document.createRange = original;
    resetMeasuringRangeForTests();
  };
}
