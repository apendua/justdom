import { Derived, NoValueError } from "@apendua.dev/signal";
import { memoize, isPlainObject } from "./util.js";

/**
 * @template {object} T
 * @overload
 * @param {() => T} getter
 * @return {Readonly<T>}
 */

/**
 * @param {() => Record<PropertyKey, unknown>} getter
 * @return {Record<PropertyKey, unknown>}
 */
function fields(getter) {
  const source = new Derived(getter);

  const getFieldsAtKey = memoize((/** @type {PropertyKey} */ key) => {
    return fields(() => {
      const value = source.get()[key];
      if (!isPlainObject(value)) {
        throw new NoValueError(`Value at key "${String(key)}" is not a plain object`);
      }
      return value;
    });
  });

  const getSignalAtKey = memoize((/** @type {PropertyKey} */ key) => {
    return new Derived(() => {
      const value = source.get()[key];
      if (isPlainObject(value)) {
        return getFieldsAtKey(key);
      }
      return value;
    });
  });

  /** @type {Record<PropertyKey, unknown>} */
  const target = {};

  const proxy = new Proxy(target, {
    get(_, key) {
      return getSignalAtKey(key).get();
    },
    has(_, key) {
      return key in source.get();
    },
    ownKeys() {
      return Reflect.ownKeys(source.get());
    },
  });

  return proxy;
}

export default fields;
