import { addDependency, Derived, toObservable } from "@apendua.dev/signal";
import { NEVER, tap } from "rxjs";
import { onEachValue, subscribeTo, subscribeAndEmit } from "./util.js";
import { observable, component, just } from "./factories.js";

/**
 * @import { Observable, MonoTypeOperatorFunction } from 'rxjs';
 * @import { WritableProps } from './core.js';
 */

/**
 * @template T
 * @param {(value: T) => void} fn
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function effects(fn) {
  return onEachValue(subscribeAndEmit((value) => toObservable(new Derived(() => fn(value)))));
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
 *
 * @template {object} TEntity
 * @overload
 * @param {Partial<WritableProps<TEntity>>} values
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 *
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
 * @param {(() => void) | (() => Observable<unknown>) | Observable<unknown>} observable
 */
export function use(observable) {
  if (typeof observable === "function") {
    const fn = observable;
    // Calling component immediately is safe, because it wil just return an observable,
    // and the inner function won't be executed until the observable is subscribed to.
    observable = component(() => {
      return fn() ?? NEVER;
    })();
  }
  addDependency(observable.pipe(takeNothing()));
}
