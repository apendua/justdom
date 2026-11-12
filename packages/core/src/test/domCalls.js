/**
 * The DOM calls that build and take apart a tree, counted by `countDomCalls`:
 * the first four are a document's, the rest any node's.
 */
const COUNTED = /** @type {const} */ ([
  "createElement",
  "createComment",
  "createTextNode",
  "createDocumentFragment",
  "insertBefore",
  "appendChild",
  "replaceChild",
  "removeChild",
]);

/**
 * The prototype that defines `name` for `object`, which is where a wrapper
 * has to go to be seen by every node. Looked up from the document, because
 * the test environment does not expose `Node` and `Document` as globals.
 *
 * @param {object} object
 * @param {string} name
 * @returns {Record<string, (...args: unknown[]) => unknown>}
 */
function definerOf(object, name) {
  let prototype = Object.getPrototypeOf(object);
  while (prototype && !Object.hasOwn(prototype, name)) {
    prototype = Object.getPrototypeOf(prototype);
  }
  if (!prototype) {
    throw new Error(`Nothing defines ${name}().`);
  }
  return prototype;
}

/**
 * @typedef {Record<(typeof COUNTED)[number], number>} DomCalls
 */

/**
 * Counts the DOM calls made while `fn` runs. The counts are exact and the
 * same on every machine, so a test can hold the cost of mounting or
 * unmounting a tree to a number, where a timing could not.
 *
 * @param {() => void} fn
 * @returns {DomCalls}
 */
export function countDomCalls(fn) {
  const calls = /** @type {DomCalls} */ ({});
  /** @type {Array<() => void>} */
  const restore = [];
  for (const method of COUNTED) {
    const target = definerOf(document, method);
    const original = target[method];
    calls[method] = 0;
    target[method] = function (...args) {
      calls[method] += 1;
      return original.apply(this, args);
    };
    restore.push(() => {
      target[method] = original;
    });
  }
  try {
    fn();
  } finally {
    for (const undo of restore) {
      undo();
    }
  }
  return calls;
}
