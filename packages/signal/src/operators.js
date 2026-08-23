import { Observable, tap } from "rxjs";
import { Derived } from "./Derived.js";
import { onEachValue, subscribeTo, subscribeAndEmit } from "./util.js";
import { observable, component, just } from "./factories.js";
import { activeChannel, addDependency, withComputation } from "./core.js";
import { Effect } from "./Effect.js";
import { toObservable, toEffect } from "./interop.js";

/**
 * @import { MonoTypeOperatorFunction } from 'rxjs';
 * @import UpdateChannel from './UpdateChannel.js';
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
 * Run `fn` for as long as the surrounding computation stands, re-running it
 * when anything it read changes, and keeping whatever observable it hands
 * back subscribed in between.
 *
 * An `Effect`, because that is what it always was. It used to be a `Derived`
 * whose evaluation had side effects — `component(() => fn() ?? NEVER)` — and
 * that shape has a specific way of going wrong now. `fn` typically returns
 * nothing, so the node's value was the `NEVER` singleton on every evaluation;
 * `Object.is` therefore called every recomputation "unchanged", and the
 * equality cutoff kept the previous value and undid the run that had just
 * happened. Anything `fn` had set up with `onCleanup` — an interval, a
 * listener, a subscription — was torn down the instant it was established.
 *
 * The channel is captured here rather than left to be picked up when the
 * pipeline is subscribed. `use` is called while the surrounding region is
 * being built, which is where `withChannel` is in scope; subscription happens
 * later, from inside a `connect`, where it is not.
 *
 * @param {(() => void) | (() => Observable<unknown>) | Observable<unknown>} observable
 */
export function use(observable) {
  if (typeof observable === "function") {
    const fn = observable;
    const channel = /** @type {UpdateChannel | undefined} */ (activeChannel ?? undefined);
    observable = new Observable((subscriber) => {
      const effect = new Effect(
        () => {
          const inner = fn();
          if (!inner) {
            return undefined;
          }
          // Subscribing is not reading. A foreign observable's `subscribe`
          // may itself read reactive things — a `component(...)` builds its
          // entities in there — and those belong to whatever that observable
          // is, not to this effect. Tracking them would re-run `fn` and tear
          // the whole inner subscription down and back up on a write `fn`
          // never looked at. `Node#attach` and `toObservable` hold the same
          // line, for the same reason.
          const subscription = withComputation(null, () =>
            inner.subscribe({
              error: (err) => subscriber.error(err),
            }),
          );
          return () => subscription.unsubscribe();
        },
        {
          name: "use",
          channel,
          onError: (err) => subscriber.error(err),
        },
      );
      return () => {
        effect.dispose();
      };
    });
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
