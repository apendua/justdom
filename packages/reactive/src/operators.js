import { addDependency, Derived, Source, toObservable } from "@apendua.dev/signal";
import { Observable, switchAll, switchMap, tap } from "rxjs";

/**
 * @import { MonoTypeOperatorFunction } from 'rxjs';
 * @import { WritableProps } from './core.js';
 */

/**
 * @template T
 * @param {(value: T) => void} fn
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function effects(fn) {
  return switchMap((value) => {
    return new Observable((subscriber) => {
      subscriber.add(
        toObservable(new Derived(() => fn(value))).subscribe({
          error: (err) => {
            subscriber.error(err);
          },
        }),
      );
      subscriber.next(value);
    });
  });
}

/**
 * @template T
 * @returns {(source: Observable<T>) => Observable<never>}
 */
export function takeNothing() {
  return (source) => {
    return new Observable((subscriber) => {
      const subscription = source.subscribe({
        complete: () => subscriber.complete(),
        error: (err) => subscriber.error(err),
      });
      return () => {
        subscription.unsubscribe();
      };
    });
  };
}

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
export function flatten(fn) {
  return observable(fn).pipe(switchAll());
}

/**
 * @template T, U
 * @param {(value: T) => U} fn
 * @returns {(source: Observable<T>) => Observable<U>}
 */
export function map(fn) {
  return switchMap((value) => {
    return observable(() => fn(value));
  });
}

/**
 * @template T, U
 * @param {(value: T) => Observable<U>} fn
 * @returns {(source: Observable<T>) => Observable<U>}
 */
export function flatMap(fn) {
  return switchMap((value) => {
    return flatten(() => fn(value));
  });
}

/**
 * @template T
 * @param {(value: T) => Observable<unknown>} fn
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function effectMap(fn) {
  return switchMap((value) => {
    return new Observable((subscriber) => {
      subscriber.add(
        flatten(() => fn(value)).subscribe({
          error: (err) => {
            subscriber.error(err);
          },
        }),
      );
      subscriber.next(value);
    });
  });
}

/**
 * @template T
 * @template U
 * @param {T} props
 * @param {MonoTypeOperatorFunction<T>[]} operators
 * @returns {MonoTypeOperatorFunction<U>}
 */
export function join(props, operators) {
  return effectMap(() => just(props, operators));
}

/**
 * @param {(() => Observable<unknown>) | Observable<unknown>} observable
 */
export function use(observable) {
  if (typeof observable === "function") {
    observable = flatten(observable);
  }
  addDependency(new Source(observable.pipe(takeNothing())));
}

/**
 * @template {object} TEntity
 * @template {keyof WritableProps<TEntity>} K
 *
 * @overload
 * @param {K} key
 * @param {Observable<TEntity[K]> | (() => TEntity[K])} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 *
 * @overload
 * @param {Partial<WritableProps<TEntity>>} values
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 *
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
 * @param  {...MonoTypeOperatorFunction<T>} operators
 * @returns {MonoTypeOperatorFunction<T>}
 */
export const all = (...operators) => {
  return (source) => {
    return operators.reduce((prev, fn) => fn(prev), source);
  };
};

/**
 * @template T
 * @param {T} value
 * @returns {Observable<T>}
 * @param  {MonoTypeOperatorFunction<T>[]} [operators]
 */
export const just = (value, operators = []) => {
  return new Observable((subscriber) => {
    subscriber.next(value);
  }).pipe(all(...operators));
};

/**
 * @template T
 * @param {T} value
 * @returns {void}
 * @param  {MonoTypeOperatorFunction<T>[]} [operators]
 */
export const justUse = (value, operators = []) => {
  return use(just(value, operators));
};
