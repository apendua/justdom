import {
  insertSegment,
  releaseLeaving,
  removeSegment,
  toSegment,
  unmountSegment,
} from "./helpers.js";
import {
  addDependency,
  batch,
  Derived,
  each,
  filtered,
  makeNonReactive,
  Stream,
  Subject,
  withComputation,
} from "justdom-signal";

/**
 * @import { MonoTypeOperator, Subscribable, Source, Unsubscribable } from "justdom-signal";
 * @import { ContainerOf, INode, MountableOf, NodeSourceOf, SegmentOf } from "./nodes.js"
 */

/**
 * Ends `subscription` and takes `segment`, the nodes it had in the tree,
 * out of it (see `unmountSegment`). With no segment, the nodes being gone
 * already, only the subscription ends.
 *
 * @template {INode<N>} N
 * @param {SegmentOf<N> | undefined} segment
 * @param {Unsubscribable} subscription
 * @returns {void}
 */
function unmount(segment, subscription) {
  if (segment) {
    unmountSegment(segment, () => subscription.unsubscribe());
  } else {
    subscription.unsubscribe();
  }
}

/**
 * Puts a tree that is not in the document yet into `parent`, in front of
 * `before` or at the end. A mountable with no `insert` of its own gets a
 * placeholder there to replace.
 *
 * @template {INode<N>} N
 * @param {MountableOf<N>} mountable
 * @param {N} parent
 * @param {N | null} before
 * @param {() => N} createPlaceholder
 * @returns {SegmentOf<N>}
 */
function place(mountable, parent, before, createPlaceholder) {
  if (mountable.insert) {
    return mountable.insert(parent, before);
  }
  const placeholder = parent.insertBefore(createPlaceholder(), before);
  return mountable.replace(toSegment(placeholder));
}

/**
 * The children `mountChildren` mounted into one parent.
 *
 * A class, and not the closures `mountChildren` used to build per call:
 * every element with children has one of these, so what it is made of is
 * paid per element. It holds two arrays, the holder's `fail` and one
 * function its children fail through. A child that is one node, the usual
 * one, adds its node and its mounting to the arrays and nothing else.
 *
 * @template {INode<N>} N
 * @implements {Unsubscribable}
 */
class ChildrenMounting {
  /**
   * What each child has in the parent: its one node, for a child that is a
   * source of one node, or the segment a subscribed child last put there.
   * `null` once the child was taken down.
   *
   * @type {Array<N | SegmentOf<N> | null | undefined>}
   */
  #held;

  /**
   * The mounting or the subscription of each child that got as far as
   * having one.
   *
   * @type {Array<Unsubscribable | undefined>}
   */
  #subscriptions;

  /** @type {(error: unknown) => void} */
  #fail;

  /**
   * Whether a child has failed. `mount` stops at the first one that has.
   *
   * @type {boolean}
   */
  #failed = false;

  /**
   * Where the failure of any child goes: to the holder, and on record, so
   * that the children behind it are not mounted. One function for all the
   * children, since each element with children has one of these.
   *
   * A child's failure is not always thrown while the child is mounted. An
   * effect of an element that is mounted already can run again and fail
   * while a later sibling is being mounted, and that arrives here too.
   *
   * @type {(error: unknown) => void}
   */
  #onError = (error) => {
    this.#failed = true;
    this.#fail(error);
  };

  /**
   * @param {number} count how many children there are
   * @param {(error: unknown) => void} fail
   */
  constructor(count, fail) {
    // Made at their full length. An array that grows by `push` is given
    // room for seventeen, and most elements have one child or two.
    this.#held = new Array(count);
    this.#subscriptions = new Array(count);
    this.#fail = fail;
  }

  /**
   * @param {N} parent
   * @param {Array<Subscribable<MountableOf<N>>>} children
   * @param {() => N} createPlaceholder
   * @returns {void}
   */
  mount(parent, children, createPlaceholder) {
    const held = this.#held;
    const subscriptions = this.#subscriptions;
    const onError = this.#onError;
    for (let i = 0; i < children.length && !this.#failed; i++) {
      const source = asNodeSource(children[i]);
      if (source) {
        try {
          const node = source.createNode();
          // Mounted before it is inserted, so the subtree is built off
          // the document, as a subscription builds it before it emits.
          subscriptions[i] = source.mountNode(node, onError);
          held[i] = parent.insertBefore(node, null);
        } catch (error) {
          onError(error);
        }
        continue;
      }
      let placed = false;
      subscriptions[i] = children[i].subscribe({
        next: (newMountable) => {
          try {
            if (placed) {
              this.#replace(i, newMountable);
            } else {
              placed = true;
              held[i] = place(newMountable, parent, null, createPlaceholder);
            }
          } catch (error) {
            onError(error);
          }
        },
        error: onError,
      });
      if (!placed) {
        placed = true;
        held[i] = toSegment(parent.insertBefore(createPlaceholder(), null));
      }
    }
  }

  /**
   * A subscribed child emitted again: what it emitted takes the place of
   * what it had.
   *
   * @param {number} i
   * @param {MountableOf<N>} newMountable
   * @returns {void}
   */
  #replace(i, newMountable) {
    const old = this.#held[i];
    // Only a subscribed child gets here, and what it holds is a segment.
    if (Array.isArray(old)) {
      // Non-reactive, like the first placement, which runs inside the
      // caller's own non-reactive subscribe: a replacement is not a read.
      this.#held[i] = withComputation(null, () => newMountable.replace(old));
    }
  }

  /**
   * Takes the children down, in order.
   *
   * @returns {void}
   */
  unsubscribe() {
    const held = this.#held;
    const subscriptions = this.#subscriptions;
    /** @type {{ value: unknown } | null} */
    let failure = null;
    for (let i = 0; i < subscriptions.length; i++) {
      const subscription = subscriptions[i];
      if (!subscription) {
        // A child that failed before it had one, or one behind it.
        continue;
      }
      const old = held[i];
      // The child is unsubscribed, then its nodes come out of the
      // document. A child whose cleanup throws does not strand the
      // ones after it: they all go, and the first failure is raised
      // once they have, as with the teardowns of a `Stream`.
      try {
        if (old) {
          held[i] = null;
          unmount(Array.isArray(old) ? old : toSegment(old), subscription);
        } else {
          subscription.unsubscribe();
        }
      } catch (error) {
        failure = failure ?? { value: error };
      }
    }
    if (failure) {
      throw failure.value;
    }
  }
}

