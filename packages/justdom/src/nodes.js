/**
 * The tree vocabulary, written against a node the way an algorithm needs to
 * see one rather than against the DOM's.
 *
 * Nothing in here is exported from the package, and that is the point. The two
 * files that do the actual work of moving nodes around — `helpers.js` and
 * `ListRenderer.js` — are written against `INode<T>` for one reason: with a
 * type parameter in hand, a `document.createComment()` smuggled into either of
 * them is a type error, because a `Comment` is not a `T`. Rewrite them against
 * the DOM's own `Node` and the same line compiles quietly, and the list
 * algorithm is welded to the browser a commit later. Those two files mention
 * `document` exactly nowhere, and this is what keeps it that way.
 *
 * `suspend.js` is deliberately not among them. It passes a mountable from one
 * observable to another and never touches a node, so a parameter there would
 * fence nothing; it uses the pinned `Mountable` like any caller does.
 *
 * `types.js` pins each of these to `Node` for the public API, which is what a
 * caller of this package sees: a `Mountable`, not a `Mountable<Node>`.
 */

/**
 * What the algorithms need a node to be able to do: know its neighbours, and
 * let its parent rearrange it. A DOM `Node` satisfies this, which is why
 * `types.js` can pin the parameter to one.
 *
 * The self-reference is load-bearing. `T extends INode<T>` is what makes
 * `node.nextSibling` a `T` rather than whatever the platform happens to call
 * a sibling, so a walk along a row of nodes stays in one type from end to
 * end. Constraining to `Node` instead does not: the DOM types `nextSibling`
 * as `ChildNode | null`, and every step of every walk stops typechecking.
 *
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
 * A node known to be somewhere rather than loose, which is what the segment
 * assertions narrow to before rearranging anything.
 *
 * @template {INode<T>} T
 * @typedef {T & { parentNode: T }} NodeWithParent
 */

/**
 * The span of siblings a tree occupies: its first node and its last, which
 * may be the same node.
 *
 * @template {INode<T>} T
 * @typedef {[T, T]} SegmentOf
 */

/**
 * A tree that has not been put anywhere yet.
 *
 * @template {INode<T>} T
 * @typedef {object} MountableOf
 * @property {(segment: SegmentOf<T>) => SegmentOf<T>} replace
 */

/**
 * Somewhere to build a tree before it is mounted.
 *
 * @template {INode<T>} T
 * @typedef {object} ContainerOf
 * @property {(child: T) => T} appendChild
 * @property {() => MountableOf<T>} toMountable
 */

export {};
