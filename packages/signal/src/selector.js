import { Derived } from "./Signal.js";
import { NoValueError } from "./core.js";
import { isPlainObject, shallowEqual } from "./util.js";
import { memoize, memoizeDerived } from "./memoize.js";

/**
 * @template T
 * @param {T[]} a
 * @param {T[]} b
 * @returns {boolean}
 */
function arrayEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((item, index) => item === b[index]);
}

/**
 * @param {unknown} value
 * @returns {"object" | "array" | "primitive"}
 */
function typeOf(value) {
  if (isPlainObject(value)) {
    return "object";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return "primitive";
}

/**
 * @template {object} T
 * @overload
 * @param {Derived<T>} source
 * @returns {ProxyHandler<T>}
 *//**
 * @param {Derived<Record<PropertyKey, unknown>>} source
 * @returns {ProxyHandler<object>}
 */
function createProxyHandler(source) {
  const getType = memoize((/** @type {PropertyKey} */ key) => {
    return typeOf(source.get()[key]);
  });

  const get = memoize((/** @type {PropertyKey} */ key) => {
    const type = getType(key);
    if (type === "object") {
      return selector(() => {
        const value = source.get()[key];
        if (!isPlainObject(value)) {
          throw new NoValueError(`Value at key "${String(key)}" is not a plain object`);
        }
        return value;
      });
    }
    if (type === "array") {
      return arraySelector(() => {
        const value = source.get()[key];
        if (!Array.isArray(value)) {
          throw new NoValueError(`Value at key "${String(key)}" is not an array`);
        }
        return value;
      });
    }
    return source.get()[key];
  });

  // const ownType = new Derived(() => {
  //   return typeOf(source.get());
  // });

  const ownKeys = new Derived(() => Reflect.ownKeys(source.get()), {
    isEqual: arrayEqual,
  });

  const has = memoize((/** @type {PropertyKey} */ key) => {
    return Reflect.has(source.get(), key);
  });

  // const hasOwnPropertyDescriptor = memoize((/** @type {PropertyKey} */ key) => {
  //   return Reflect.getOwnPropertyDescriptor(source.get(), key) !== undefined;
  // });

  const getOwnPropertyDescriptor = memoizeDerived((/** @type {PropertyKey} */ key) => {
    // if (!hasOwnPropertyDescriptor(key)) {
    //   return undefined;
    // }
    // return selector(() => {
    //   const descriptor = Reflect.getOwnPropertyDescriptor(source.get(), key);
    //   if (!descriptor) {
    //     throw new NoValueError(`No property descriptor found for key "${String(key)}"`);
    //   }
    //   return descriptor;
    // });
    // return Reflect.getOwnPropertyDescriptor(source.get(), key);
    return new Derived(
      () => {
        const { configurable, enumerable, writable } =
          Reflect.getOwnPropertyDescriptor(source.get(), key) || {};
        return {
          configurable,
          enumerable,
          writable,
        };
      },
      {
        isEqual: shallowEqual,
      },
    );
  });

  const getPrototypeOf = memoize(() => {
    return Object.getPrototypeOf(source.get());
  });

  return {
    get(_, key) {
      return get(key);
    },
    ownKeys() {
      return ownKeys.get();
    },
    has(_, key) {
      return has(key);
    },
    getOwnPropertyDescriptor(_, key) {
      return getOwnPropertyDescriptor(key);
    },
    getPrototypeOf() {
      return getPrototypeOf();
    },
  };
}

/**
 * @template {unknown[]} T
 * @overload
 * @param {() => T} getter
 * @return {Readonly<T>}
 *//**
 * @param {() => unknown[]} getter
 * @return {unknown[]}
 */
export function arraySelector(getter) {
  const source = new Derived(getter);
  return new Proxy([], createProxyHandler(source));
}

/**
 * @template T1
 * @overload
 * @param {() => T1[]} getter
 * @return {Readonly<T1[]>}
 *//**
 * @template {object} T2
 * @overload
 * @param {() => T2} getter
 * @return {Readonly<T2>}
 *//**
 * @param {() => Record<PropertyKey, unknown>} getter
 * @return {Record<PropertyKey, unknown>}
 */
function selector(getter) {
  const source = new Derived(getter);
  return new Proxy({}, createProxyHandler(source));
}

export default selector;
