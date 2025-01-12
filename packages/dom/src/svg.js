import { Observable } from "rxjs";
import { subscribeChildren, watchAll } from "./core.js";

/**
 * @import { WritableProps, Primitive } from './core.js';
 */

/**
 * @typedef {{
 *   [E in keyof SVGElementEventMap]?: (e: SVGElementEventMap[E]) => void;
 * }} EventHandlers
 */

/**
 * @typedef {WritableProps<CSSStyleDeclaration>} Style
 */

/**
 * @template {keyof SVGElementTagNameMap} Tag
 */
export class SVGBuilder {
  /**
   * @typedef {SVGElementTagNameMap[Tag]} Element
   */
  /** @type {Tag} */
  #tag;
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  #properties;
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  #attributes;
  /** @type {EventHandlers} */
  #handlers;
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  #data;
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  #style;
  /** @type {Array<Observable<Node>>} */
  #children;
  /** @type {Array<(e: Element) => Observable<void>>} */
  #effects;
  /** @type {Array<(e: Element) => void>} */
  #initializers;

  /**
   * @param {Tag} tag
   */
  constructor(tag) {
    this.#tag = tag;
    this.#properties = {};
    this.#attributes = {};
    this.#handlers = {};
    this.#data = {};
    this.#style = {};
    this.#children = [];
    this.#effects = [];
    this.#initializers = [];
  }

  /**
   * @returns {Observable<SVGElementTagNameMap[Tag]>}
   */
  get() {
    return new Observable((subscriber) => {
      const element = document.createElementNS(
        "http://www.w3.org/2000/svg",
        this.#tag,
      );
      for (const fn of this.#initializers) {
        fn(element);
      }
      watchAll(subscriber, this.#properties, (key, value) => {
        /** @type {any} */ (element)[key] = value;
      });
      watchAll(subscriber, this.#attributes, (key, value) => {
        if (value !== undefined && value !== null) {
          element.setAttribute(key, value.toString());
        } else {
          element.removeAttribute(key);
        }
      });
      watchAll(subscriber, this.#data, (key, value) => {
        if (value !== undefined && value !== null) {
          element.dataset[key] = value.toString();
        } else {
          delete element.dataset[key];
        }
      });
      watchAll(subscriber, this.#style, (key, value) => {
        /** @type {any} */ (element.style)[key] = value;
      });
      for (const [key, value] of Object.entries(this.#handlers)) {
        subscriber.add(
          new Observable(() => {
            element.addEventListener(
              key,
              /** @type {(event: Event) => void} */ (value),
            );
            return () => {
              element.removeEventListener(
                key,
                /** @type {(event: Event) => void} */ (value),
              );
            };
          }).subscribe(),
        );
      }
      for (const fn of this.#effects) {
        subscriber.add(fn(element).subscribe());
      }
      if (this.#children.length > 0) {
        const fragment = document.createDocumentFragment();
        subscribeChildren(subscriber, fragment, this.#children);
        element.appendChild(fragment);
      }
      subscriber.next(element);
    });
  }

  /**
   * @param {(element: Element) => void} fn
   * @returns
   */
  init(fn) {
    this.#initializers.push(fn);
    return this;
  }

  /**
   * @param {(element: Element) => Observable<void>} fn
   * @returns
   */
  effect(fn) {
    this.#effects.push(fn);
    return this;
  }

  /**
   * @template {keyof WritableProps<SVGElementTagNameMap[Tag]>} K
   * @param {K} key
   * @param {Observable<WritableProps<SVGElementTagNameMap[Tag]>[K]>} value
   * @returns {this}
   */
  set(key, value) {
    this.#properties[key] = value;
    return this;
  }

  /**
   * @param {string} key
   * @param {Observable<Primitive>} value
   * @returns {this}
   */
  setAttribute(key, value) {
    this.#attributes[key] = value;
    return this;
  }

  /**
   * @param {string} key
   * @param {Observable<Primitive>} value
   * @returns {this}
   */
  data(key, value) {
    this.#data[key] = value;
    return this;
  }

  /**
   * @template {keyof Style} K
   * @param {K} key
   * @param {Observable<Style[K]>} value
   * @returns {this}
   */
  style(key, value) {
    this.#style[key] = value;
    return this;
  }

  /**
   * @template {keyof EventHandlers} K
   * @param {K} key
   * @param {EventHandlers[K]} value
   * @returns {this}
   */
  on(key, value) {
    this.#handlers[key] = value;
    return this;
  }

  /**
   * @param {Observable<Node>[]} nodes
   * @returns {this}
   */
  append(...nodes) {
    this.#children.push(...nodes);
    return this;
  }
}

/**
 * @template {keyof SVGElementTagNameMap} Tag
 * @param {Tag} tag
 */
export function svg(tag) {
  return new SVGBuilder(tag);
}
