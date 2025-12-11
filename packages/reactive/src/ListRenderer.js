import { distinctUntilChanged, filter, Observable, Subject, tap } from "rxjs";
import { removeSegment, toSegment } from "./helpers.js";
import { addDependency, batch, Changes, Derived } from "@apendua.dev/signal";

/**
 * @import { Subscription } from "rxjs";
 * @import { Segment, INode, Mountable, Container } from "./types.js"
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
 * @template {INode<T>} T
 * @typedef {object} ListRendererOptions
 * @property {() => Container<T>} createContainer
 * @property {() => T} createPlaceholder
 */

/**
 * @template {INode<T>} T
 */
export default class ListRenderer {
  /** @type {() => Container<T>} */
  #createContainer;
  /** @type {() => T} */
  #createPlaceholder;

  /**
   * @param {ListRendererOptions<T>} options
   */
  constructor(options) {
    this.#createContainer = options.createContainer;
    this.#createPlaceholder = options.createPlaceholder;
  }

  /**
   * Creates a document fragment observable from child observables.
   * @param {Array<Observable<Mountable<T>>>} children
   * @returns {Observable<Mountable<T>>}
   */
  renderFragment(children) {
    return new Observable((subscriber) => {
      /** @type {Map<number, Segment<T>>} */
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
   * @param {Observable<Iterable<U>>} items
   * @param {(item: U, getIndex: () => number) => Observable<Mountable<T>>} render
   * @returns {Observable<Mountable<T>>}
   */
  renderList(items, render) {
    return new Observable((subscriber) => {
      const container = this.#createContainer();
      /** @type {Map<U, Segment<T>>} */
      const childSegments = new Map();
      /** @type {Map<U, Subscription>} */
      const childSubscriptions = new Map();
      /** @type {Map<U, number>} */
      const childIndexes = new Map();
      /** @type {Subject<U>} */
      const childIndexesSubject = new Subject();
      /**
       * @param {U} item
       * @returns {() => number}
       */
      const createGetIndex = (item) => {
        const changes = new Changes(
          childIndexesSubject.pipe(filter((changedItem) => changedItem === item)),
        );
        const index = new Derived(() => {
          addDependency(changes);
          return childIndexes.get(item) ?? -1;
        });
        return () => index.get();
      };
      const subscription = items
        .pipe(
          tap((newItems) => {
            const newItemsSet = new Set(newItems);
            const newItemsArray = Array.from(newItems);
            for (let index = newItemsArray.length - 1; index >= 0; index -= 1) {
              const item = newItemsArray[index];
              if (!childIndexes.has(item)) {
                childIndexes.set(item, index);
              }
              let nextSegment;
              let i = index + 1;
              while (!nextSegment && i < newItemsArray.length) {
                nextSegment = childSegments.get(newItemsArray[i]);
                i += 1;
              }
              if (!childSegments.has(item)) {
                // NOTE: Only put placeholder where the new item should be inserted. The actual element
                //       will be inserted by the subscription.
                if (!nextSegment) {
                  const newPlaceholder = container.appendChild(this.#createPlaceholder());
                  childSegments.set(item, toSegment(newPlaceholder));
                } else {
                  const nextNode = nextSegment[0];
                  const { parentNode } = nextNode;
                  if (parentNode) {
                    const newPlaceholder = parentNode.insertBefore(
                      this.#createPlaceholder(),
                      nextNode,
                    );
                    childSegments.set(item, toSegment(newPlaceholder));
                  }
                }
              }
              if (!childSubscriptions.has(item)) {
                childSubscriptions.set(
                  item,
                  render(item, createGetIndex(item))
                    .pipe(
                      distinctUntilChanged(),
                      teardown(() => {
                        const oldSegment = childSegments.get(item);
                        if (oldSegment) {
                          removeSegment(oldSegment);
                          childSegments.delete(item);
                        }
                        childSubscriptions.delete(item);
                      }),
                    )
                    .subscribe({
                      next: (newMountable) => {
                        const oldSegment = childSegments.get(item);
                        if (oldSegment) {
                          childSegments.set(item, newMountable.replace(oldSegment));
                        }
                      },
                      error: (error) => {
                        subscriber.error(error);
                      },
                    }),
                );
              } else {
                const childSegment = childSegments.get(item);
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
                if (childIndexes.get(item) !== i) {
                  childIndexes.set(item, i);
                  childIndexesSubject.next(item);
                }
              }
              for (const item of childSubscriptions.keys()) {
                if (!newItemsSet.has(item)) {
                  childIndexes.delete(item);
                  childIndexesSubject.next(item);
                }
              }
            });
            for (const [item, childSegment] of childSegments.entries()) {
              if (!newItemsSet.has(item)) {
                removeSegment(childSegment);
                childSegments.delete(item);
              }
            }
            for (const [item, childSubscription] of childSubscriptions.entries()) {
              if (!newItemsSet.has(item)) {
                childSubscription.unsubscribe();
                childSubscriptions.delete(item);
              }
            }
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
