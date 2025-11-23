/**
 * @template T
 * @typedef {object} INode
 * @property {T | null} nextSibling
 * @property {T | null} previousSibling
 * @property {T | null} parentNode
 * @property {T | null} firstChild
 * @property {T | null} lastChild
 * @property {(node: T) => T} removeChild
 * @property {(node: T, before: T | null) => T} insertBefore
 * @property {(newNode: T, oldNode: T) => T} replaceChild
 */

/**
 * @template {INode<T>} T
 * @typedef {T & { parentNode: T }} NodeWithParent
 */

/**
 * @template {INode<T>} T
 * @typedef {[T, T]} Segment
 */

/**
 * @template {INode<T>} T
 * @typedef {object} Mountable
 * @property {(segment: Segment<T>) => Segment<T>} replace
 */

/**
 * @template {INode<T>} T
 * @typedef {object} Container
 * @property {(child: T) => T} appendChild
 * @property {() => Mountable<T>} toMountable
 */

export {};
