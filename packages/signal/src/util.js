import { Stream } from "./Stream.js";

/**
 * @import { Observer, Subscribable, Source, Unsubscribable } from './subscribable.js';
 */

/**
 * An operator over this package's own contract: a source in, a source out.
 * What `MonoTypeOperatorFunction` and `OperatorFunction` were being imported
 * for, spelled so that neither side of a pipeline has to be an RxJS
 * observable. An RxJS operator still applies to what these produce — through
 * `rx()` from `@apendua/signal/rxjs`, which names the crossing.
 *
 * @template T, U
 * @typedef {(source: Subscribable<T>) => Source<U>} Operator
 */

/**
 * @template T
 * @typedef {Operator<T, T>} MonoTypeOperator
 */

/**
 * A variant of the classic switchMap that doesn't wait for the inner observable
 * to complete if the source completes.
 *
 * @template T
 * @template U
 * @param {null | ((subscriber: { next: (value: U) => void, error: (err: unknown) => void }, value: T) => Unsubscribable)} subscribe
 * @returns {Operator<T, U>}
 */
export function onEachValue(subscribe) {
  return (source) => {
    return new Stream((subscriber) => {
      /** @type {Unsubscribable | undefined} */
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
 * @param {(value: T) => Subscribable<U>} fn
 * @returns {(subscriber: { next: (value: U) => void, error: (err: unknown) => void }, value: T) => Unsubscribable}
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
 * @template T
 * @param {(value: T) => Subscribable<unknown>} fn
 * @returns {(subscriber: { next: (value: T) => void, error: (err: unknown) => void }, value: T) => Unsubscribable}
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
 * @param  {...MonoTypeOperator<T>} operators
 * @returns {(source: Subscribable<T>) => Subscribable<T>}
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
 * @param {Subscribable<T>} source
 * @param {(value: T) => void} fn
 * @returns {Source<T>}
 */
export function each(source, fn) {
  return new Stream((subscriber) => {
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
