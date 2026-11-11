/**
 * Every per-node cache in the mirror, so that a node can be forgotten.
 *
 * The caches are module-level and keyed by node, which is what lets the
 * element components and the tests read them without a mirror in hand. It
 * also means a node outlives the portal that adopted it: its record still
 * names the first mirror, and every `Derived` cached for it still depends on
 * that mirror's signals. An element the page owns is exactly the node that
 * is claimed again — a second session over the same page — and a second
 * portal that adopted it would find the record already there, leave it, and
 * bump signals nothing under the element depends on: fonts arriving would
 * re-measure no text, a stylesheet swap restyle nothing. So a portal
 * forgets every node it lets go of, and a re-claimed node starts clean.
 *
 * @type {WeakMap<object, unknown>[]}
 */
export const nodeCaches = [];

/**
 * A cache keyed by node that `forgetNode` knows about. Exported for the
 * cached reads that live beside the elements they serve, such as a list
 * item's number in `listMarker.js`; anything kept per node has to be one of
 * these, or a re-claimed node keeps the first mirror's signals under it.
 * The exceptions hold nothing of a mirror's, or are emptied by their
 * owner, and are a plain `WeakMap` that says why in the `//` comment just
 * above its declaration, which starts `// Not a nodeCache:`.
 * `test/nodeCaches.test.js` holds every map keyed by a node to that.
 *
 * @template {WeakMap<any, any>} T
 * @returns {T}
 */
export function nodeCache() {
  const cache = new WeakMap();
  nodeCaches.push(cache);
  return /** @type {T} */ (cache);
}
