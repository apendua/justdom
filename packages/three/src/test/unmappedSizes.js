/**
 * Make `window.getComputedStyle` answer as Chromium 152 does for a `<use>`
 * and an `<svg>`: their `width` and `height` attributes are not mapped to
 * CSS, so the computed value is `auto` unless a stylesheet sets one. jsdom
 * maps no SVG attribute at all and computes an empty string, which sends
 * every read to the attribute and so hides what a browser that says `auto`
 * does to the drawing.
 *
 * Only the element's inline `style` counts as a stylesheet here. Call the
 * returned function to put the original back.
 *
 * @returns {() => void}
 */
export function leaveSizesUnmapped() {
  const original = window.getComputedStyle;
  window.getComputedStyle = (element, pseudoElement) => {
    const style = original.call(window, element, pseudoElement);
    if (element.localName !== "use" && element.localName !== "svg") {
      return style;
    }
    const inline = /** @type {ElementCSSInlineStyle} */ (/** @type {unknown} */ (element)).style;
    return new Proxy(style, {
      get(target, key) {
        if (key === "getPropertyValue") {
          return (/** @type {string} */ name) =>
            (name === "width" || name === "height") && !inline.getPropertyValue(name)
              ? "auto"
              : target.getPropertyValue(name);
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return () => {
    window.getComputedStyle = original;
  };
}
