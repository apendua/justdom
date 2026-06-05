import { withComputation } from "./index.js";
import { memoizeDerived, weakMemoize } from "./memoize.js";
import { batch, Derived } from "./Signal.js";

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
    const getValue = memoizeDerived(
      (/** @type {WeakKey} */ target) => {
        return new Derived(getter.bind(target), { deferred: true, isEqual });
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
      return memoizeDerived(
        (...args) => {
          return new Derived(originalFn.bind(target, ...args), {
            isEqual,
            deferred: true,
          });
        },
        {
          getKey,
        },
      );
    });
    descriptor.value = function value(/** @type {unknown[]} */ ...args) {
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
