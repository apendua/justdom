import { Observable, ReplaySubject, share, Subject } from "rxjs";
import {
  createRecursiveCacheWithGetKey,
  createRecursiveCache,
} from "./cache.js";
import nextTick from "./nextTick.js";
import { takeUntilCompleted } from "./operators.js";

/**
 * @import { RecursiveCache } from "./cache.js";
 */

const myNextTick = nextTick().pipe(
  share({
    resetOnRefCountZero: true,
  }),
);

/**
 * @template {unknown[]} Args
 * @typedef {object} MemoizeOptions
 * @property {(...args: Args) => unknown[]} [getKey]
 * @property {boolean} [shareReplay]
 */

/**
 * @template T
 * @template {unknown[]} Args
 * @overload
 * @param {(...args: Args) => Observable<T>} fn
 * @param {MemoizeOptions<Args>} [options]
 * @returns {(...args: Args) => Observable<T>}
 */

/**
 * @param {(...args: unknown[]) => Observable<unknown>} fn
 * @param {MemoizeOptions<unknown[]>} [options]
 * @returns {(...args: unknown[]) => Observable<unknown>}
 */
const memoize = (fn, options = {}) => {
  /** @type {RecursiveCache<Observable<unknown>>} */
  let cache;
  const { getKey } = options;
  if (getKey) {
    cache = createRecursiveCacheWithGetKey((args) => getKey(...args));
  } else {
    cache = createRecursiveCache();
  }

  /**
   * @param {unknown[]} args
   */
  function getCacheEntry(args) {
    const observable = cache.get(args);
    if (observable) {
      return observable;
    }
    /** @type {Observable<unknown>} */
    const newObservable = fn(...args).pipe(
      takeUntilCompleted(
        new Observable(() => {
          cache.set(args, newObservable);
          return () => {
            cache.delete(args);
          };
        }),
      ),
      share({
        connector: () =>
          options.shareReplay ? new ReplaySubject() : new Subject(),
        resetOnRefCountZero: () => myNextTick,
      }),
    );
    return newObservable;
  }

  return (...args) => {
    return getCacheEntry(args);
  };
};

export default memoize;
