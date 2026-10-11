import { Derived } from "@apendua/signal";

/**
 * What outlines mode (`outlines.js`) counts, and the hooks the mirror calls
 * to count it. A leaf, so that the mirror can report into it without
 * importing the overlay, Three.js or the portal.
 *
 * Off, every hook is one null check. On, each tells the probe about one
 * element, and the probe keeps a tally per element until the commit of the
 * panel the element is in takes it (`takeTallies`). A text node's events
 * are its parent element's: the outline is drawn round elements.
 *
 * Five things are counted, and what each says about a panel is in
 * `outlines.js`:
 *
 *   - `changes`: the page changed the element, its text or its child list,
 *     and the mirror's `oldValue` check let the record through.
 *   - `noopWrites`: the page wrote to the element and the check dropped the
 *     record, because the value it wrote was the value already there.
 *   - `ripples`: the layout walk (`#settleLayout`) told the element that it
 *     may have moved, without the page touching it.
 *   - `recalculated` and `unchanged`: a cached read the mirror keeps for the
 *     element ran again, and how many of those runs came out equal to the
 *     value it already had. A run that came out equal was invalidated for
 *     nothing, and this is where a gap in the mirror's filtering shows.
 */

/**
 * @typedef {object} Tally
 * @property {number} changes
 * @property {number} noopWrites
 * @property {number} ripples
 * @property {number} recalculated
 * @property {number} unchanged
 */

/**
 * The tallies since each element's panel last committed, or null while
 * outlines mode is off. Keyed by element, in the order the elements were
 * first reported.
 *
 * @type {Map<Element, Tally> | null}
 */
let tallies = null;

/**
 * Set while the overlay reads the mirror itself, so that the reads it makes
 * to draw the outlines are not counted against the elements it reads.
 */
let paused = false;

/**
 * Start counting, or stop and drop whatever was counted.
 *
 * @param {boolean} on
 * @returns {void}
 */
export function setProbing(on) {
  tallies = on ? new Map() : null;
}

/**
 * Whether outlines mode is counting.
 *
 * @returns {boolean}
 */
export function isProbing() {
  return tallies !== null;
}

/**
 * Run `fn` without counting what it causes.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function unprobed(fn) {
  const was = paused;
  paused = true;
  try {
    return fn();
  } finally {
    paused = was;
  }
}

/**
 * The element a node's events count against: itself, or a text node's
 * parent.
 *
 * @param {Node} node
 * @returns {Element | null}
 */
function elementOf(node) {
  return node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node.parentElement;
}

/**
 * @param {Node} node
 * @returns {Tally | null}
 */
function tallyOf(node) {
  if (!tallies || paused) {
    return null;
  }
  const element = elementOf(node);
  if (!element) {
    return null;
  }
  let tally = tallies.get(element);
  if (!tally) {
    tally = { changes: 0, noopWrites: 0, ripples: 0, recalculated: 0, unchanged: 0 };
    tallies.set(element, tally);
  }
  return tally;
}

/**
 * The page changed `node`, and the change got past the `oldValue` check.
 *
 * @param {Node} node
 * @returns {void}
 */
export function probeChange(node) {
  const tally = tallyOf(node);
  if (tally) {
    tally.changes += 1;
  }
}

/**
 * The page wrote to `node` what was already there.
 *
 * @param {Node} node
 * @returns {void}
 */
export function probeNoopWrite(node) {
  const tally = tallyOf(node);
  if (tally) {
    tally.noopWrites += 1;
  }
}

/**
 * The layout walk told `node` it may have moved.
 *
 * @param {Node} node
 * @returns {void}
 */
export function probeRipple(node) {
  const tally = tallyOf(node);
  if (tally) {
    tally.ripples += 1;
  }
}

/**
 * A read kept for `node` ran again, and came out `changed` or not.
 *
 * @param {Node} node
 * @param {boolean} changed
 * @returns {void}
 */
export function probeRecalculation(node, changed) {
  const tally = tallyOf(node);
  if (tally) {
    tally.recalculated += 1;
    if (!changed) {
      tally.unchanged += 1;
    }
  }
}

/**
 * Hand `take` the tally of every element `within` contains, and forget
 * those tallies. Tallies of elements that left the document are dropped
 * as well, since no panel will commit them.
 *
 * @param {Element} within
 * @param {(element: Element, tally: Tally) => void} take
 * @returns {void}
 */
export function takeTallies(within, take) {
  if (!tallies) {
    return;
  }
  for (const [element, tally] of tallies) {
    if (!element.isConnected) {
      tallies.delete(element);
    } else if (within.contains(element)) {
      tallies.delete(element);
      take(element, tally);
    }
  }
}

/**
 * Whether two values are the same plain data: equal primitives, or arrays
 * and plain objects whose entries are. Anything else compares by identity.
 * The probe's own question, asked only while it is counting: a read whose
 * `isEqual` is identity, as a text layout's is, builds a new object on
 * every run, and whether the run was needed depends on what is in it.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameData(a, b) {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((entry, i) => sameData(entry, b[i]));
  }
  const proto = Object.getPrototypeOf(a);
  if ((proto !== Object.prototype && proto !== null) || Object.getPrototypeOf(b) !== proto) {
    return false;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  const x = /** @type {Record<string, unknown>} */ (a);
  const y = /** @type {Record<string, unknown>} */ (b);
  return keys.every((key) => key in y && sameData(x[key], y[key]));
}

/**
 * A `Derived` the mirror keeps for `node`, whose runs the probe counts. Its
 * equality gate is `isEqual`, unchanged; the probe only listens to it. A run
 * that `isEqual` lets through is still counted as unchanged when its value
 * is the same data as the one before (`sameData`).
 *
 * The first run has no value before it and is not counted: it builds the
 * read, and a panel being built is not a panel changing.
 *
 * @template T
 * @param {Node} node
 * @param {() => T} evaluate
 * @param {(a: T, b: T) => boolean} [isEqual]
 * @returns {Derived<T>}
 */
export function probedDerived(node, evaluate, isEqual = Object.is) {
  return new Derived(evaluate, {
    isEqual: (a, b) => {
      const equal = isEqual(a, b);
      if (tallies) {
        probeRecalculation(node, !(equal || sameData(a, b)));
      }
      return equal;
    },
  });
}
