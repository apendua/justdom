import { createRecursiveCache } from "./cache.js";
import { memoize2, weakMemoize } from "./memoize.js";

/**
 * @template {object} T
 * @template {keyof T} [K=keyof T]
 * @param {(oldValue: T[K], newValue: T[K]) => boolean} [isEqual]
 */
export function memo(isEqual = Object.is) {
  /**
   * @param {T} _prototype
   * @param {K} _name
   * @param {PropertyDescriptor} descriptor
   * @returns {void}
   */
  return function decorator(_prototype, _name, descriptor) {
    if (!descriptor.get) {
      throw new Error("memo decorator can only be applied to getters");
    }
    const getter = descriptor.get;
    const getValue = memoize2((target) => getter.apply(target), {
      cache: new WeakMap(),
      isEqual,
    });
    descriptor.get = function get() {
      return getValue(this);
    };
  };
}

/**
 * @template TValue
 * @template {PropertyKey} TKey
 * @template {{ [P in TKey]: (...args: any[]) => TValue }} T
 * @param {(...args: unknown[]) => unknown[]} [getKey]
 * @param {(oldValue: TValue, newValue: TValue) => boolean} [isEqual]
 */
export function memoFn(getKey = (...args) => args, isEqual = Object.is) {
  /**
   * @param {T} _prototype
   * @param {TKey} _name
   * @param {PropertyDescriptor} descriptor
   * @returns {void}
   */
  return function decorator(_prototype, _name, descriptor) {
    if (typeof descriptor.value !== "function") {
      throw new Error("memoFn decorator can only be applied to functions");
    }
    /** @type {(...args: unknown[]) => TValue} */
    const originalFn = descriptor.value;
    const getBoundFn = weakMemoize((target) => {
      return memoize2((...args) => originalFn.apply(target, args), {
        cache: createRecursiveCache(),
        getKey,
        isEqual,
      });
    });
    descriptor.value = function value(/** @type {unknown[]} */ ...args) {
      return getBoundFn(this)(...args);
    };
  };
}
