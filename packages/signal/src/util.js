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
 * Run `fn` for every value `source` produces, and pass the value on.
 *
 * The one thing `tap` was being imported for. Not reactive — an
 * `EntityEffect` is the reactive one — this is a plain pass-through with a
 * side effect on it, for the inner value pipelines an effect subscribes
 * through `use`.
 *
 * @template T
 * @param {Observable<T>} source
 * @param {(value: T) => void} fn
 * @returns {Observable<T>}
 */
export function each(source, fn) {
  return new Observable((subscriber) => {
    const subscription = source.subscribe({
      next: (value) => {
        try {
          fn(value);
        } catch (err) {
          subscriber.error(err);
          return;
        }
        subscriber.next(value);
      },
      error: (err) => subscriber.error(err),
      complete: () => subscriber.complete(),
    });
    return () => subscription.unsubscribe();
  });
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
