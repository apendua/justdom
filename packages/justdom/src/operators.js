import { Derived, each, effects, set, on, use, useEffect } from "@apendua/signal";

/**
 * @import { EntityEffect, Subscribable } from '@apendua/signal';
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
 * A **getter** is a derivation, and wants nothing else: a `Derived` in front
 * of the write for its equality cutoff — a recomputation landing on the value
 * already written writes nothing — and an `Effect` to do the writing. No
 * stream anywhere. What it replaced was `observable(fn)` fed through
 * `effectMap`, which is a `Derived`, an `Effect` to push its values, a
 * `Stream` to run the write, another `Derived` to choose that stream and
 * another `Effect` to hold it: five pieces to assign an attribute, and the
 * `Derived` at the bottom of the stack was doing the only work.
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
      const source = new Derived(() => getValue());
      // `onError` because a getter can start throwing on a later run, and an
      // effect with nowhere to put that throws it from the scheduler's flush
      // instead — where nobody is waiting for it. `fail` is the mounting's own
      // channel, which is where the observable branch below already lands.
      useEffect(
        () => {
          apply(entity, source.get());
        },
        { name: "write", onError: fail },
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
 * @template {ObjectWithData} TEntity
 * @param {string} key
 * @param {Subscribable<Primitive>} value
 * @returns {EntityEffect<TEntity>}
 */
export function data(key, value) {
  return write(value, (entity, v) => {
    if (v === undefined) {
      delete entity.dataset[key];
    } else {
      // We are trying to mimic the behavior of the dataset property
      // See: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/dataset#setting_values
      entity.dataset[key] = v === null ? "null" : v.toString();
    }
  });
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
