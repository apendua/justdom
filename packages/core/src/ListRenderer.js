import { removeSegment, toSegment } from "./helpers.js";
import { addDependency, batch, Derived, each, filtered, Stream, Subject } from "justdom-signal";

/**
 * @import { MonoTypeOperator, Subscribable, Source, Unsubscribable } from "justdom-signal";
 * @import { ContainerOf, INode, MountableOf, SegmentOf } from "./nodes.js"
 */

/**
 * @template T
 * @param {() => void} fn
 * @returns {MonoTypeOperator<T>}
 */
function teardown(fn) {
  return (source) => {
    return new Stream((subscriber) => {
      // The subscription goes on the teardown list first, so it is undone
      // before `fn` — which is the order RxJS put them in, and the order the
      // callers below assume: the child is unsubscribed, then its nodes come
      // out of the document.
      subscriber.add(source.subscribe(subscriber));
      return fn;
    });
  };
}

/**
 * Lets a caller supply the nodes from somewhere other than thin air, so the
 * same list logic can adopt server rendered markup. Kept as an injected
 * strategy rather than imported directly, so this class stays free of any
 * assumptions about what a node is.
 *
 * @template {INode<T>} T
 * @typedef {object} ListRendererHydration
 * @property {() => boolean} isActive Whether the next render should adopt.
 * @property {() => ContainerOf<T>} claimContainer Adopts the container envelope.
 * @property {(subscribe: () => void) => SegmentOf<T>} claimItem
 *   Runs `subscribe` and reports which nodes the item adopted.
 */

/**
 * @template {INode<T>} T
 * @typedef {object} ListRendererOptions
 * @property {() => ContainerOf<T>} createContainer
 * @property {() => T} createPlaceholder
 * @property {ListRendererHydration<T>} [hydration]
 */

/**
 * @template {INode<T>} T
 */
export default class ListRenderer {
  /** @type {() => ContainerOf<T>} */
  #createContainer;
  /** @type {() => T} */
  #createPlaceholder;
  /** @type {ListRendererHydration<T> | undefined} */
  #hydration;

  /**
   * @param {ListRendererOptions<T>} options
   */
  constructor(options) {
    this.#createContainer = options.createContainer;
    this.#createPlaceholder = options.createPlaceholder;
    this.#hydration = options.hydration;
  }

