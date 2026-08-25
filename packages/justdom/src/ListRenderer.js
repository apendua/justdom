import { distinctUntilChanged, filter, Observable, Subject, tap } from "rxjs";
import { removeSegment, toSegment } from "./helpers.js";
import { addDependency, batch, Derived } from "justdom-signal";

/**
 * @import { Subscription } from "rxjs";
 * @import { ContainerOf, INode, MountableOf, SegmentOf } from "./nodes.js"
 */

/**
 * @template T
 * @param {() => void} [fn]
 * @returns {(source: Observable<T>) => Observable<T>}
 */
function teardown(fn) {
  return (source) => {
    if (!fn) {
      return source;
    }
    return new Observable((subscriber) => {
      source.subscribe(subscriber);
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
   * @param {Array<Observable<MountableOf<T>>>} children
   * @returns {Observable<MountableOf<T>>}
   */
  renderFragment(children) {
    return new Observable((subscriber) => {
      /** @type {Map<number, SegmentOf<T>>} */
      const segments = new Map();
      const container = this.#createContainer();

      for (let i = 0; i < children.length; i++) {
        const node = container.appendChild(this.#createPlaceholder());
        segments.set(i, toSegment(node));
      }

      children.forEach((child, i) => {
        subscriber.add(
          child
            .pipe(
              distinctUntilChanged(),
              tap((newMountable) => {
                const oldSegment = segments.get(i);
                if (oldSegment) {
                  segments.set(i, newMountable.replace(oldSegment));
                }
              }),
              teardown(() => {
                const oldSegment = segments.get(i);
                if (oldSegment) {
                  removeSegment(oldSegment);
                  segments.delete(i);
                }
              }),
            )
            .subscribe({
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
   * @param {Observable<Iterable<U>>} items
   * @param {(item: U) => K} getKey
   * @param {(item: U, getIndex: () => number) => Observable<MountableOf<T>>} render
   * @returns {Observable<MountableOf<T>>}
   */
  renderList(items, getKey, render) {
    return new Observable((subscriber) => {
      const hydration = this.#hydration;
      const hydrating = hydration ? hydration.isActive() : false;
      const container =
        hydrating && hydration ? hydration.claimContainer() : this.#createContainer();
      /** @type {Map<K, SegmentOf<T>>} */
      const childSegments = new Map();
      /** @type {Map<K, Subscription>} */
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
        const changes = childIndexesSubject.pipe(filter((changedKey) => changedKey === key));
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
              render(item, createGetIndex(item))
                .pipe(
                  distinctUntilChanged(),
                  teardown(() => {
                    const oldSegment = childSegments.get(key);
                    if (oldSegment) {
                      removeSegment(oldSegment);
                      childSegments.delete(key);
                    }
                    childSubscriptions.delete(key);
                  }),
                )
                .subscribe({
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
      /**
       * The key that ended the previous emission. The move branches below
       * put an item back in position by re-inserting its nodes, and the DOM
       * treats re-inserting a node that is already in place as a removal
       * and an insertion all the same — mutation observers hear both. An
       * item with no successor has nothing to compare its position against,
       * so without this it was re-appended on *every* emission: one phantom
       * childList mutation per emission for every list's last item, which a
       * portal answers with a portal-wide re-measure.
       *
       * @type {K | undefined}
       */
      let previousLastKey;
      const subscription = items
        .pipe(
          tap((newItems) => {
            const newItemsSet = new Set();
            const newItemsArray = Array.from(newItems);
            const lastKey = newItemsArray.length
              ? getKey(newItemsArray[newItemsArray.length - 1])
              : undefined;
            if (adopting) {
              adopting = false;
              adopt(newItemsArray);
              previousLastKey = lastKey;
              return;
            }
            for (let index = newItemsArray.length - 1; index >= 0; index -= 1) {
              const item = newItemsArray[index];
              const key = getKey(item);
              if (!childIndexes.has(key)) {
                childIndexes.set(key, index);
              }
              newItemsSet.add(key);
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
                  render(item, createGetIndex(item))
                    .pipe(
                      distinctUntilChanged(),
                      teardown(() => {
                        const oldSegment = childSegments.get(key);
                        if (oldSegment) {
                          removeSegment(oldSegment);
                          childSegments.delete(key);
                        }
                        childSubscriptions.delete(key);
                      }),
                    )
                    .subscribe({
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
              } else {
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
                  } else if (key !== previousLastKey) {
                    // No successor to sit in front of, so the item belongs at
                    // the end — where it already is, if it also ended the
                    // previous emission, in which case moving it would be a
                    // pair of mutation records saying nothing.
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
            for (const [key, childSegment] of childSegments.entries()) {
              if (!newItemsSet.has(key)) {
                removeSegment(childSegment);
                childSegments.delete(key);
              }
            }
            for (const [key, childSubscription] of childSubscriptions.entries()) {
              if (!newItemsSet.has(key)) {
                childSubscription.unsubscribe();
                childSubscriptions.delete(key);
              }
            }
            previousLastKey = lastKey;
          }),
        )
        .subscribe({
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
