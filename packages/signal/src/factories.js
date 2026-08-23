import { share, Observable, ReplaySubject } from "rxjs";
import { Derived } from "./Derived.js";
import { toObservable } from "./interop.js";
import { onEachValue, subscribeTo, all } from "./util.js";

/**
 * @import { MonoTypeOperatorFunction, Subscriber } from 'rxjs';
 */

/**
 * A pure computation, as an observable of its values.
 *
 * A `Derived` for the value and an effect per subscriber to push it — see
 * `toObservable`. `fn` must be pure: it is a derivation, and it runs whenever
 * somebody looks.
 *
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
