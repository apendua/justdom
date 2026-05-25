import Computation from "./Computation.js";
import { onNextTick } from "./nextTick.js";
import { Derived } from "./Signal.js";
import { Observable } from "rxjs";

/**
 * @import { MonoTypeOperatorFunction, Subscription, Subscriber, Subscribable, ShareConfig } from 'rxjs';
 * @import { Dependency } from './core.js';
 */

/**
 * A variant of the classic switchMap that doesn't wait for the inner observable
 * to complete if the source completes.
 *
 * @template T
 * @template U
 * @param {null | ((subscriber: Subscriber<U>, value: T) => Subscription)} subscribe
 * @returns {(source: Observable<T>) => Observable<U>}
 */
export function onEachValue(subscribe) {
  return (source) => {
    return new Observable((subscriber) => {
      /** @type {Subscription | undefined} */
      let innerSubscription;
      const subscription = source.subscribe({
        complete: () => subscriber.complete(),
        error: (err) => subscriber.error(err),
        next: subscribe
          ? (value) => {
              if (innerSubscription) {
                innerSubscription.unsubscribe();
              }
              innerSubscription = subscribe(subscriber, value);
            }
          : undefined,
      });
      return () => {
        subscription.unsubscribe();
        if (innerSubscription) {
          innerSubscription.unsubscribe();
          innerSubscription = undefined;
        }
      };
    });
  };
}

/**
 * @template T, U
 * @param {(value: T) => Observable<U>} fn
 * @returns {(subscriber: Subscriber<U>, value: T) => Subscription}
 */
export function subscribeTo(fn) {
  return (subscriber, value) => {
    return fn(value).subscribe({
      next: (v) => subscriber.next(v),
      error: (err) => subscriber.error(err),
    });
  };
}

/**
 * @template T, U
 * @param {(value: T) => Observable<unknown>} fn
 * @returns {(subscriber: Subscriber<T>, value: T) => Subscription}
 */
export function subscribeAndEmit(fn) {
  return (subscriber, value) => {
    const subscription = fn(value).subscribe({
      error: (err) => subscriber.error(err),
    });
    subscriber.next(value);
    return subscription;
  };
}

/**
 * @template T
 * @param  {...MonoTypeOperatorFunction<T>} operators
 * @returns {MonoTypeOperatorFunction<T>}
 */
export function all(...operators) {
  return (source) => {
    return operators.reduce((prev, fn) => fn(prev), source);
  };
}

/**
 * @param {unknown} value
 * @return {value is Record<PropertyKey, unknown>}
 */
export function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.constructor === Object &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) {
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((key) => Object.is(a[key], b[key]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => Object.is(item, b[index]));
  }
  return false;
}

/**
 * @template {object} T
 * @template {keyof T} K
 * @typedef {{ [P in K]-?: T[P] } & Omit<T, K>} RequiredKeys
 */

/**
 * @template TKey, TValue
 * @typedef {object} Cache
 * @property {(key: TKey) => TValue | undefined} get
 * @property {(key: TKey, value: TValue) => void} set
 * @property {(key: TKey) => void} delete
 */

/**
 * @template TKey
 * @template TValue
 * @template {unknown[]} TArgs
 * @typedef {object} MemoizeOptions
 * @property {(...args: TArgs) => TKey} [getKey]
 * @property {Cache<TKey, TValue>} [cache]
 */

/**
 * @typedef {object} HasSideEffects
 * @property {(observable: Subscribable<unknown>) => void} addSideEffect
 */

/**
 * @template TKey
 * @template {HasSideEffects} TValue
 * @template {unknown[]} TArgs
 * @overload
 * @param {(...args: TArgs) => TValue} fn
 * @param {RequiredKeys<MemoizeOptions<TKey, TValue, TArgs>, "getKey" | "cache">} [options]
 * @returns {(...args: TArgs) => TValue}
 *//**
 * @template TKey
 * @template TValue
 * @overload
 * @param {(key: TKey) => TValue} fn
 * @param {MemoizeOptions<TKey, TValue, [TKey]>} [options]
 * @returns {(key: TKey) => TValue}
 *//**
 * @param {(...args: unknown[]) => HasSideEffects} fn
 * @param {MemoizeOptions<unknown, unknown, unknown[]>} [options]
 * @returns {(...args: unknown[]) => unknown}
 */
export function memoize(fn, options = {}) {
  const {
    cache = /** @type {Cache<unknown, HasSideEffects>} */ (new Map()),
    getKey = (...args) => args[0],
  } = options;
  return (...args) => {
    const key = getKey(...args);
    const value = cache.get(key);
    if (value) {
      return value;
    }
    /** @type {HasSideEffects} */
    const newValue = fn(...args);
    newValue.addSideEffect(
      new Observable(() => {
        cache.set(key, newValue);
        return () => cache.delete(key);
      }),
    );
    return newValue;
  };
}

/**
 * @template TKey
 * @template TValue
 * @template {unknown[]} TArgs
 * @typedef {object} Memoize2Options
 * @property {(...args: TArgs) => TKey} [getKey]
 * @property {Cache<TKey, Derived<TValue>>} [cache]
 * @property {(a: TValue, b: TValue) => boolean} [isEqual]
 */

/**
 * @template TKey
 * @template TValue
 * @template {unknown[]} TArgs
 * @overload
 * @param {(...args: TArgs) => TValue} fn
 * @param {RequiredKeys<Memoize2Options<TKey, TValue, TArgs>, "getKey" | "cache">} [options]
 * @returns {(...args: TArgs) => TValue}
 *//**
 * @template TKey
 * @template TValue
 * @overload
 * @param {(key: TKey) => TValue} fn
 * @param {Memoize2Options<TKey, TValue, [TKey]>} [options]
 * @returns {(key: TKey) => TValue}
 *//**
 * @param {(...args: unknown[]) => unknown} fn
 * @param {Memoize2Options<unknown, unknown, unknown[]>} [options]
 * @returns {(...args: unknown[]) => unknown}
 */
export function memoize2(fn, options = {}) {
  const {
    cache = /** @type {Cache<unknown, Derived<unknown>>} */ (new Map()),
    getKey = (...args) => args[0],
    isEqual,
  } = options;
  const getSignal = memoize(
    (...args) =>
      new Derived(() => fn(...args), {
        isEqual,
        deferred: true,
      }),
    {
      cache,
      getKey,
    },
  );
  return (...args) => getSignal(...args).get();
}

/**
 * @template {unknown[]} TArgs
 * @param {(...args: TArgs) => Subscribable<unknown>} fn
 * @param {MemoizeOptions<unknown, Computation, TArgs>} [options]
 * @returns {(...args: TArgs) => Dependency}
 */
export function memoize3(fn, options = {}) {
  const {
    cache = /** @type {Cache<unknown, Computation>} */ (new Map()),
    getKey = (...args) => args[0],
  } = options;
  return memoize(
    (...args) => {
      const computation = new Computation({
        onInvalidateDependency() {
          this.invalidate();
        },
        resetOnRefCountZero: () => onNextTick,
      });
      computation.addSideEffect(fn(...args));
      return computation;
    },
    {
      cache,
      getKey,
    },
  );
}
