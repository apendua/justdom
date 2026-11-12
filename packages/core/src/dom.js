import { each, just, observable, onCleanup, Stream, use, withComputation } from "justdom-signal";
import ListRenderer from "./ListRenderer.js";
import { insertSegment, replaceSegment, toSegment, unmountSegment } from "./helpers.js";
import { claimComment, claimElement, claimSegment, isHydrating, withCursor } from "./hydrate.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * @import {EntityEffect, Subscribable, Source, Unsubscribable} from 'justdom-signal';
 * @import {Mountable, Container} from "./types.js";
 */

/**
 * Creates an element observable.
 *
 * The element is created by the factory `just` runs per subscription, not
 * when `$()` is called. That matters for two reasons:
 *
 * - Creating at mount time means elements are acquired top-down, in document
 *   order, matching the order the mountings are built — argument evaluation
 *   alone would give the reverse. Hydration's cursor depends on that order.
 * - The same element observable can be mounted in more than one place. Eager
 *   creation gave every subscriber the *same* node, so the second mount stole
 *   it from the first and only one copy was rendered. A cold `just` runs the
 *   factory afresh for each subscriber, so every mount gets an element of its
 *   own.
 *
 * @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 * @param {EntityEffect<HTMLElementTagNameMap[Tag]>[]} effects
 * @returns {Source<Mountable>}
 */
export function $(tag, effects = []) {
  return asMountable(
    just(
      () =>
        /** @type {HTMLElementTagNameMap[Tag]} */ (
          claimElement(tag) ?? document.createElement(tag)
        ),
      effects,
    ),
  );
}

/**
 * @template {keyof SVGElementTagNameMap} Tag
 * @param {Tag} tag
 * @param {EntityEffect<SVGElementTagNameMap[Tag]>[]} effects
 * @returns {Source<Mountable>}
 */
export function $$(tag, effects = []) {
  return asMountable(
    just(
      () =>
        /** @type {SVGElementTagNameMap[Tag]} */ (
          claimElement(tag, SVG_NAMESPACE) ?? document.createElementNS(SVG_NAMESPACE, tag)
        ),
      effects,
    ),
  );
}

/**
 * @returns {Container}
 */
function createContainer() {
  /** @type {Node} */
  const fragment = document.createDocumentFragment();
  /** @type {[Node, Node]} */
  const envelope = [
    fragment.appendChild(createPlaceholder()),
    fragment.appendChild(createPlaceholder()),
  ];
  return {
    /**
     * @param {Node} child
     */
    appendChild(child) {
      if (!envelope[1].parentNode) {
        throw new Error("Cannot append child to a removed container.");
      }
      return envelope[1].parentNode.insertBefore(child, envelope[1]);
    },
    end() {
      return envelope[1];
    },
    toMountable() {
      return {
        /**
         * @param {[Node, Node]} segment
         */
        replace: (segment) => {
          return replaceSegment(envelope, segment);
        },
        /**
         * @param {Node} parent
         * @param {Node | null} before
         */
        insert: (parent, before) => {
          if (envelope[0].parentNode === fragment) {
            // Still where it was built, so the fragment carries every node
            // across in one call.
            parent.insertBefore(fragment, before);
            return envelope;
          }
          return insertSegment(envelope, parent, before);
        },
      };
    },
  };
}

/**
 * @returns {Node}
 */
function createPlaceholder() {
  return document.createComment("");
}

/**
 * The container a list adopts, made out of the envelope comments already in the
 * markup. The trailing one can only be claimed once the items have taken
 * theirs, so it is claimed on demand rather than up front.
 *
 * @returns {Container}
 */
function claimContainer() {
  const start = claimComment();
  /** @type {Node | null} */
  let end = null;
  const endOfContainer = () => {
    if (!end) {
      end = claimComment();
    }
    if (!end) {
      throw new Error("Cannot claim a container outside of hydration.");
    }
    return end;
  };
  if (!start) {
    throw new Error("Cannot claim a container outside of hydration.");
  }
  return {
    /**
     * @param {Node} child
     */
    appendChild(child) {
      const last = endOfContainer();
      if (!last.parentNode) {
        throw new Error("Cannot append child to a removed container.");
      }
      return last.parentNode.insertBefore(child, last);
    },
    end: endOfContainer,
    toMountable() {
      const last = endOfContainer();
      return {
        /**
         * @param {[Node, Node]} segment
         */
        replace: (segment) => replaceSegment([start, last], segment),
      };
    },
  };
}

