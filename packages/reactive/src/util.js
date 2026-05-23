import { Derived } from "@apendua.dev/signal";
import { Observable } from "rxjs";

/**
 * @import { MonoTypeOperatorFunction, Subscription, Subscriber, Subscribable, ShareConfig } from 'rxjs';
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
 * @template T, U
 * @param {(value: T) => U} fn
 * @return {(value: T) => U}
 */
export function memoize(fn) {
  /** @type {Map<T, U>} */
  const cache = new Map();
  return (arg) => {
    if (cache.has(arg)) {
      return /** @type {U} */ (cache.get(arg));
    }
    const result = fn(arg);
    cache.set(arg, result);
    return result;
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
 * @property {Cache<TKey, Derived<TValue>>} [cache]
 * @property {(a: TValue, b: TValue) => boolean} [isEqual]
 */

/**
 * @template TKey
 * @template TValue
 * @template {unknown[]} TArgs
 * @overload
 * @param {(...args: TArgs) => TValue} fn
 * @param {RequiredKeys<MemoizeOptions<TKey, TValue, TArgs>, "getKey" | "cache">} [options]
 * @returns {(...args: TArgs) => TValue}
 */

/**
 * @template TKey
 * @template TValue
 * @overload
 * @param {(key: TKey) => TValue} fn
 * @param {MemoizeOptions<TKey, TValue, [TKey]>} [options]
 * @returns {(key: TKey) => TValue}
 */

/**
 * @param {(...args: unknown[]) => unknown} fn
 * @param {MemoizeOptions<unknown, unknown, unknown[]>} [options]
 * @returns {(...args: unknown[]) => unknown}
 */
export function memoize2(fn, options = {}) {
  const {
    cache = /** @type {Cache<unknown, Derived<unknown>>} */ (new Map()),
    getKey = (...args) => args[0],
    isEqual,
  } = options;

  /**
   * @param {unknown[]} args
   * @returns {Derived<unknown>}
   */
  function getSignal(...args) {
    const key = getKey(...args);
    const signal = cache.get(key);
    if (signal) {
      return signal;
    }
    /** @type {Derived<unknown>} */
    const newSignal = new Derived(() => fn(...args), { deferred: true, isEqual });
    newSignal.addSideEffect(
      new Observable(() => {
        cache.set(key, newSignal);
        return () => cache.delete(key);
      }),
    );
    return newSignal;
  }

  return (...args) => {
    return getSignal(...args).get();
  };
}
