import { resetMeasuringRangeForTests } from "../elements/mirror/textLayout.js";

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

/**
 * A range that lays a `pre` text out in lines: every character 100 px wide
 * and 20 tall, and a new line after each "\n". Ten characters make a line
 * of 20 000 square px, which is more than one band may cover.
 *
 * @returns {() => void} Puts the real range back.
 */
export function installLines() {
  const original = document.createRange;
  const restore = installRange();
  document.createRange = () => {
    let content = "";
    let start = 0;
    let end = 0;
    /** The line and the column of the character at `index`. */
    const at = (/** @type {number} */ index) => {
      const before = content.slice(0, index).split("\n");
      return { line: before.length - 1, column: before[before.length - 1].length };
    };
    /** One rectangle for each line the range touches. */
    const rects = () => {
      /** @type {DOMRect[]} */
      const found = [];
      let index = start;
      while (index < end) {
        const { line, column } = at(index);
        const newline = content.indexOf("\n", index);
        const until = Math.min(end, newline < 0 ? content.length : newline);
        if (until > index) {
          found.push(
            /** @type {DOMRect} */ ({
              left: column * 100,
              top: line * 20,
              right: (column + until - index) * 100,
              bottom: line * 20 + 20,
              width: (until - index) * 100,
              height: 20,
            }),
          );
        }
        index = until + 1;
      }
      return found;
    };
    return /** @type {Range} */ (
      /** @type {unknown} */ ({
        selectNodeContents: (/** @type {Node} */ node) => {
          content = node.textContent || "";
          start = 0;
          end = content.length;
        },
        setStart: (/** @type {Node} */ node, /** @type {number} */ offset) => {
          content = node.textContent || "";
          start = offset;
        },
        setEnd: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
          end = offset;
        },
        getBoundingClientRect: () => {
          const all = rects();
          const left = Math.min(...all.map((rect) => rect.left), Infinity);
          const top = Math.min(...all.map((rect) => rect.top), Infinity);
          const right = Math.max(...all.map((rect) => rect.right), -Infinity);
          const bottom = Math.max(...all.map((rect) => rect.bottom), -Infinity);
          return /** @type {DOMRect} */ (
            all.length
              ? { left, top, right, bottom, width: right - left, height: bottom - top }
              : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
          );
        },
        getClientRects: () => /** @type {DOMRectList} */ (/** @type {unknown} */ (rects())),
      })
    );
  };
  return () => {
    document.createRange = original;
    restore();
  };
}
