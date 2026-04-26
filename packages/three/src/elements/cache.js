import { addDependency, Derived, NoValueError } from "@apendua.dev/signal";
import { filter, Subject } from "rxjs";

/**
 * @typedef {"attributes" | "childList" | "fontLoaded" | "characterData"} MutationType
 */

/** @type {WeakMap<WeakKey, Subject<Set<MutationType>>>} */
const subjects = new WeakMap();

/**
 * @param {WeakKey} node
 * @param {Subject<Set<MutationType>>} subject
 * @returns {void}
 */
export function setSubject(node, subject) {
  subjects.set(node, subject);
}

/** @type {WeakMap<Element | Text, Map<string | null, Derived<CSSStyleDeclaration>>>} */
let computedStyleCache = new WeakMap();

/**
 * @param {Element | Text} element
 * @param {string | null} [pseudoElement]
 * @returns {CSSStyleDeclaration}
 */
export function getComputedStyleCached(element, pseudoElement = null) {
  let signalMap = computedStyleCache.get(element);
  if (!signalMap) {
    signalMap = new Map();
    computedStyleCache.set(element, signalMap);
  }
  let signal = signalMap.get(pseudoElement);
  if (!signal) {
    const dependency = subjects
      .get(element)
      ?.pipe(
        filter(
          (mutations) =>
            mutations.has("childList") ||
            mutations.has("attributes") ||
            mutations.has("fontLoaded"),
        ),
      );
    signal = new Derived(() => {
      if (dependency) {
        addDependency(dependency);
      }
      if (element instanceof Text) {
        if (!element.parentElement) {
          throw new NoValueError("Text node has no parent element");
        }
        return window.getComputedStyle(element.parentElement, pseudoElement);
      }
      return window.getComputedStyle(element, pseudoElement);
    });
    signalMap.set(pseudoElement, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element, Derived<DOMRect>>} */
let boundingClientRectCache = new WeakMap();

/**
 * @param {Element} element
 * @returns {DOMRect}
 */
export function getBoundingClientRectCached(element) {
  let signal = boundingClientRectCache.get(element);
  if (!signal) {
    const dependency = subjects
      .get(element)
      ?.pipe(
        filter(
          (mutations) =>
            mutations.has("childList") ||
            mutations.has("characterData") ||
            mutations.has("fontLoaded"),
        ),
      );
    signal = new Derived(() => {
      if (dependency) {
        addDependency(dependency);
      }
      return element.getBoundingClientRect();
    });
    boundingClientRectCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Text, Derived<[DOMRect, DOMRectList]>>} */
let clientRectCache = new WeakMap();

/**
 * @param {Text} text
 * @returns {[DOMRect, DOMRectList]}
 */
export function getTextClientRects(text) {
  let signal = clientRectCache.get(text);
  if (!signal) {
    const dependency = subjects
      .get(text)
      ?.pipe(
        filter(
          (mutations) =>
            mutations.has("childList") ||
            mutations.has("characterData") ||
            mutations.has("fontLoaded"),
        ),
      );
    signal = new Derived(() => {
      if (dependency) {
        addDependency(dependency);
      }
      const textRange = document.createRange();
      textRange.selectNodeContents(text);
      return [textRange.getBoundingClientRect(), textRange.getClientRects()];
    });
    clientRectCache.set(text, signal);
  }
  return signal.get();
}

/** @type {WeakMap<WeakKey, Derived<string>>} */
const textContentCache = new WeakMap();

/**
 * @param {Text} text
 * @returns {string}
 */
export function getTextContent(text) {
  let signal = textContentCache.get(text);
  if (!signal) {
    const dependency = subjects
      .get(text)
      ?.pipe(filter((mutations) => mutations.has("characterData")));
    signal = new Derived(() => {
      if (dependency) {
        addDependency(dependency);
      }
      return text.textContent || "";
    });
    textContentCache.set(text, signal);
  }
  return signal.get();
}

/** @type {WeakMap<WeakKey, Derived<Element | null>>} */
const parentElementCache = new WeakMap();

/**
 * @param {Node} node
 * @returns {Element | null}
 */
export function getParentElement(node) {
  let signal = parentElementCache.get(node);
  if (!signal) {
    const dependency = subjects.get(node)?.pipe(filter((mutations) => mutations.has("childList")));
    signal = new Derived(() => {
      if (dependency) {
        addDependency(dependency);
      }
      return node.parentElement;
    });
    parentElementCache.set(node, signal);
  }
  return signal.get();
}
