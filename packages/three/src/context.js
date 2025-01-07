/**
 * @typedef {Object} Context
 * @property {symbol} [key] - A symbol key with an unknown value.
 */

/**
 * Represents a property with getter and setter functions.
 * @template T
 * @typedef {Object} Property
 * @property {(ctx: Context) => T} get - Function to get the property value from the context.
 * @property {(ctx: Context, value: T) => Context} set - Function to set the property value in the context.
 */

/**
 * Creates a property with a default value.
 * @template T
 * @param {T} defaultValue
 * @returns {Property<T>}
 */
export function createProperty(defaultValue) {
  const key = Symbol("key");
  const property = Object.create(null);
  /**
   * @param {Context} ctx
   * @returns {T}
   */
  property.get = (ctx) => {
    if (key in ctx) {
      return /** @type {T} */ (ctx[key]);
    }
    return defaultValue;
  };
  /**
   * @param {Context} ctx
   * @param {T} value
   * @returns {Context}
   */
  property.set = (ctx, value) => {
    return Object.assign(Object.create(ctx), { [key]: value });
  };
  return property;
}
