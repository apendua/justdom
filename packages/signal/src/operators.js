import { tap } from "rxjs";
import { Derived } from "./Derived.js";
import { onEachValue, subscribeTo, subscribeAndEmit } from "./util.js";
import { observable, component, just } from "./factories.js";
import { addDependency } from "./core.js";
import { toObservable, toEffect } from "./interop.js";

/**
 * @import { MonoTypeOperatorFunction, Observable } from 'rxjs';
 * @import { WritableProps } from './types.js';
 */

/**
 * Run `fn` against each value the source emits, and keep re-running it
 * whenever anything it read changes.
 *
 * An `Effect`, because that is what this has always been. It used to be a
 * `Derived` whose evaluation had side effects, which worked only because the
 * old core recomputed eagerly; a lazy core would run it at unpredictable
 * times, or never. Saying `Effect` makes the schedule explicit and puts the
 * work in a channel.
 *
 * @template T
 * @param {(value: T) => void} fn
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function effects(fn) {
  return onEachValue(subscribeAndEmit((value) => toEffect(() => fn(value), { name: "effects" })));
}

/**
 * @template T
 * @returns {(source: Observable<T>) => Observable<never>}
 */
export function takeNothing() {
  return onEachValue(null);
}

/**
 * @template T, U
 * @param {(value: T) => U} fn
 * @returns {(source: Observable<T>) => Observable<U>}
 */
export function map(fn) {
  return onEachValue(subscribeTo((value) => observable(() => fn(value))));
}

/**
 * @template T, U
 * @param {(value: T) => Observable<U>} fn
 * @returns {(source: Observable<T>) => Observable<U>}
 */
export function flatMap(fn) {
  return onEachValue(subscribeTo(component(fn)));
}

/**
 * @template T
 * @param {(value: T) => Observable<unknown>} fn
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function effectMap(fn) {
  return onEachValue(subscribeAndEmit(component(fn)));
}

/**
 * @template {object} TEntity
 * @template {keyof WritableProps<TEntity>} K
 * @overload
 * @param {K} key
 * @param {Observable<TEntity[K]> | (() => TEntity[K])} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */

/**
 * @template {object} TEntity
 * @overload
 * @param {Partial<WritableProps<TEntity>>} values
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */

/**
 * @template {object} TEntity
 * @template {keyof WritableProps<TEntity>} K
 * @param {K|Partial<WritableProps<Record<string, unknown>>>} keyOrValues
 * @param {Observable<unknown> | (() => unknown)} [value]
 * @returns {(source: Observable<Record<string, unknown>>) => Observable<Record<string, unknown>>}
 */
export function set(keyOrValues, value) {
  if (typeof keyOrValues === "object") {
    return effects((entity) => {
      Object.assign(entity, keyOrValues);
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
        entity[keyOrValues] = v;
      }),
    );
  });
}

/**
 * @template T
 * @param {T} value
 * @returns {void}
 * @param  {MonoTypeOperatorFunction<T>[]} operators
 */
export function useEffects(value, operators) {
  return use(just(value, operators));
}

/**
 * Hold an observable open for as long as the surrounding computation stands,
 * for its side effects alone — whatever it emits is dropped.
 *
 * A dependency edge and nothing more: the computation attaches it on connect
 * and lets go of it when it goes dormant, which is the lifetime the caller
 * wanted. `takeNothing()` is what says the values are not the point.
 *
 * This used to take a callback too, running it as an effect and keeping
 * whatever observable it handed back subscribed until the next run. The
 * callers who had an observable to switch between runs never materialised;
 * the ones with only side effects all did, and every one of them is better
 * served by `useEffect` — the same `Effect`, disposed by the same
 * computation, without an observable in the middle for it to be subscribed
 * through, and reading a returned function as a teardown rather than as
 * something to subscribe. A function arriving here is now a mistake with a
 * name on it, rather than a `TypeError` from inside the first run that
 * happens to return one.
 *
 * @param {Observable<unknown>} observable
 */
export function use(observable) {
  if (typeof observable === "function") {
    throw new TypeError(
      "use() takes an observable. A callback that only has side effects wants " +
        "useEffect(fn): the same effect, disposed by the same computation.",
    );
  }
  addDependency(observable.pipe(takeNothing()));
}

/**
 * @template {object} T
 * @typedef {{
 *   readonly [K in keyof T as T[K] extends (...args: any[]) => any ? never : K]-?:
 *     Observable<T[K]>
 * }} Observe
 */

/**
 * @template {object} T
 * @overload
 * @param {T} target
 * @returns {Observe<T>}
 */

/**
 * @param {Record<PropertyKey, unknown>} target
 */
export function observe(target) {
  return new Proxy(target, {
    get(_1, name) {
      return toObservable(new Derived(() => target[name]));
    },
  });
}

/**
 * @template {object} T
 * @typedef {{
 *   readonly [K in keyof T as T[K] extends (...args: any[]) => infer R
 *     ? R extends void
 *       ? never
 *       : K
 *     : never
 *   ]-?:
 *     T[K] extends (...args: infer U) => any
 *       ? (...args: U) => Observable<ReturnType<T[K]>>
 *       : never
 * }} ObserveFn
 */

/**
 * @template {object} T
 * @overload
 * @param {T} target
 * @returns {ObserveFn<T>}
 */

/**
 * @param {Record<PropertyKey, unknown>} target
 */
export function observeFn(target) {
  return new Proxy(target, {
    get(_1, name) {
      return new Proxy(new Function(), {
        apply(_2, _3, args) {
          return toObservable(
            new Derived(() => {
              if (typeof target[name] !== "function") {
                throw new Error(`Property ${String(name)} is not a function.`);
              }
              return target[name](...args);
            }),
          );
        },
      });
    },
  });
}
