import { releaseLeaving, removeSegment, toSegment, unmountSegment } from "./helpers.js";
import {
  addDependency,
  batch,
  Derived,
  each,
  filtered,
  makeNonReactive,
  Stream,
  Subject,
} from "justdom-signal";

/**
 * @import { MonoTypeOperator, Subscribable, Source, Unsubscribable } from "justdom-signal";
 * @import { ContainerOf, INode, MountableOf, SegmentOf } from "./nodes.js"
 */

/**
 * Passes `source` on, and when the subscription ends unmounts the segment
 * `takeSegment` hands over: the source is unsubscribed, then the segment's
 * nodes come out of the tree (see `unmountSegment`). `takeSegment` gives
 * nothing when the nodes are already gone, and then only the source is
 * unsubscribed.
 *
 * @template {INode<N>} N
 * @template T
 * @param {() => SegmentOf<N> | undefined} takeSegment
 * @returns {MonoTypeOperator<T>}
 */
function unmounting(takeSegment) {
  return (source) => {
    return new Stream((subscriber) => {
      const subscription = source.subscribe(subscriber);
      return () => {
        const segment = takeSegment();
        if (segment) {
          unmountSegment(segment, () => subscription.unsubscribe());
        } else {
          subscription.unsubscribe();
        }
      };
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
      /** @type {Array<SegmentOf<T> | null>} */
      const segments = [];
      const container = this.#createContainer();

      for (let i = 0; i < children.length; i++) {
        const node = container.appendChild(this.#createPlaceholder());
        segments.push(toSegment(node));
      }

      // One subscription per child and nothing around it: this runs for
      // every element with children, so each layer of stream here is paid
      // per element. Non-reactive like `each`, which this used to go
      // through: a replacement is not a read.
      const replace = makeNonReactive(
        /**
         * @param {number} i
         * @param {MountableOf<T>} newMountable
         */
        (i, newMountable) => {
          const oldSegment = segments[i];
          if (oldSegment) {
            segments[i] = newMountable.replace(oldSegment);
          }
        },
      );
      children.forEach((child, i) => {
        const subscription = child.subscribe({
          next: (newMountable) => {
            try {
              replace(i, newMountable);
            } catch (error) {
              subscriber.error(error);
            }
          },
          error: (error) => {
            subscriber.error(error);
          },
        });
        // The child is unsubscribed, then its nodes come out of the document.
        subscriber.add(() => {
          const oldSegment = segments[i];
          if (oldSegment) {
            segments[i] = null;
            unmountSegment(oldSegment, () => subscription.unsubscribe());
          } else {
            subscription.unsubscribe();
          }
        });
      });
      subscriber.next(container.toMountable());
    });
  }

  /**
   * Mounts `children` straight into `parent`, which holds nothing yet, and
   * hands back the mounting, to be unsubscribed when the children should go.
   *
   * The children are subscribed in order. One that emits while it is being
   * subscribed, an element or a list, has its nodes inserted at the end of
   * `parent` at once. One that has not emitted by then gets a placeholder
   * there, which its first emission replaces. Later emissions replace the
   * span the child occupies, as in `renderFragment`.
   *
   * A failure, a child's or a throw while placing one, goes to `fail`, and
   * the children after it are not mounted.
   *
   * @param {T} parent
   * @param {Array<Subscribable<MountableOf<T>>>} children
   * @param {(error: unknown) => void} fail
   * @returns {Unsubscribable}
   */
  mountChildren(parent, children, fail) {
    /** @type {Array<SegmentOf<T> | null>} */
    const segments = [];
    /** @type {Unsubscribable[]} */
    const subscriptions = [];
    let failed = false;
    /** @param {unknown} error */
    const onError = (error) => {
      failed = true;
      fail(error);
    };
    // Non-reactive, like the first placement, which runs inside the
    // caller's own non-reactive subscribe: a replacement is not a read.
    const replace = makeNonReactive(
      /**
       * @param {number} i
       * @param {MountableOf<T>} newMountable
       */
      (i, newMountable) => {
        const oldSegment = segments[i];
        if (oldSegment) {
          segments[i] = newMountable.replace(oldSegment);
        }
      },
    );
    for (let i = 0; i < children.length && !failed; i++) {
      let placed = false;
      subscriptions.push(
        children[i].subscribe({
          next: (newMountable) => {
            try {
              if (placed) {
                replace(i, newMountable);
              } else {
                placed = true;
                segments[i] = this.#place(newMountable, parent, null);
              }
            } catch (error) {
              onError(error);
            }
          },
          error: onError,
        }),
      );
      if (!placed) {
        placed = true;
        segments[i] = toSegment(parent.insertBefore(this.#createPlaceholder(), null));
      }
    }
    return {
      unsubscribe: () => {
        for (let i = 0; i < subscriptions.length; i++) {
          const subscription = subscriptions[i];
          const oldSegment = segments[i];
          // The child is unsubscribed, then its nodes come out of the
          // document.
          if (oldSegment) {
            segments[i] = null;
            unmountSegment(oldSegment, () => subscription.unsubscribe());
          } else {
            subscription.unsubscribe();
          }
        }
      },
    };
  }

  /**
   * Puts a tree that is not in the document yet into `parent`, in front of
   * `before` or at the end. A mountable with no `insert` of its own gets a
   * placeholder there to replace.
   *
   * @param {MountableOf<T>} mountable
   * @param {T} parent
   * @param {T | null} before
   * @returns {SegmentOf<T>}
   */
  #place(mountable, parent, before) {
    if (mountable.insert) {
      return mountable.insert(parent, before);
    }
    const placeholder = parent.insertBefore(this.#createPlaceholder(), before);
    return mountable.replace(toSegment(placeholder));
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
        // Built on the first read: most items never ask for their index, and
        // the node and its filtered stream would be held for every one.
        /** @type {Derived<number> | null} */
        let index = null;
        return () => {
          if (!index) {
            // Built once, outside the node, so that every run reads the same
            // stream and its edge stays attached across index changes.
            const changes = filtered(childIndexesSubject, (changedKey) => changedKey === key);
            index = new Derived(() => {
              addDependency(changes);
              return childIndexes.get(key) ?? -1;
            });
          }
          return index.get();
        };
      };
      /**
       * Forgets an item whose subscription is ending, and hands back the
       * nodes it still has in the tree, if any.
       *
       * @param {K} key
       * @returns {SegmentOf<T> | undefined}
       */
      const takeSegment = (key) => {
        const segment = childSegments.get(key);
        childSegments.delete(key);
        childSubscriptions.delete(key);
        return segment;
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
              unmounting(() => takeSegment(key))(render(item, createGetIndex(item))).subscribe({
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
          /** @type {Map<K, SegmentOf<T>>} */
          const departed = new Map();
          for (const [key, childSegment] of childSegments.entries()) {
            if (!newItemsSet.has(key)) {
              removeSegment(childSegment);
              childSegments.delete(key);
              departed.set(key, childSegment);
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
            if (!childSubscriptions.has(key)) {
              // A new item goes in front of its successor, or at the end of
              // the container. One that emits while it is being subscribed
              // has its nodes inserted there at once. One that has not
              // emitted by then gets a placeholder, which its first emission
              // replaces.
              const before = nextSegment ? nextSegment[0] : container.end();
              const { parentNode } = before;
              if (!parentNode) {
                throw new Error("Cannot add an item to a list that was removed.");
              }
              let placed = false;
              const subscription = unmounting(() => takeSegment(key))(
                render(item, createGetIndex(item)),
              ).subscribe({
                next: (newMountable) => {
                  if (!placed) {
                    placed = true;
                    childSegments.set(key, this.#place(newMountable, parentNode, before));
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
              });
              if (!placed) {
                placed = true;
                childSegments.set(
                  key,
                  toSegment(parentNode.insertBefore(this.#createPlaceholder(), before)),
                );
              }
              childSubscriptions.set(key, subscription);
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
              // Its nodes left before the walk, with everything under them,
              // so nothing inside has to be removed on its own.
              const segment = departed.get(key);
              if (segment) {
                releaseLeaving(segment, () => childSubscription.unsubscribe());
              } else {
                childSubscription.unsubscribe();
              }
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
