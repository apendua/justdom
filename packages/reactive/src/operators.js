import { $reactive, addDependency, Derived, Source, toObservable } from "@apendua.dev/signal";
import { Observable, switchMap } from "rxjs";

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
      subscriber.next(value);
      subscriber.add(
        toObservable(new Derived(() => fn(value))).subscribe({
          error: (err) => {
            subscriber.error(err);
          },
        }),
      );
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
 * @param {(() => Observable<unknown>) | Observable<unknown>} observable
 */
export function use(observable) {
  if (typeof observable === "function") {
    observable = $reactive(observable);
  }
  addDependency(new Source(observable.pipe(takeNothing())));
}

/**
 * @template {object} TEntity
 * @template {keyof WritableProps<TEntity>} K
 *
 * @overload
 * @param {K} key
 * @param {Observable<TEntity[K]>} value
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 *
 * @overload
 * @param {Partial<WritableProps<TEntity>>} props
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 *
 * @param {K|Partial<WritableProps<Record<string, unknown>>>} keyOrProps
 * @param {Observable<unknown>} [value]
 * @returns {(source: Observable<Record<string, unknown>>) => Observable<Record<string, unknown>>}
 */
export function set(keyOrProps, value) {
  if (typeof keyOrProps === "object") {
    return effects((entity) => {
      Object.assign(entity, keyOrProps);
    });
  }
  if (!value) {
    throw new Error("Value observable is required when key is provided.");
  }
  return switchMap((entity) => {
    return new Observable((subscriber) => {
      subscriber.add(
        value.subscribe({
          next: (v) => {
            entity[keyOrProps] = v;
          },
          error: (err) => subscriber.error(err),
        }),
      );
      subscriber.next(entity);
    });
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
