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
 * @param {() => T} getDefaultValue
 * @returns {Property<T>}
 */
export function createProperty(getDefaultValue) {
  const key = Symbol("key");
  const property = Object.create(null);
  /** @type {{ value: T }} */
  let cached;

  /**
   * @param {Context} ctx
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
   * @param {Context} ctx
   * @param {T} value
   * @returns {Context}
   */
  property.set = (ctx, value) => {
    return Object.assign(Object.create(ctx), { [key]: value });
  };

  return property;
}
