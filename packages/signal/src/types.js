/**
 * Represents a property with getter and setter functions.
 * @template T
 * @typedef {object} Property
 * @property {(ctx: WeakKey) => T} get - Function to get the property value from the context.
 * @property {(ctx: WeakKey, value: T) => WeakKey} set - Function to set the property value in the context.
 */

/**
 * @template X
 * @template Y
 * @template [A=X]
 * @template [B=never]
 * @typedef {(
 *   (<T>() => T extends X ? 1 : 2) extends
 *   (<T>() => T extends Y ? 1 : 2) ? A : B
 * )} IfEquals
 */

/**
 * @template X
 * @template A
 * @template [B=never]
 * @typedef {(
 *   X extends (...args: any[]) => any ? A : B
 * )} IfFunction
 */

/**
 * @template {object} T
 * @typedef {{
 *   [P in keyof T as IfEquals<{ [Q in P]: T[P] }, { -readonly [Q in P]: T[P] },
 *   IfFunction<T[P], never, P>>]?: IfFunction<T[P], never, T[P]>;
 * }} WritableProps
 */

/**
 * Work mounted on an entity for as long as its holder stands.
 *
 * This is what `just`, `useEffects` and `store` take where they used to take
 * a `MonoTypeOperatorFunction`: not a stream transformer, but the body of an
 * `Effect` with the entity in scope. It runs when the mounting is built,
 * re-runs when anything it read changes, may register teardowns through
 * `onCleanup` or by returning a function, and never substitutes the entity —
 * the one value a mounting carries is the entity itself.
 *
 * A plain lambda is a valid effect: `(el) => { ref = el; }` reads nothing, so
 * it runs exactly once per mounting.
 *
 * @template T
 * @typedef {(entity: T) => unknown} EntityEffect
 */

export {};
