import { withComputation } from "./core.js";
import { memoizeDerived, weakMemoize } from "./memoize.js";
import { Derived } from "./Derived.js";
import { batch } from "./scheduler.js";

/**
 * @template {object} T
 * @template {keyof T} [K=keyof T]
 * @typedef {object} MemoOptions
 * @property {number} [cacheTTL]
 * @property {(oldValue: T[K], newValue: T[K]) => boolean} [isEqual]
 */

/**
 * @template {object} T
 * @template {keyof T} [K=keyof T]
 * @param {MemoOptions<T, K> | MemoOptions<T, K>["isEqual"]} [options]
 */
export function memo(options = {}) {
  /** @type {(a: T[K], b: T[K]) => boolean} */
  let isEqual;
  /** @type {number | undefined} */
  let cacheTTL;
  if (typeof options === "function") {
    isEqual = options;
  } else {
    ({ isEqual = Object.is, cacheTTL } = options);
  }

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
    const getValue = memoizeDerived(
      (/** @type {WeakKey} */ target) => {
        return new Derived(getter.bind(target), { isEqual, cacheTTL });
      },
      {
        cache: new WeakMap(),
        getKey: (target) => target,
      },
    );
    descriptor.get = function get() {
      return getValue(this);
    };
  };
}

/**
 * @template TValue
 * @template {unknown[]} TArgs
 * @typedef {object} MemoFnOptions
 * @property {number} [cacheTTL]
 * @property {(oldValue: TValue, newValue: TValue) => boolean} [isEqual]
 * @property {(...args: TArgs) => unknown[]} [getKey]
 */

/**
 * @template {PropertyKey} TKey
 * @template {{ [P in TKey]: (...args: any[]) => any }} T
 * @param {MemoFnOptions<ReturnType<T[TKey]>, Parameters<T[TKey]>> | MemoFnOptions<ReturnType<T[TKey]>, Parameters<T[TKey]>>["isEqual"]} [options]
 */
export function memoFn(options = {}) {
  /**
   * @typedef {ReturnType<T[TKey]>} TValue
   */

  /**
   * @typedef {Parameters<T[TKey]>} TArgs
   */

  /** @type {(a: TValue, b: TValue) => boolean} */
  let isEqual;
  /** @type {number | undefined} */
  let cacheTTL;
  /** @type {((...args: TArgs) => unknown[]) | undefined} */
  let getKey;
  if (typeof options === "function") {
    isEqual = options;
  } else {
    ({ isEqual = Object.is, cacheTTL, getKey } = options);
  }

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
    /** @type {(...args: Parameters<T[TKey]>) => TValue} */
    const originalFn = descriptor.value;
    const getBoundFn = weakMemoize((target) => {
      return memoizeDerived(
        (...args) => {
          return new Derived(() => originalFn.apply(target, args), {
            isEqual,
            cacheTTL,
          });
        },
        {
          getKey,
        },
      );
    });
    descriptor.value = function value(/** @type {TArgs} */ ...args) {
      return getBoundFn(this)(...args);
    };
  };
}

/**
 * @template {object} T
 * @template {keyof T} K
 * @param {T} target
 * @param {K} key
 * @param {Array<(target: T, key: K, descriptor: PropertyDescriptor) => void>} decorators
 */
export function decorate(target, key, ...decorators) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) {
    throw new Error(`No descriptor found for ${key.toString()}`);
  }
  for (const decorator of decorators) {
    decorator(target, key, descriptor);
  }
  Object.defineProperty(target, key, descriptor);
}

/**
 * @template {object} T
 */
export function mutate() {
  /**
   * @param {T} prototype
   * @param {PropertyKey} name
   * @param {PropertyDescriptor} descriptor
   * @returns {void}
   */
  return function decorator(prototype, name, descriptor) {
    if (typeof descriptor.value === "function") {
      const original = descriptor.value;
      /**
       * @param {any[]} args
       */
      descriptor.value = function value(...args) {
        return withComputation(null, () => batch(original.bind(this, ...args)));
      };
    } else {
      throw new Error(
        `Cannot decorate ${name.toString()} of ${prototype.constructor.name} because it is not a method`,
      );
    }
  };
}
