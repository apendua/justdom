/**
 * @import { Property } from "./types.js";
 */

/**
 * Creates a property with a default value.
 * @template T
 * @param {() => T} getDefaultValue
 * @returns {Property<T>}
 */
export function createProperty(getDefaultValue) {
  const key = Symbol("key");
  const property = Object.create(null);
  /** @type {{ value: T }} */
  let cached;

  /**
   * @param {WeakKey} ctx
   * @returns {T}
   */
  property.get = (ctx) => {
    if (key in ctx) {
      return /** @type {T} */ (ctx[key]);
    }
    if (!cached) {
      cached = { value: getDefaultValue() };
    }
    return cached.value;
  };

  /**
   * @param {WeakKey} ctx
   * @param {T} value
   * @returns {WeakKey}
   */
  property.set = (ctx, value) => {
    return Object.assign(Object.create(ctx), { [key]: value });
  };

  return property;
}
