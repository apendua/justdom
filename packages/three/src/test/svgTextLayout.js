import { resetMeasuringRangeForTests } from "../elements/mirror.js";

/**
 * The layout jsdom does not do for an SVG `<text>`, shared by the tests that
 * draw one.
 */

/** The font size, in user units, of a `<text>` that sets none. */
const FONT_SIZE = 4;

/**
 * jsdom lays nothing out, so text is laid out here: each run starts at its
 * parent's `x` and sits on its `y` as a baseline, every character half an em
 * wide, the line three quarters of an em above the baseline and a quarter
 * below, and a percentage `x` is of the measuring `<svg>`'s `viewBox`. The em
 * is the `<text>`'s `font-size`, 4 units where it sets none, which makes a
 * character 2 units wide and the line 4 tall. The measuring `<svg>` reports
 * itself at (1000, 500), as an off-screen one would, so a run is read relative
 * to it, in CSS pixels: its `width` over its `viewBox`'s per unit, or one
 * without a `viewBox`. As a browser does, the line's ascent and descent are
 * rounded to whole pixels at that size. Every range read also records the
 * `transform` of the `<text>` it measured in, and every range made is kept with
 * the node it points into now.
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
          // Without a `viewBox`, a unit is a pixel.
          const width = Number(host.getAttribute("width") ?? 300);
          const viewBoxWidth = Number(host.getAttribute("viewBox")?.split(" ")[2] ?? width);
          const scale = width / viewBoxWidth;
          const em =
            Number.parseFloat(text.style.getPropertyValue("font-size")) ||
            Number.parseFloat(text.getAttribute("font-size") ?? "") ||
            FONT_SIZE;
          const raw = parent.getAttribute("x") ?? text.getAttribute("x") ?? "0";
          // A percentage of the viewport, as a browser would.
          const x = raw.endsWith("%") ? (Number.parseFloat(raw) / 100) * viewBoxWidth : Number(raw);
          const y = Number(parent.getAttribute("y") ?? text.getAttribute("y") ?? 0);
          const ascent = Math.round(em * 0.75 * scale);
          const descent = Math.round(em * 0.25 * scale);
          const left = 1000 + (x + start * em * 0.5) * scale;
          const right = 1000 + (x + end * em * 0.5) * scale;
          return {
            left,
            top: 500 + y * scale - ascent,
            right,
            bottom: 500 + y * scale + descent,
            width: right - left,
            height: ascent + descent,
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
