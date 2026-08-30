import { each, effectMap, effects, observable, set, on } from "@apendua/signal";

/**
 * @import { EntityEffect, Subscribable } from '@apendua/signal';
 * @import { WritableProps, Primitive } from './core.js';
 */

export { set, on };

/**
 * @typedef {object} ObjectWithAttributes
 * @property {(key: string, value: string) => void} setAttribute
 * @property {(key: string) => void} removeAttribute
 */

/**
 * @template {ObjectWithAttributes} TEntity
 * @overload
 * @param {string} key
 * @param {Subscribable<Primitive> | (() => Primitive)} value
 * @returns {EntityEffect<TEntity>}
 */

/**
 * @template {ObjectWithAttributes} TEntity
 * @overload
 * @param {Record<string, Primitive>} values
 * @returns {EntityEffect<TEntity>}
 */

/**
 * @template {ObjectWithAttributes} TEntity
 * @param {string|Record<string, Primitive>} keyOrValues
 * @param {Subscribable<Primitive> | (() => Primitive)} [value]
 * @returns {EntityEffect<TEntity>}
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
  const source = value;
  return effectMap((entity) =>
    each(source, (v) => {
      if (v === undefined) {
        entity.removeAttribute(keyOrValues);
      } else {
        entity.setAttribute(keyOrValues, v === null ? "null" : v.toString());
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
 * @param {Subscribable<Primitive>} value
 * @returns {EntityEffect<TEntity>}
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
 * @param {Subscribable<CSSStyleDeclaration[K]> | (() => CSSStyleDeclaration[K])} value
 * @returns {EntityEffect<TEntity>}
 */

/**
 * @template {ObjectWithStyle} TEntity
 * @overload
 * @param {CustomProperty} key
 * @param {Subscribable<Primitive> | (() => Primitive)} value
 * @returns {EntityEffect<TEntity>}
 */

/**
 * @template {ObjectWithStyle} TEntity
 * @overload
 * @param {StyleValues} values
 * @returns {EntityEffect<TEntity>}
 */

/**
 * @template {ObjectWithStyle} TEntity
 * @template {keyof WritableProps<CSSStyleDeclaration>} K
 * @param {K|CustomProperty|StyleValues} keyOrValues
 * @param {Subscribable<any> | (() => any)} [value]
 * @returns {EntityEffect<TEntity>}
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
  const source = value;
  return effectMap((entity) =>
    each(source, (v) => {
      // `keyof CSSStyleDeclaration` includes its numeric index signature.
      applyStyle(entity.style, String(keyOrValues), v);
    }),
  );
}
