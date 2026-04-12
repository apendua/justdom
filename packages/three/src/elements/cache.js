import { addDependency, Derived } from "@apendua.dev/signal";
import { Subject } from "rxjs";

/** @type {WeakMap<Node, Subject<unknown>>} */
const subjects = new WeakMap();

/**
 * @param {Node} node
 * @param {Subject<unknown>} subject
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
    signal = new Derived(() => {
      const subject = subjects.get(element);
      if (subject) {
        addDependency(subject);
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
    signal = new Derived(() => {
      const subject = subjects.get(element);
      if (subject) {
        addDependency(subject);
      }
      return element.getBoundingClientRect();
    });
    boundingClientRectCache.set(element, signal);
  }
  return signal.get();
}
