import { share, Observable, ReplaySubject } from "rxjs";
import { Derived } from "./Signal.js";
import { toObservable } from "./core.js";
import { onEachValue, subscribeTo, all } from "./util.js";

/**
 * @import { MonoTypeOperatorFunction, Subscriber } from 'rxjs';
 */

/**
 * @template T
 * @param {() => T} fn
 * @return {Observable<T>}
 */
export function observable(fn) {
  return toObservable(new Derived(() => fn()));
}

/**
 * @template {unknown[]} TArgs
 * @template TValue
 * @param {(...args: TArgs) => Observable<TValue>} fn
 * @returns {(...args: TArgs) => Observable<TValue>}
 */
export function component(fn) {
  return (...args) => {
    return observable(() => fn(...args)).pipe(onEachValue(subscribeTo((value) => value)));
  };
}

/**
 * @template T
 * @param {T} value
 * @param {MonoTypeOperatorFunction<T>[]} [operators]
 * @returns {Observable<T>}
 */
export function just(value, operators = []) {
  return new Observable((/** @type {Subscriber<T>}*/ subscriber) => {
    subscriber.next(value);
  }).pipe(
    all(...operators),
    share({
      connector: () => new ReplaySubject(1),
      resetOnRefCountZero: true,
    }),
  );
}
