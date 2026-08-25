import { createRecursiveCache } from "./cache.js";
import Computation from "./Computation.js";
import { Derived } from "./Derived.js";
import { resource } from "./core.js";

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
 * @typedef {object} HasResources
 * @property {(observable: Dependency) => void} addResource
 */

/**
 * @template TKey
 * @template TValue
 * @template {unknown[]} TArgs
 * @overload
 * @param {(...args: TArgs) => TValue} fn
 * @param {RequiredKeys<MemoizeOptions<TKey, Derived<TValue>, TArgs>, "getKey" | "cache">} [options]
 * @returns {(...args: TArgs) => TValue}
 *//**
 * @template {unknown[]} TArgs
 * @template TValue
 * @overload
 * @param {(...args: TArgs) => TValue} fn
 * @param {MemoizeOptions<unknown[], Derived<TValue>, TArgs>} [options]
 * @returns {(...args: TArgs) => TValue}
 *//**
 * @param {(...args: unknown[]) => unknown} fn
 * @param {MemoizeOptions<unknown[], Derived<unknown>, unknown[]>} [options]
 * @returns {(...args: unknown[]) => unknown}
 */
export function memoize(fn, options = {}) {
  const { cache = createRecursiveCache(), getKey = (...args) => args } = options;
  return (...args) => {
    const key = getKey(...args);
    const signal = cache.get(key);
    if (signal) {
      return signal.get();
    }
    const newSignal = new Derived(() => fn(...args));
    newSignal.addResource(
      resource(() => {
        cache.set(key, newSignal);
        return () => {
          cache.delete(key);
        };
      }),
    );
    return newSignal.get();
  };
}

/**
 * @template TKey
 * @template TValue
 * @template {unknown[]} TArgs
 * @overload
 * @param {(...args: TArgs) => Derived<TValue>} fn
 * @param {RequiredKeys<MemoizeOptions<TKey, Derived<TValue>, TArgs>, "getKey" | "cache">} [options]
 * @returns {(...args: TArgs) => TValue}
 *//**
 * @template {unknown[]} TArgs
 * @template TValue
 * @overload
 * @param {(...args: TArgs) => Derived<TValue>} fn
 * @param {MemoizeOptions<unknown[], Derived<TValue>, TArgs>} [options]
 * @returns {(...args: TArgs) => TValue}
 *//**
 * @param {(...args: unknown[]) => Derived<unknown>} fn
 * @param {MemoizeOptions<unknown[], Derived<unknown>, unknown[]>} [options]
 * @returns {(...args: unknown[]) => unknown}
 */
export function memoizeDerived(fn, options = {}) {
  const { cache = createRecursiveCache(), getKey = (...args) => args } = options;
  return (...args) => {
    const key = getKey(...args);
    const signal = cache.get(key);
    if (signal) {
      return signal.get();
    }
    const newSignal = fn(...args);
    newSignal.addResource(
      resource(() => {
        cache.set(key, newSignal);
        return () => {
          cache.delete(key);
        };
      }),
    );
    return newSignal.get();
  };
}

/**
 * @template TKey
 * @template {unknown[]} TArgs
 * @overload
 * @param {(...args: TArgs) => Dependency} fn
 * @param {RequiredKeys<MemoizeOptions<TKey, Computation, TArgs>, "getKey" | "cache">} [options]
 * @returns {(...args: TArgs) => Dependency}
 *//**
 * @template {unknown[]} TArgs
 * @overload
 * @param {(...args: TArgs) => Dependency} fn
 * @param {MemoizeOptions<unknown[], Computation, TArgs>} [options]
 * @returns {(...args: TArgs) => Dependency}
 *//**
 * @template {unknown[]} TArgs
 * @param {(...args: TArgs) => Dependency} fn
 * @param {MemoizeOptions<TArgs, Computation, TArgs>} [options]
 * @returns {(...args: TArgs) => Dependency}
 */
export function memoizeDependency(fn, options = {}) {
  const { cache = createRecursiveCache(), getKey = (...args) => args } = options;
  return (...args) => {
    const key = getKey(...args);
    const computation = cache.get(key);
    if (computation) {
      return computation;
    }
    // A relay: it has no value of its own, so every invalidation of anything
    // it holds is passed straight on.
    const newComputation = new Computation();
    newComputation.addResource(fn(...args));
    newComputation.addResource(
      resource(() => {
        cache.set(key, newComputation);
        return () => {
          cache.delete(key);
        };
      }),
    );
    return newComputation;
  };
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
