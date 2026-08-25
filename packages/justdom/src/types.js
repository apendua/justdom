/**
 * What this package hands out and takes back.
 *
 * These are `nodes.js`'s generic vocabulary pinned to the DOM's `Node`, which
 * is the only thing this package ever renders to: `document` appears in
 * `dom.js`, `text.js`, `stylesheet.js` and `hydrate.js`, and every node any of
 * them makes is a real one. So a caller writes `Mountable`, not
 * `Mountable<Node>`, and never meets the type parameter or the `INode`
 * constraint behind it.
 *
 * The parameter is still there underneath, holding the node-moving code away
 * from the DOM — see `nodes.js` for what it buys and why it is not exported.
 */

/**
 * @import { ContainerOf, MountableOf, SegmentOf } from "./nodes.js";
 */

/**
 * The span of siblings a tree occupies: its first node and its last, which
 * may be the same node.
 *
 * @typedef {SegmentOf<Node>} Segment
 */

/**
 * A tree that has not been put anywhere yet. `replace` swaps whatever
 * currently occupies a span for this tree's own nodes, and reports the span
 * they occupy afterwards.
 *
 * @typedef {MountableOf<Node>} Mountable
 */

/**
 * Somewhere to build a tree before it is mounted.
 *
 * @typedef {ContainerOf<Node>} Container
 */

export {};
