import Computation from "./Computation.js";
import { onNextTick } from "./nextTick.js";
import { Derived } from "./Signal.js";
import { Observable } from "rxjs";

/**
 * @import { Dependency } from './core.js';
 */

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
 * @property {(observable: Dependency) => void} addSideEffect
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
        return () => {
          cache.delete(key);
        };
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
 * @template TKey
 * @template {unknown[]} TArgs
 * @overload
 * @param {(...args: TArgs) => Dependency} fn
 * @param {RequiredKeys<MemoizeOptions<TKey, Computation, TArgs>, "getKey" | "cache">} [options]
 * @returns {(...args: TArgs) => Dependency}
 *//**
 * @template TKey
 * @overload
 * @param {(key: TKey) => Dependency} fn
 * @param {MemoizeOptions<TKey, Computation, [TKey]>} [options]
 * @returns {(key: TKey) => Dependency}
 *//**
 * @template {unknown[]} TArgs
 * @param {(...args: TArgs) => Dependency} fn
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

/**
 * @template {object} T
 * @template U
 * @param {(key: T) => U} fn
 * @returns {(key: T) => U}
 */
export function weakMemoize(fn) {
  /** @type {WeakMap<T, U>} */
  const cache = new WeakMap();
  return (key) => {
    if (cache.has(key)) {
      return /** @type {U} */ (cache.get(key));
    }
    const value = fn(key);
    cache.set(key, value);
    return value;
  };
}
