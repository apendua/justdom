import { share, Observable, ReplaySubject } from "rxjs";
import { Derived } from "./Derived.js";
import { toEffect, toObservable } from "./interop.js";
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
 * A component that produces nothing — all of its work is what it mounts on the
 * way through.
 *
 * `component` is for the thing that has something to hand back: a mesh, a
 * panel, a scene. Plenty do not. A root reads the scene from its context and
 * decorates it; a behaviour attaches listeners and moves things about; both are
 * finished by the time they return, and had to say so by returning `Nothing()`
 * — a value invented to satisfy a caller that had no use for it.
 *
 * So this is the same shape with the value taken out: a factory, subscribed for
 * as long as its work should stand and unsubscribed to take it down. That it is
 * still a factory returning an observable is the point, and not only for the
 * caller — it is the shape `$reloadable` swaps, so a module built out of these
 * is one hot reload can replace.
 *
 * @template {unknown[]} TArgs
 * @param {(...args: TArgs) => void} fn
 * @returns {(...args: TArgs) => Observable<never>}
 */
export function effectsOnly(fn) {
  return (...args) => toEffect(() => fn(...args), { name: "effectsOnly" });
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