const renderer = new ListRenderer({
  createContainer,
  createPlaceholder,
  hydration: {
    isActive: isHydrating,
    claimContainer,
    claimItem: (subscribe) => claimSegment(subscribe).segment,
  },
});

/**
 * @template {Node} T
 * @param {Array<Subscribable<Mountable>>} children
 * @returns {EntityEffect<T>}
 */
export function children(...children) {
  return (node, { fail }) => {
    if (isHydrating()) {
      use(hydrateFragment(node, children));
      return;
    }
    const { firstChild, lastChild } = node;
    if (!firstChild || !lastChild) {
      // The usual case, an element that holds nothing yet: the children
      // mount straight into it. The element is not in the document while
      // its effects mount, so building in it is as far off the document as
      // building in a fragment, without the fragment, the two comments
      // around it and the move across.
      const mounting = withComputation(null, () => renderer.mountChildren(node, children, fail));
      onCleanup(() => mounting.unsubscribe());
      return;
    }
    // An element that already holds something: the children are built on
    // the side and take the place of everything it held.
    //
    // Held, not chosen: the fragment emits its mountable once, while it is
    // being subscribed, and its children replace their own segments from
    // then on. So the holder has no ordering to contribute, and a plain
    // subscription is the whole of it. Not `use`, whose edge would put three
    // more streams around it. Its failure goes where `use` would have sent
    // it, the mounting's own channel.
    /** @type {[Node, Node]} */
    const held = [firstChild, lastChild];
    const subscription = withComputation(null, () =>
      renderer.renderFragment(children).subscribe({
        next: (mountable) => {
          mountable.replace(held);
        },
        error: fail,
      }),
    );
    onCleanup(() => subscription.unsubscribe());
  };
}

/**
 * The hydrating counterpart of `mountChildren`.
 *
 * The normal path inserts each child's nodes into the parent, which is
 * precisely what must not happen to server rendered markup. Here each child
 * claims the nodes that are already in place instead, and only the *second*
 * and later emissions go through the usual replace, against the segment that
 * was claimed.
 *
 * @param {Node} node
 * @param {Array<Subscribable<Mountable>>} children
 * @returns {Source<unknown>}
 */
function hydrateFragment(node, children) {
  return new Stream((subscriber) => {
    withCursor(node, () => {
      for (const child of children) {
        /** @type {[Node, Node] | undefined} */
        let segment;
        /** @type {Unsubscribable | undefined} */
        let subscription;
        let adopted = false;
        // On the list before the child is subscribed, so that a mismatch
        // thrown while claiming still lets go of the child. The child is
        // unsubscribed, then its nodes come out of the document.
        subscriber.add(() => {
          const release = () => subscription?.unsubscribe();
          // A mismatch can tear this down mid-flight, with the segment already
          // detached, so only remove what is still in the document.
          if (segment && segment[0].parentNode && segment[1].parentNode) {
            unmountSegment(segment, release);
          } else {
            release();
          }
        });
        const claimed = claimSegment(() => {
          // No `distinctUntilChanged` in front of this any more. A node-backed
          // child already has the equality cutoff — a recomputation landing on
          // the value it held notifies nobody — and every other child hands
          // back a freshly built mountable per emission, which no comparison
          // was ever going to collapse.
          subscription = child.subscribe({
            next: (mountable) => {
              if (!adopted) {
                // Already in the document -- this is the markup we adopted.
                adopted = true;
                return;
              }
              if (segment) {
                segment = mountable.replace(segment);
              }
            },
            error: (error) => subscriber.error(error),
          });
          if (subscriber.closed) {
            // An earlier child failed, which closed the subscriber, so
            // the teardown above ran before there was a subscription to
            // end. A child that failed itself is closed already.
            subscription.unsubscribe();
          }
        });
        segment = claimed.segment;
      }
    });
    subscriber.next(undefined);
  });
}

/**
 * @template T
 * @param {Subscribable<T> | (() => T)} value
 * @returns {Subscribable<T>}
 */
function normalize(value) {
  if (typeof value === "function") {
    return observable(value);
  }
  return value;
}

/**
 * @template T
 * @param {Subscribable<Iterable<T>> | (() => Iterable<T>)} items
 * @param {(item: T, getIndex: () => number) => Subscribable<Mountable>} renderItem
 * @returns {Source<Mountable>}
 */
