/**
 * @import { Property } from "./types.js";
 */

/**
 * Every property `createProperty` has made. A property is its symbol — a
 * value set under one property is invisible to another, however alike they
 * look — so whatever keeps state across a module reload has to keep the
 * property itself, and this is how it tells one from a plain object.
 *
 * @type {WeakSet<object>}
 */
const properties = new WeakSet();

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isProperty(value) {
  return typeof value === "object" && value !== null && properties.has(value);
}

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

  properties.add(property);
  return property;
}
