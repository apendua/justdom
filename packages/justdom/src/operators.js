import { tap } from "rxjs";
import { effectMap, effects, observable, set, on } from "@apendua/signal";

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
 * @overload
 * @param {string} key
 * @param {Observable<Primitive> | (() => Primitive)} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */

/**
 * @template {ObjectWithAttributes} TEntity
 * @overload
 * @param {Record<string, Primitive>} values
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */

/**
 * @template {ObjectWithAttributes} TEntity
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
 * @typedef {`--${string}`} CustomProperty
 */

/**
 * @typedef {Partial<WritableProps<CSSStyleDeclaration>> &
 *   Partial<Record<CustomProperty, Primitive>>} StyleValues
 */

/**
 * Applies a single style declaration.
 *
 * Custom properties are not exposed as named properties of
 * `CSSStyleDeclaration`, so `style["--x"] = value` is silently dropped and
 * `setProperty` is the only way to set one. Regular properties keep going
 * through plain assignment so that the values `CSSStyleDeclaration` accepts
 * are unchanged.
 *
 * @param {CSSStyleDeclaration} style
 * @param {string} key
 * @param {unknown} value
 * @returns {void}
 */
function applyStyle(style, key, value) {
  if (!key.startsWith("--")) {
    // @ts-expect-error -- indexed write, checked by the overloads above.
    style[key] = value;
    return;
  }
  if (value === undefined || value === null) {
    style.removeProperty(key);
  } else {
    style.setProperty(key, `${value}`);
  }
}

/**
 * @template {ObjectWithStyle} TEntity
 * @template {keyof WritableProps<CSSStyleDeclaration>} K
 * @overload
 * @param {K} key
 * @param {Observable<CSSStyleDeclaration[K]> | (() => CSSStyleDeclaration[K])} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */

/**
 * @template {ObjectWithStyle} TEntity
 * @overload
 * @param {CustomProperty} key
 * @param {Observable<Primitive> | (() => Primitive)} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */

/**
 * @template {ObjectWithStyle} TEntity
 * @overload
 * @param {StyleValues} values
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */

/**
 * @template {ObjectWithStyle} TEntity
 * @template {keyof WritableProps<CSSStyleDeclaration>} K
 * @param {K|CustomProperty|StyleValues} keyOrValues
 * @param {Observable<any> | (() => any)} [value]
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function style(keyOrValues, value) {
  if (typeof keyOrValues === "object") {
    return effects((entity) => {
      for (const [key, val] of Object.entries(keyOrValues)) {
        applyStyle(entity.style, key, val);
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
        // `keyof CSSStyleDeclaration` includes its numeric index signature.
        applyStyle(entity.style, String(keyOrValues), v);
      }),
    );
  });
}
