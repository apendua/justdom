import { resetMeasuringRangeForTests } from "../elements/mirror.js";

/**
 * The layout jsdom does not do for an SVG `<text>`, shared by the tests that
 * draw one.
 */

/**
 * jsdom lays nothing out, so text is laid out here: each run starts at its
 * parent's `x` and sits on its `y` as a baseline, every character 2 units
 * wide and the line 4 tall, and a percentage `x` is of the measuring
 * `<svg>`'s width. The measuring `<svg>` reports itself at
 * (1000, 500), as an off-screen one would, so a run is read relative to it.
 * Every range read also records the `transform` of the `<text>` it measured
 * in, and every range made is kept with the node it points into now.
 *
 * @returns {{
 *   transforms: string[],
 *   ranges: { readonly container: Node | null }[],
 *   restore: () => void,
 * }}
 */
export function installSvgTextLayout() {
  /** @type {string[]} */
  const transforms = [];
  /** @type {{ readonly container: Node | null }[]} */
  const ranges = [];
  const originalRange = document.createRange;
  resetMeasuringRangeForTests();
  const originalRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    const element = /** @type {Element} */ (this);
    const host =
      element.localName === "svg" &&
      /** @type {SVGElement} */ (element).style.getPropertyValue("left") === "-99999px";
    return /** @type {DOMRect} */ (
      host
        ? { left: 1000, top: 500, right: 1000, bottom: 500, width: 0, height: 0 }
        : originalRect.call(element)
    );
  };
  document.createRange = () => {
    /** @type {Node | null} */
    let container = null;
    let start = 0;
    let end = 0;
    ranges.push({
      get container() {
        return container;
      },
    });
    return /** @type {Range} */ (
      /** @type {unknown} */ ({
        setStart: (/** @type {Node} */ node, /** @type {number} */ offset) => {
          container = node;
          start = offset;
        },
        setEnd: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
          end = offset;
        },
        getBoundingClientRect: () => {
          const parent = /** @type {Element} */ (container?.parentNode);
          const text = /** @type {SVGElement} */ (parent.closest("text"));
          transforms.push(text.style.getPropertyValue("transform"));
          const host = /** @type {Element} */ (text.parentNode);
          const raw = parent.getAttribute("x") ?? text.getAttribute("x") ?? "0";
          // A percentage of the measuring <svg>'s width, as a browser would.
          const x = raw.endsWith("%")
            ? (Number.parseFloat(raw) / 100) * Number(host.getAttribute("width"))
            : Number(raw);
          const y = Number(parent.getAttribute("y") ?? text.getAttribute("y") ?? 0);
          return {
            left: 1000 + x + start * 2,
            top: 500 + y - 3,
            right: 1000 + x + end * 2,
            bottom: 500 + y + 1,
            width: (end - start) * 2,
            height: 4,
          };
        },
      })
    );
  };
  return {
    transforms,
    ranges,
    restore() {
      document.createRange = originalRange;
      window.Element.prototype.getBoundingClientRect = originalRect;
      resetMeasuringRangeForTests();
    },
  };
}
