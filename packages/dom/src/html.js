import { Observable } from "rxjs";
import { subscribeChildren, watchAll } from "./core.js";

/**
 * @import { WritableProps, Primitive } from './core.js';
 */

/**
 * @typedef {{
 *   [E in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[E]) => void;
 * }} EventHandlers
 */

/**
 * @typedef {WritableProps<CSSStyleDeclaration>} Style
 */

/**
 * @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 */
export function html(tag) {
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  const properties = {};
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  const attributes = {};
  /** @type {EventHandlers} */
  const handlers = {};
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  const data = {};
  /** @type {Record<PropertyKey, Observable<unknown>>} */
  const style = {};
  /** @type {Array<Observable<Node>>} */
  const children = [];
  const builder = {
    get: () => {
      return new Observable((subscriber) => {
        const element = document.createElement(tag);
        watchAll(subscriber, properties, (key, value) => {
          /** @type {any} */ (element)[key] = value;
        });
        watchAll(subscriber, attributes, (key, value) => {
          if (value !== undefined && value !== null) {
            element.setAttribute(key, value.toString());
          } else {
            element.removeAttribute(key);
          }
        });
        watchAll(subscriber, data, (key, value) => {
          if (value !== undefined && value !== null) {
            element.dataset[key] = value.toString();
          } else {
            delete element.dataset[key];
          }
        });
        watchAll(subscriber, style, (key, value) => {
          /** @type {any} */ (element.style)[key] = value;
        });
        for (const [key, value] of Object.entries(handlers)) {
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
        if (children && children.length > 0) {
          const fragment = document.createDocumentFragment();
          subscribeChildren(subscriber, fragment, children);
          element.appendChild(fragment);
        }
        subscriber.next(element);
      });
    },
    /**
     * @template {keyof WritableProps<HTMLElementTagNameMap[Tag]>} K
     * @param {K} key
     * @param {Observable<WritableProps<HTMLElementTagNameMap[Tag]>[K]>} value
     */
    set: (key, value) => {
      properties[key] = value;
      return builder;
    },
    /**
     * @param {string} key
     * @param {Observable<Primitive>} value
     */
    setAttribute: (key, value) => {
      attributes[key] = value;
      return builder;
    },
    /**
     * @param {string} key
     * @param {Observable<Primitive>} value
     */
    data: (key, value) => {
      data[key] = value;
      return builder;
    },
    /**
     * @template {keyof Style} K
     * @param {K} key
     * @param {Observable<Style[K]>} value
     */
    style: (key, value) => {
      style[key] = value;
      return builder;
    },
    /**
     * @template {keyof EventHandlers} K
     * @param {K} key
     * @param {EventHandlers[K]} value
     */
    on: (key, value) => {
      handlers[key] = value;
      return builder;
    },
    /**
     * @param {Observable<Node>[]} nodes
     */
    append: (...nodes) => {
      children.push(...nodes);
      return builder;
    },
  };
}
