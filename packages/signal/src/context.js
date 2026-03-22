/**
 * Represents a property with getter and setter functions.
 * @template T
 * @typedef {object} Property
 * @property {(ctx: WeakKey) => T} get - Function to get the property value from the context.
 * @property {(ctx: WeakKey, value: T) => WeakKey} set - Function to set the property value in the context.
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
