import { tap } from "rxjs";
import { effectMap, effects, observable, set, on } from "@apendua.dev/reactive";

/**
 * @import { Observable } from 'rxjs';
 * @import { WritableProps, Primitive } from './core.js';
 */

export { set, on };

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
 * @typedef {object} ObjectWithAttributes
 * @property {(key: string, value: string) => void} setAttribute
 * @property {(key: string) => void} removeAttribute
 */

/**
 * @template {ObjectWithAttributes} TEntity
 *
 * @overload
 * @param {string} key
 * @param {Observable<Primitive> | (() => Primitive)} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 *
 * @overload
 * @param {Record<string, Primitive>} values
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 *
 * @param {string|Record<string, Primitive>} keyOrValues
 * @param {Observable<Primitive> | (() => Primitive)} [value]
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function attr(keyOrValues, value) {
  if (typeof keyOrValues === "object") {
    return effects((entity) => {
      for (const [key, val] of Object.entries(keyOrValues)) {
        if (val === undefined) {
          entity.removeAttribute(key);
        } else {
          entity.setAttribute(key, val === null ? "null" : val.toString());
        }
      }
    });
  }
  if (!value) {
    throw new Error("Value observable is required when key is provided.");
  }
  if (typeof value === "function") {
    value = observable(value);
  }
  return effectMap((entity) => {
    return value.pipe(
      tap((v) => {
        if (v === undefined) {
          entity.removeAttribute(keyOrValues);
        } else {
          entity.setAttribute(keyOrValues, v === null ? "null" : v.toString());
        }
      }),
    );
  });
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
  return effectMap((entity) =>
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
 *
 * @overload
 * @param {K} key
 * @param {Observable<CSSStyleDeclaration[K]> | (() => CSSStyleDeclaration[K])} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 *
 * @overload
 * @param {Partial<WritableProps<CSSStyleDeclaration>>} values
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 *
 * @param {K|Partial<WritableProps<CSSStyleDeclaration>>} keyOrValues
 * @param {Observable<CSSStyleDeclaration[K]> | (() => CSSStyleDeclaration[K])} [value]
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function style(keyOrValues, value) {
  if (typeof keyOrValues === "object") {
    return effects((entity) => {
      Object.assign(entity.style, keyOrValues);
    });
  }
  if (!value) {
    throw new Error("Value observable is required when key is provided.");
  }
  if (typeof value === "function") {
    value = observable(value);
  }
  return effectMap((entity) => {
    return value.pipe(
      tap((v) => {
        entity.style[keyOrValues] = v;
      }),
    );
  });
}
