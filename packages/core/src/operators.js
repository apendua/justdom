import { each, effects, set, on, use, useEffect } from "justdom-signal";

/** What a getter `write` has applied before its first run: nothing it can return. */
const UNAPPLIED = Symbol("unapplied");

/**
 * @import { EntityEffect, Subscribable } from 'justdom-signal';
 * @import { WritableProps, Primitive } from './core.js';
 */

export { set, on };

/**
 * Write `apply(entity, value)` whenever the value moves, for as long as the
 * entity stays mounted.
 *
 * The two shapes a value arrives in get two different answers, which is what
 * `set` in the core already does and what the operators below used to paper
 * over by turning every getter into an observable first.
 *
 * A **getter** wants one `Effect` that reads it and does the writing, and
 * keeps the last value written for an equality cutoff: a recomputation
 * landing on the value already written writes nothing. No stream anywhere,
 * and no `Derived`, which would cost a node and an edge per mounting for that
 * one comparison. What it replaced was `observable(fn)` held through an
 * operator that re-chose it every run: a `Derived`, an `Effect` to push its
 * values, a `Stream` to run the write, another `Derived` to choose that
 * stream and another `Effect` to hold it — five pieces to assign an
 * attribute.
 *
 * An **observable** is a foreign source. It has to be subscribed rather than
 * read, and it can fail — but nothing is *chosen* here, so `use` says it: one
 * dependency edge, whose failure is the mounting's, which is where the
 * failure of this write belongs.
 *
 * @template TEntity
 * @template TValue
 * @param {Subscribable<TValue> | (() => TValue)} value
 * @param {(entity: TEntity, value: TValue) => void} apply
 * @returns {EntityEffect<TEntity>}
 */
function write(value, apply) {
  if (typeof value === "function") {
    const getValue = value;
    return (entity, { fail }) => {
      // The last value applied, for an equality cutoff: a recomputation that
      // lands on the value already applied applies nothing. Held here rather
      // than in a `Derived`, which would cost a node and an edge per mounting
      // for the same comparison.
      /** @type {unknown} */
      let applied = UNAPPLIED;
      // `onError` because a getter can start throwing on a later run, and an
      // effect with nowhere to put that throws it from the scheduler's flush
      // instead — where nobody is waiting for it. `fail` is the mounting's own
      // channel, which is where the observable branch below already lands.
      // Standalone, because `fail` is already where its failures go.
      useEffect(
        () => {
          const next = getValue();
          if (!Object.is(next, applied)) {
            applied = next;
            apply(entity, next);
          }
        },
        { name: "write", onError: fail, standalone: true },
      );
    };
  }
  const source = value;
  return (entity) => {
    use(each(source, (v) => apply(entity, v)));
  };
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
  return write(value, (entity, v) => {
    if (v === undefined) {
      entity.removeAttribute(keyOrValues);
    } else {
      entity.setAttribute(keyOrValues, v === null ? "null" : v.toString());
    }
  });
}

/**
 * @typedef {object} ObjectWithData
 * @property {DOMStringMap} dataset
 */

/**
 * Write one `dataset` entry. `undefined` deletes it; anything else is stored
 * the way `dataset` stores it, as its string, `null` as `"null"`.
 * See: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/dataset#setting_values
 *
 * @param {DOMStringMap} dataset
 * @param {string} key
 * @param {Primitive} value
 * @returns {void}
 */
function applyData(dataset, key, value) {
  if (value === undefined) {
    delete dataset[key];
  } else {
    dataset[key] = value === null ? "null" : value.toString();
  }
}

/**
 * @template {ObjectWithData} TEntity
 * @overload
 * @param {string} key
 * @param {Subscribable<Primitive> | (() => Primitive)} value
 * @returns {EntityEffect<TEntity>}
 */

/**
 * @template {ObjectWithData} TEntity
 * @overload
 * @param {Record<string, Primitive>} values
 * @returns {EntityEffect<TEntity>}
 */

/**
 * @template {ObjectWithData} TEntity
 * @param {string|Record<string, Primitive>} keyOrValues
 * @param {Subscribable<Primitive> | (() => Primitive)} [value]
 * @returns {EntityEffect<TEntity>}
 */
export function data(keyOrValues, value) {
  if (typeof keyOrValues === "object") {
    return effects((entity) => {
      for (const [key, val] of Object.entries(keyOrValues)) {
        applyData(entity.dataset, key, val);
      }
    });
  }
  if (!value) {
    throw new Error("Value observable is required when key is provided.");
  }
  return write(value, (entity, v) => applyData(entity.dataset, keyOrValues, v));
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
  return write(value, (entity, v) => {
    // `keyof CSSStyleDeclaration` includes its numeric index signature.
    applyStyle(entity.style, String(keyOrValues), v);
  });
}
