import { share, Observable, ReplaySubject } from "rxjs";
import { Derived, toObservable } from "@apendua.dev/signal";
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
  return toObservable(new Derived(fn));
}

/**
 * @template T
 * @param {() => Observable<T>} fn
 * @returns {Observable<T>}
 */
export function component(fn) {
  return observable(fn).pipe(onEachValue(subscribeTo((value) => value)));
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
