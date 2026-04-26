import { Observable } from "rxjs";

/**
 * @import { MonoTypeOperatorFunction, Subscription, Subscriber } from 'rxjs';
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
