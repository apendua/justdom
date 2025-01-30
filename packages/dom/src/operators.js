import { Observable, switchMap, tap } from "rxjs";
import { effect, fragment } from "./core.js";

/**
 * @import { WritableProps, EventListener, Primitive } from './core.js';
 */

/**
 * @template {HTMLElement} TElement1
 * @template {keyof HTMLElementEventMap} T
 * @overload
 * @param {T} type
 * @param {(e: HTMLElementEventMap[T]) => void} handler
 * @returns {(source: Observable<TElement1>) => Observable<TElement1>}
 */

/**
 * @template {SVGElement} TElement2
 * @template {keyof SVGElementEventMap} T
 * @overload
 * @param {T} type
 * @param {(e: SVGElementEventMap[T]) => void} handler
 * @returns {(source: Observable<TElement2>) => Observable<TElement2>}
 */

/**
 * @template {EventListener<Record<string, unknown>>} TElement3
 * @param {string} type
 * @param {(e: unknown) => void} handler
 * @returns {(source: Observable<TElement3>) => Observable<TElement3>}
 */
export function on(type, handler) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          entity.addEventListener(type, handler);
          subscriber.next(entity);
          return () => {
            entity.removeEventListener(type, handler);
          };
        });
      }),
    );
  };
}

/**
 * @template T
 * @param {Observable<T>} value
 * @param {(value: T) => void} fn
 * @returns {Observable<T>}
 */
function each(value, fn) {
  return value.pipe(tap(fn));
}

/**
 * @template {object} TEntity
 * @template {keyof WritableProps<TEntity>} K
 * @param {K} key
 * @param {Observable<TEntity[K]>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}   *
 */
export function set(key, value) {
  return effect((entity) => each(value, (v) => (entity[key] = v)));
}

/**
 * @typedef {object} ObjectWithAttributes
 * @property {(key: string, value: string) => void} setAttribute
 * @property {(key: string) => void} removeAttribute
 */

/**
 * @template {ObjectWithAttributes} TEntity
 * @template {string} K
 * @param {K} key
 * @param {Observable<Primitive>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function setAttribute(key, value) {
  return effect((entity) =>
    each(value, (v) => {
      if (v === undefined) {
        entity.removeAttribute(key);
      } else {
        entity.setAttribute(key, v === null ? "null" : v.toString());
      }
    }),
  );
}

/**
 * @typedef {object} ObjectWithData
 * @property {DOMStringMap} dataset
 */

/**
 * @template {ObjectWithData} TEntity
 * @param {string} key
 * @param {Observable<Primitive>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function data(key, value) {
  return effect((entity) =>
    each(value, (v) => {
      if (v === undefined) {
        delete entity.dataset[key];
      } else {
        // We are trying to mimic the behavior of the dataset property
        // See: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/dataset#setting_values
        entity.dataset[key] = v === null ? "null" : v.toString();
      }
    }),
  );
}

/**
 * @typedef {object} ObjectWithStyle
 * @property {CSSStyleDeclaration} style
 */

/**
 * @template {ObjectWithStyle} TEntity
 * @template {keyof WritableProps<CSSStyleDeclaration>} K
 * @param {K} key
 * @param {Observable<CSSStyleDeclaration[K]>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function style(key, value) {
  return effect((entity) => each(value, (v) => (entity.style[key] = v)));
}

/**
 * @template {Element} TElement
 * @param {Observable<Node | null>[]} children
 * @returns {(source: Observable<TElement>) => Observable<TElement>}
 */
export function append(...children) {
  return effect((entity) =>
    each(fragment(...children), (node) => entity.appendChild(node)),
  );
}