/**
 * Passes `source` on, and when the subscription ends unmounts the segment
 * `takeSegment` hands over: the source is unsubscribed, then the segment's
 * nodes come out of the tree. `takeSegment` gives nothing when the nodes
 * are already gone, and then only the source is unsubscribed.
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
      return () => unmount(takeSegment(), subscription);
    });
  };
}

/**
 * `child` as a source of one node, when it is one: what `$()` and `$$()`
 * answer with (see `NodeSourceOf`). Such a child is mounted without being
 * subscribed to. Anything else gives `null`, and is subscribed to.
 *
 * @template {INode<T>} T
 * @param {Subscribable<MountableOf<T>>} child
 * @returns {NodeSourceOf<T> | null}
 */
function asNodeSource(child) {
  const candidate = /** @type {Partial<NodeSourceOf<T>>} */ (child);
  return typeof candidate.mountNode === "function"
    ? /** @type {NodeSourceOf<T>} */ (candidate)
    : null;
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
   * The children are mounted in order. A child that is a source of one
   * node, an element, is not subscribed to: its node is made, its effects
   * are mounted on it, and it is inserted at the end of `parent`. Any other
   * child is subscribed to. One that emits while it is being subscribed, a
   * list say, has its nodes inserted at the end of `parent` at once. One
   * that has not emitted by then gets a placeholder there, which its first
   * emission replaces. Later emissions replace the span the child
   * occupies, as in `renderFragment`.
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
    /** @type {ChildrenMounting<T>} */
    const mounting = new ChildrenMounting(children.length, fail);
    mounting.mount(parent, children, this.#createPlaceholder);
    return mounting;
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
       * Where an item's failure goes: it fails the list.
       *
       * @param {unknown} error
       */
      const fail = (error) => subscriber.error(error);
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
              const rendered = render(item, createGetIndex(item));
              const source = asNodeSource(rendered);
              if (source) {
                // An element is not subscribed to: its node is made, its
                // effects are mounted on it, and it goes in. A throw on the
                // way fails the list, like any other throw in here.
                const node = source.createNode();
                const mounted = source.mountNode(node, fail);
                childSegments.set(key, toSegment(parentNode.insertBefore(node, before)));
                childSubscriptions.set(key, {
                  unsubscribe: () => unmount(takeSegment(key), mounted),
                });
                continue;
              }
              let placed = false;
              const subscription = unmounting(() => takeSegment(key))(rendered).subscribe({
                next: (newMountable) => {
                  if (!placed) {
                    placed = true;
                    childSegments.set(
                      key,
                      place(newMountable, parentNode, before, this.#createPlaceholder),
                    );
                    return;
                  }
                  const oldSegment = childSegments.get(key);
                  if (oldSegment) {
                    childSegments.set(key, newMountable.replace(oldSegment));
                  }
                },
                error: fail,
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
              // With no successor to sit in front of, the item belongs at
              // the end of the container. Its nodes keep their order, so
              // an item of several nodes arrives as it was.
              const childSegment = childSegments.get(key);
              const before = nextSegment ? nextSegment[0] : container.end();
              const { parentNode } = before;
              if (childSegment && parentNode && childSegment[1].nextSibling !== before) {
                insertSegment(childSegment, parentNode, before);
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
