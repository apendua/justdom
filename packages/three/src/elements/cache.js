import { addDependency, Derived } from "@apendua.dev/signal";
import { filter, Subject } from "rxjs";

/**
 * @typedef {"attributes" | "childList" | "fontLoaded" | "characterData"} MutationType
 */

/** @type {WeakMap<Node, Subject<Set<MutationType>>>} */
const subjects = new WeakMap();

/**
 * @param {Node} node
 * @param {Subject<Set<MutationType>>} subject
 * @returns {void}
 */
export function setSubject(node, subject) {
  subjects.set(node, subject);
}

/** @type {WeakMap<Element, Map<string | null, Derived<CSSStyleDeclaration>>>} */
let computedStyleCache = new WeakMap();

/**
 * @param {Element} element
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
      return getComputedStyle(element, pseudoElement);
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
            mutations.has("fontLoaded") ||
            mutations.has("characterData"),
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