  /**
   * Creates a document fragment observable from child observables.
   * @param {Array<Subscribable<MountableOf<T>>>} children
   * @returns {Source<MountableOf<T>>}
   */
  renderFragment(children) {
    return new Stream((subscriber) => {
      /** @type {Map<number, SegmentOf<T>>} */
      const segments = new Map();
      const container = this.#createContainer();

      for (let i = 0; i < children.length; i++) {
        const node = container.appendChild(this.#createPlaceholder());
        segments.set(i, toSegment(node));
      }

      children.forEach((child, i) => {
        subscriber.add(
          teardown(() => {
            const oldSegment = segments.get(i);
            if (oldSegment) {
              removeSegment(oldSegment);
              segments.delete(i);
            }
          })(
            each(child, (newMountable) => {
              const oldSegment = segments.get(i);
              if (oldSegment) {
                segments.set(i, newMountable.replace(oldSegment));
              }
            }),
          ).subscribe({
            error: (error) => {
              // TODO: Render error message instead of failing the whole fragment.
              subscriber.error(error);
            },
          }),
        );
      });
      subscriber.next(container.toMountable());
    });
  }

  /**
   * Creates a list observable from an array of items and a render function.
   * @template U
   * @template K
   * @param {Subscribable<Iterable<U>>} items
   * @param {(item: U) => K} getKey
   * @param {(item: U, getIndex: () => number) => Subscribable<MountableOf<T>>} render
   * @returns {Source<MountableOf<T>>}
   */
  renderList(items, getKey, render) {
    return new Stream((subscriber) => {
      const hydration = this.#hydration;
      const hydrating = hydration ? hydration.isActive() : false;
      const container =
        hydrating && hydration ? hydration.claimContainer() : this.#createContainer();
      /** @type {Map<K, SegmentOf<T>>} */
      const childSegments = new Map();
      /** @type {Map<K, Unsubscribable>} */
      const childSubscriptions = new Map();
      /** @type {Map<K, number>} */
      const childIndexes = new Map();
      /** @type {Subject<K>} */
      const childIndexesSubject = new Subject();
      /**
       * @param {U} item
       * @returns {() => number}
       */
      const createGetIndex = (item) => {
        const key = getKey(item);
        const changes = filtered(childIndexesSubject, (changedKey) => changedKey === key);
        const index = new Derived(() => {
          addDependency(changes);
          return childIndexes.get(key) ?? -1;
        });
        return () => index.get();
      };
      /**
       * Adopts the markup for the initial set of items.
       *
       * There is nothing to diff against on the way in, so none of the moving
       * and removing below applies: the items simply claim what is already
       * there, left to right, and seed the same maps the diffing path reads on
       * every later emission.
       *
       * @param {U[]} newItemsArray
       * @returns {void}
       */
      const adopt = (newItemsArray) => {
        if (!hydration) {
          return;
        }
        newItemsArray.forEach((item, index) => {
          const key = getKey(item);
          childIndexes.set(key, index);
          let adopted = false;
          const segment = hydration.claimItem(() => {
            childSubscriptions.set(
              key,
              teardown(() => {
                const oldSegment = childSegments.get(key);
                if (oldSegment) {
                  removeSegment(oldSegment);
                  childSegments.delete(key);
                }
                childSubscriptions.delete(key);
              })(render(item, createGetIndex(item))).subscribe({
                next: (newMountable) => {
                  if (!adopted) {
                    // The markup this item adopted is already in place.
                    adopted = true;
                    return;
                  }
                  const oldSegment = childSegments.get(key);
                  if (oldSegment) {
                    childSegments.set(key, newMountable.replace(oldSegment));
                  }
                },
                error: (error) => {
                  subscriber.error(error);
                },
              }),
            );
          });
          childSegments.set(key, segment);
        });
      };

      let adopting = hydrating;
      const subscription = each(
        items,
        /** @param {Iterable<U>} newItems */
        (newItems) => {
          const newItemsArray = Array.from(newItems);
          if (adopting) {
            adopting = false;
            adopt(newItemsArray);
            return;
          }
          const newItemsSet = new Set(newItemsArray.map(getKey));
          // The items that left come out of the document before anything
          // moves. Left in place, each one sat between its neighbours during
          // the walk below, so every item in front of it found a next sibling
          // it did not expect and was re-inserted: removing the n-th item
          // moved the n - 1 items before it.
          for (const [key, childSegment] of childSegments.entries()) {
            if (!newItemsSet.has(key)) {
              removeSegment(childSegment);
              childSegments.delete(key);
            }
          }
          const staying = longestRunInOrder(newItemsArray, getKey, childIndexes);
          for (let index = newItemsArray.length - 1; index >= 0; index -= 1) {
            const item = newItemsArray[index];
            const key = getKey(item);
            if (!childIndexes.has(key)) {
              childIndexes.set(key, index);
            }
            let nextSegment;
            let i = index + 1;
            while (!nextSegment && i < newItemsArray.length) {
              const k = getKey(newItemsArray[i]);
              nextSegment = childSegments.get(k);
              i += 1;
            }
            if (!childSegments.has(key)) {
              // NOTE: Only put placeholder where the new item should be inserted. The actual element
              //       will be inserted by the subscription.
              if (!nextSegment) {
                const newPlaceholder = container.appendChild(this.#createPlaceholder());
                childSegments.set(key, toSegment(newPlaceholder));
              } else {
                const nextNode = nextSegment[0];
                const { parentNode } = nextNode;
                if (parentNode) {
                  const newPlaceholder = parentNode.insertBefore(
                    this.#createPlaceholder(),
                    nextNode,
                  );
                  childSegments.set(key, toSegment(newPlaceholder));
                }
              }
            }
            if (!childSubscriptions.has(key)) {
              childSubscriptions.set(
                key,
                teardown(() => {
                  const oldSegment = childSegments.get(key);
                  if (oldSegment) {
                    removeSegment(oldSegment);
                    childSegments.delete(key);
                  }
                  childSubscriptions.delete(key);
                })(render(item, createGetIndex(item))).subscribe({
                  next: (newMountable) => {
                    const oldSegment = childSegments.get(key);
                    if (oldSegment) {
                      childSegments.set(key, newMountable.replace(oldSegment));
                    }
                  },
                  error: (error) => {
                    subscriber.error(error);
                  },
                }),
              );
            } else if (!staying.has(key)) {
              // Only an item outside the longest run of items that kept
              // their order moves; the run stays where it is and the others
              // are placed around it. The walk goes from the end, so the
              // successor an item is placed in front of is already final.
              const childSegment = childSegments.get(key);
              if (childSegment) {
                if (nextSegment) {
                  const { parentNode } = nextSegment[0];
                  if (
                    parentNode &&
                    childSegment &&
                    childSegment[1].nextSibling !== nextSegment[0]
                  ) {
                    /** @type {T | null} */
                    let node = childSegment[1];
                    while (node) {
                      /** @type {T | null} */
                      const previousSibling = node.previousSibling;
                      parentNode.insertBefore(node, nextSegment[0]);
                      if (node === childSegment[0]) {
                        break;
                      }
                      node = previousSibling;
                    }
                  }
                } else {
                  // No successor to sit in front of, so the item belongs at
                  // the end of the container.
                  /** @type {T | null} */
                  let node = childSegment[1];
                  while (node) {
                    /** @type {T | null} */
                    const previousSibling = node.previousSibling;
                    container.appendChild(node);
                    if (node === childSegment[0]) {
                      break;
                    }
                    node = previousSibling;
                  }
                }
              }
            }
          }
          // Update/ remove indexes in a batch.
          batch(() => {
            for (let i = 0; i < newItemsArray.length; i++) {
              const item = newItemsArray[i];
              const key = getKey(item);
              if (childIndexes.get(key) !== i) {
                childIndexes.set(key, i);
                childIndexesSubject.next(key);
              }
            }
            for (const key of childSubscriptions.keys()) {
              if (!newItemsSet.has(key)) {
                childIndexes.delete(key);
                childIndexesSubject.next(key);
              }
            }
          });
          for (const [key, childSubscription] of childSubscriptions.entries()) {
            if (!newItemsSet.has(key)) {
              childSubscription.unsubscribe();
              childSubscriptions.delete(key);
            }
          }
        },
      ).subscribe({
        error: (error) => {
          // TODO: Render error message instead of failing the whole fragment.
          subscriber.error(error);
        },
      });
      subscriber.next(container.toMountable());
      return () => {
        subscription.unsubscribe();
        for (const subscription of childSubscriptions.values()) {
          subscription.unsubscribe();
        }
      };
    });
  }
}

/**
 * The keys of the longest run of items that were already in the list and kept
 * their order: the longest strictly increasing subsequence of their previous
 * indexes, read in the new order. An item new to the list, or whose key
 * appears a second time, is not part of any run. O(n log n).
 *
 * @template U
 * @template K
 * @param {U[]} items
 * @param {(item: U) => K} getKey
 * @param {Map<K, number>} previousIndexes
 * @returns {Set<K>}
 */
export function longestRunInOrder(items, getKey, previousIndexes) {
  /** @type {K[]} */
  const keys = [];
  /** @type {number[]} */
  const indexes = [];
  const seen = new Set();
  for (const item of items) {
    const key = getKey(item);
    const index = previousIndexes.get(key);
    if (index !== undefined && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
      indexes.push(index);
    }
  }
  // `tails[length - 1]` is the position, in `indexes`, of the smallest last
  // element of an increasing run of that length found so far.
  /** @type {number[]} */
  const tails = [];
  /** @type {number[]} */
  const previous = new Array(indexes.length);
  for (let i = 0; i < indexes.length; i++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (indexes[tails[middle]] < indexes[i]) low = middle + 1;
      else high = middle;
    }
    previous[i] = low > 0 ? tails[low - 1] : -1;
    tails[low] = i;
  }
  const run = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) {
    run.add(keys[i]);
  }
  return run;
}
