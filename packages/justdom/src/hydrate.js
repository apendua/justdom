import { just, Stream } from "@apendua/signal";
import { children } from "./dom.js";

/**
 * @import { Mountable, Segment } from "./types.js";
 */

/**
 * Thrown when the server rendered markup does not line up with what the
 * component tree wants to render. It is never surfaced to callers: `hydrate()`
 * catches it, throws the markup away and mounts from scratch instead.
 */
export class HydrationMismatchError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "HydrationMismatchError";
  }
}

/**
 * A position within the children of a server rendered node. Nodes are claimed
 * left to right, in the order the operator chain subscribes, which is document
 * order.
 */
class Cursor {
  /** @type {Node} */
  #parent;

  /** @type {Node | null} */
  #next;

  /**
   * @param {Node} parent
   */
  constructor(parent) {
    this.#parent = parent;
    this.#next = parent.firstChild;
  }

  get parent() {
    return this.#parent;
  }

  get next() {
    return this.#next;
  }

  /**
   * Claims the next node, provided it is the kind of node the caller expects.
   *
   * @param {(node: Node) => boolean} matches
   * @param {string} expected Used to describe the mismatch.
   * @returns {Node}
   */
  claim(matches, expected) {
    const node = this.#next;
    if (!node) {
      throw new HydrationMismatchError(`Expected ${expected}, but the markup ran out of nodes.`);
    }
    if (!matches(node)) {
      throw new HydrationMismatchError(`Expected ${expected}, but found ${describe(node)}.`);
    }
    this.#next = node.nextSibling;
    return node;
  }

  /**
   * Fails unless every node in this scope has been claimed. Left over nodes
   * mean the markup holds more than the component tree renders.
   *
   * @returns {void}
   */
  assertExhausted() {
    if (this.#next) {
      throw new HydrationMismatchError(`Markup holds unexpected trailing ${describe(this.#next)}.`);
    }
  }
}

/**
 * @param {Node} node
 * @returns {string}
 */
function describe(node) {
  switch (node.nodeType) {
    case 1:
      return `<${node.nodeName.toLowerCase()}>`;
    case 3:
      return `text ${JSON.stringify(node.nodeValue)}`;
    case 8:
      return "a comment";
    default:
      return `node type ${node.nodeType}`;
  }
}

/** @type {Cursor | null} */
let activeCursor = null;

/** @type {boolean} */
let enabled = false;

/**
 * Whether the tree currently being subscribed should adopt existing markup.
 * Only ever true for the duration of the initial, synchronous mount performed
 * by `hydrate()`; anything rendered later builds nodes the usual way.
 *
 * @returns {boolean}
 */
export function isHydrating() {
  return enabled;
}

/**
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function withHydration(fn) {
  const previous = enabled;
  enabled = true;
  try {
    return fn();
  } finally {
    enabled = previous;
    activeCursor = null;
  }
}

/**
 * Runs `fn` with hydration switched off, so that whatever it renders builds its
 * own nodes. For subtrees the markup does not describe.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function withoutHydration(fn) {
  const previousEnabled = enabled;
  const previousCursor = activeCursor;
  enabled = false;
  activeCursor = null;
  try {
    return fn();
  } finally {
    enabled = previousEnabled;
    activeCursor = previousCursor;
  }
}

/**
 * Runs `fn` while claiming from `parent`'s existing children.
 *
 * @template T
 * @param {Node} parent
 * @param {() => T} fn
 * @returns {T}
 */
export function withCursor(parent, fn) {
  const previous = activeCursor;
  const cursor = new Cursor(parent);
  activeCursor = cursor;
  try {
    const result = fn();
    cursor.assertExhausted();
    return result;
  } finally {
    activeCursor = previous;
  }
}

/**
 * Reports which nodes `fn` claimed from the current cursor, as a segment. Used
 * to record where a rendered child sits, so that a later emission can replace
 * it the usual way.
 *
 * @template T
 * @param {() => T} fn
 * @returns {{ result: T, segment: Segment }}
 */
export function claimSegment(fn) {
  const cursor = activeCursor;
  if (!cursor) {
    throw new Error("claimSegment() called outside of hydration.");
  }
  const first = cursor.next;
  const result = fn();
  const last = cursor.next ? cursor.next.previousSibling : cursor.parent.lastChild;
  if (!first || !last) {
    throw new HydrationMismatchError("Expected the markup to hold a rendered child.");
  }
  if (cursor.next === first) {
    // Nothing was claimed, so whatever rendered here built its own nodes and
    // does not know about the markup. Rendering it for real would leave the
    // server's copy stranded next to it, so bail out and rebuild everything.
    throw new HydrationMismatchError("A child rendered without adopting any markup.");
  }
  return { result, segment: [first, last] };
}

/**
 * Mounts `content` into `root`, adopting the markup already inside it instead
 * of building fresh nodes.
 *
 * Subscribing mounts, exactly as it does for a client rendered tree; the only
 * difference is where the nodes come from. If the markup does not line up with
 * what the tree renders, the whole of `root` is emptied and mounted from
 * scratch, so a mismatch costs performance rather than correctness.
 *
 * @param {Element} root
 * @param {...import("@apendua/signal").Subscribable<Mountable>} content
 * @returns {import("@apendua/signal").Source<unknown>}
 */
export function hydrate(root, ...content) {
  return new Stream((subscriber) => {
    /** @type {HydrationMismatchError | undefined} */
    let mismatch;

    // A throw inside a subscribe function is delivered to the error channel
    // rather than propagating out of `subscribe()`, so the mismatch is caught
    // here. Mounting is synchronous, so by the time the call returns we know
    // whether the markup was usable.
    let subscription = withHydration(() =>
      just(root, [children(...content)]).subscribe({
        error: (error) => {
          if (error instanceof HydrationMismatchError) {
            mismatch = error;
            return;
          }
          subscriber.error(error);
        },
      }),
    );

    if (mismatch) {
      console.warn(`Hydration failed, rendering from scratch instead. ${mismatch.message}`);
      subscription.unsubscribe();
      while (root.firstChild) {
        root.removeChild(root.firstChild);
      }
      subscription = just(root, [children(...content)]).subscribe({
        error: (error) => subscriber.error(error),
      });
    }

    return () => subscription.unsubscribe();
  });
}

/**
 * @param {string} tag
 * @param {string} [namespace]
 * @returns {Element | null} `null` when nothing is being hydrated.
 */
export function claimElement(tag, namespace) {
  if (!activeCursor) {
    return null;
  }
  const node = activeCursor.claim(
    (candidate) =>
      candidate.nodeType === 1 &&
      candidate.nodeName.toLowerCase() === tag.toLowerCase() &&
      (!namespace || /** @type {Element} */ (candidate).namespaceURI === namespace),
    `<${tag}>`,
  );
  return /** @type {Element} */ (node);
}

/**
 * @returns {Text | null} `null` when nothing is being hydrated.
 */
export function claimText() {
  if (!activeCursor) {
    return null;
  }
  return /** @type {Text} */ (activeCursor.claim((candidate) => candidate.nodeType === 3, "text"));
}

/**
 * @returns {Comment | null} `null` when nothing is being hydrated.
 */
export function claimComment() {
  if (!activeCursor) {
    return null;
  }
  return /** @type {Comment} */ (
    activeCursor.claim((candidate) => candidate.nodeType === 8, "a comment")
  );
}
