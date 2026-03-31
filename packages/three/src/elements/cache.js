/** @type {WeakMap<Element, CSSStyleDeclaration>} */
let computedStyleCache = new WeakMap();

/**
 * @param {Element} element
 * @returns {CSSStyleDeclaration}
 */
export function getComputedStyleCached(element) {
  let style = computedStyleCache.get(element);
  if (!style) {
    style = getComputedStyle(element);
    computedStyleCache.set(element, style);
  }
  return style;
}

/** @type {WeakMap<Element, DOMRect>} */
let boundingClientRectCache = new WeakMap();

/**
 * @param {Element} element
 * @returns {DOMRect}
 */
export function getBoundingClientRectCached(element) {
  let rect = boundingClientRectCache.get(element);
  if (!rect) {
    rect = element.getBoundingClientRect();
    boundingClientRectCache.set(element, rect);
  }
  return rect;
}

export function clearCache() {
  computedStyleCache = new WeakMap();
  boundingClientRectCache = new WeakMap();
}