export function list(items, renderItem) {
  items = normalize(items);
  return renderer.renderList(items, (item) => item, renderItem);
}

/**
 * @template K
 * @template T
 * @param {Subscribable<Iterable<[K, T]>> | (() => Iterable<[K, T]>) } items
 * @param {(item: T, key: K, index: () => number) => Subscribable<Mountable>} renderItem
 * @returns {Source<Mountable>}
 */
export function keyedList(items, renderItem) {
  items = normalize(items);
  return renderer.renderList(
    items,
    (item) => item[0],
    (item, index) => renderItem(item[1], item[0], index),
  );
}

/** The one item of the list `when` renders while its condition holds. */
const SHOWN = [true];

/** The empty list `when` renders otherwise, and `Nothing` always. */
const HIDDEN = /** @type {never[]} */ ([]);

/**
 * Mounts what `render` makes while `condition` holds, and takes it down when
 * it stops holding.
 *
 * This is mounting, not hiding. The nodes are not in the document while the
 * condition is false, whatever `render` built holds no state across two
 * spells of it, and `render` runs again each time the condition comes to
 * hold. To keep an element and its state and only stop showing it, write
 * its `hidden` property or a class. It is a `list` of one item or of none,
 * so a condition that is read again and still holds leaves what is mounted
 * alone.
 *
 * @param {() => unknown} condition Read reactively, and taken as a boolean.
 * @param {() => Subscribable<Mountable>} render
 * @returns {Source<Mountable>}
 */
export function when(condition, render) {
  return list(
    () => (condition() ? SHOWN : HIDDEN),
    () => render(),
  );
}

/**
 * Mounts one of several alternatives, chosen by a key.
 *
 * `render(key)` runs when `select` first gives a key and again each time it
 * gives a different one. A key read again and found the same leaves what is
 * mounted alone, with whatever state it holds. Keys are compared by
 * identity, as the items of a `list` are, so strings, numbers and booleans
 * are the usual ones.
 *
 * A replacement goes in the order a `list` replaces an item: the old
 * alternative's nodes leave the document, `render(key)` runs and the new
 * alternative is mounted, and only then are the old one's effects disposed
 * and its `onCleanup` run. So for a moment both are live, and an alternative
 * that holds something only one may hold, such as a listener on `window`,
 * has to allow for the next one taking it before it lets go.
 *
 * @template K
 * @param {() => K} select Read reactively.
 * @param {(key: K) => Subscribable<Mountable>} render
 * @returns {Source<Mountable>}
 */
export function branch(select, render) {
  return list(
    () => [select()],
    (key) => render(key),
  );
}

/**
 * Something to mount that puts nothing in the document: the alternative of
 * a `branch` that shows nothing, or a component that has nothing to show.
 *
 * @returns {Source<Mountable>}
 */
export function Nothing() {
  return renderer.renderList(
    just(HIDDEN),
    (item) => item,
    (item) => item,
  );
}

/**
 * A node's stream, emitting the node as something to mount.
 *
 * A plain relay rather than `map(toMountable)`: `map` runs its function in an
 * `observable` so that what it reads is tracked, which costs a `Derived` and
 * an `Effect` per node, and `toMountable` reads nothing.
 *
 * @param {Subscribable<Node>} source
 * @returns {Source<Mountable>}
 */
export function asMountable(source) {
  return new Stream((subscriber) =>
    source.subscribe({
      next: (node) => subscriber.next(toMountable(node)),
      error: (err) => subscriber.error(err),
      complete: () => subscriber.complete(),
    }),
  );
}

/**
 * @param {Node} node
 * @returns {Mountable}
 */
export function toMountable(node) {
  return new NodeMountable(node);
}

/**
 * One node as something to mount. A class, so that a node costs one object
 * and no closure of its own.
 *
 * @implements {Mountable}
 */
class NodeMountable {
  /** @type {Node} */
  #node;

  /**
   * @param {Node} node
   */
  constructor(node) {
    this.#node = node;
  }

  /**
   * @param {[Node, Node]} segment
   * @returns {[Node, Node]}
   */
  replace(segment) {
    return replaceSegment(toSegment(this.#node), segment);
  }

  /**
   * @param {Node} parent
   * @param {Node | null} before
   * @returns {[Node, Node]}
   */
  insert(parent, before) {
    parent.insertBefore(this.#node, before);
    return toSegment(this.#node);
  }
}
