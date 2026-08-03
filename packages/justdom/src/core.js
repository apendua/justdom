/**
 * @typedef {boolean | number | string | null | undefined} Primitive
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
 * @template {object} T
 * @typedef {{
 *   [P in keyof T as IfEquals<{ [Q in P]: T[P] }, { -readonly [Q in P]: T[P] },
 *   T[P] extends (...args: any[]) => any ? never : P>]?: T[P] extends (...args: any[]) => any ? never : T[P];
 * }} WritableProps
 */

export {};
