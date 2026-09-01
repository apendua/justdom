import { each, just, map, observable, Stream, use } from "@apendua/signal";
import ListRenderer from "./ListRenderer.js";
import { removeSegment, replaceSegment, toSegment } from "./helpers.js";
import { claimComment, claimElement, claimSegment, isHydrating, withCursor } from "./hydrate.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * @import {EntityEffect, Subscribable, Source} from '@apendua/signal';
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
  return map(toMountable)(
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
  return map(toMountable)(
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
    toMountable() {
      return {
        /**
         * @param {[Node, Node]} segment
         */
        replace: (segment) => {
          return replaceSegment(envelope, segment);
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
  // Held, not chosen. The renderer emits a new mountable whenever the list
  // changes, and it is `onEachValue` inside that stream — not this holder —
  // that drops the previous segment before the next one claims it, so there
  // is nothing here for `effectMap`'s ordering to buy: one dependency edge is
  // the whole of it.
  return (node) => {
    if (isHydrating()) {
      use(hydrateFragment(node, children));
      return;
    }
    use(
      each(renderer.renderFragment(children), (mountable) => {
        if (!node.firstChild || !node.lastChild) {
          const placeholder = node.appendChild(document.createComment(""));
          mountable.replace([placeholder, placeholder]);
        } else {
          mountable.replace([node.firstChild, node.lastChild]);
        }
      }),
    );
  };
}

/**
 * The hydrating counterpart of `renderFragment`.
 *
 * The normal path builds the children inside a detached fragment and then
 * replaces everything the parent already held, which is precisely what must not
 * happen to server rendered markup. Here each child claims the nodes that are
 * already in place instead, and only the *second* and later emissions go
 * through the usual replace, against the segment that was claimed.
 *
 * @param {Node} node
 * @param {Array<Subscribable<Mountable>>} children
 * @returns {Source<unknown>}
 */
function hydrateFragment(node, children) {
  return new Stream((subscriber) => {
    withCursor(node, () => {
      // Every rendered fragment is bracketed by a pair of comments.
      claimComment();
      for (const child of children) {
        /** @type {[Node, Node] | undefined} */
        let segment;
        let adopted = false;
        const claimed = claimSegment(() => {
          // No `distinctUntilChanged` in front of this any more. A node-backed
          // child already has the equality cutoff — a recomputation landing on
          // the value it held notifies nobody — and every other child hands
          // back a freshly built mountable per emission, which no comparison
          // was ever going to collapse.
          subscriber.add(
            child.subscribe({
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
            }),
          );
        });
        segment = claimed.segment;
        subscriber.add(() => {
          // A mismatch can tear this down mid-flight, with the segment already
          // detached, so only remove what is still in the document.
          if (segment && segment[0].parentNode && segment[1].parentNode) {
            removeSegment(segment);
          }
        });
      }
      claimComment();
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

/**
 * @param {Node} node
 * @returns {Mountable}
 */
export function toMountable(node) {
  return {
    replace: (segment) => {
      return replaceSegment(toSegment(node), segment);
    },
  };
}
