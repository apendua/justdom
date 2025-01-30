import {
  distinctUntilChanged,
  Observable,
  ReplaySubject,
  share,
  switchMap,
} from "rxjs";
import {
  moveSegmentBefore,
  removeSegment,
  replaceSegment,
  toSegment,
} from "./helpers.js";

/**
 * @import { Subscriber, Subscription } from "rxjs";
 */

/**
 * @typedef {boolean | number | string | null | undefined} Primitive
 */

/**
 * @template X
 * @template Y
 * @template [A=X]
 * @template [B=never]
 * @typedef {(
 *   (<T>() => T extends X ? 1 : 2) extends
 *   (<T>() => T extends Y ? 1 : 2) ? A : B
 * )} IfEquals
 */

/**
 * @template {object} T
 * @typedef {{
 *   [P in keyof T as IfEquals<{ [Q in P]: T[P] }, { -readonly [Q in P]: T[P] },
 *   T[P] extends (...args: any[]) => any ? never : P>]?: T[P] extends (...args: any[]) => any ? never : T[P];
 * }} WritableProps
 */

/**
 * @template E
 * @typedef {(e: E) => void} Handler
 */

/**
 * @template {object} EventMap
 * @typedef {{
 *   addEventListener: <K extends keyof EventMap>(type: K, listener: Handler<EventMap[K]>) => void;
 *   removeEventListener: <K extends keyof EventMap>(type: K, listener: Handler<EventMap[K]>) => void;
 * }} EventListener
 */

/**
 * @template T
 * @param {() => void} [fn]
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function teardown(fn) {
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
 * @template T
 * @param {(entity: T) => Observable<unknown>} fn
 * @param {(entity: T) => () => void} [onTeardown]
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function effect(fn, onTeardown) {
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        return new Observable((subscriber) => {
          subscriber.add(
            fn(entity)
              .pipe(teardown(onTeardown?.(entity)))
              .subscribe({
                error: (error) => {
                  subscriber.error(error);
                },
              }),
          );
          subscriber.next(entity);
        });
      }),
    );
  };
}

/**
 * @template T
 * @param {T} value
 * @returns {Observable<T>}
 */
export function just(value) {
  return new Observable((subscriber) => {
    subscriber.next(value);
  });
}

/**
 * @template T
 * @returns {(source: Observable<T>) => Observable<T>}
 */
export function shared() {
  return share({
    connector: () => new ReplaySubject(1),
  });
}

/**
 * Creates a document fragment observable from child observables.
 * @param {Array<Observable<Node | null>>} children - The child observables.
 * @returns {Observable<DocumentFragment>} An observable that emits a DocumentFragment.
 */
export function fragment(...children) {
  return new Observable((subscriber) => {
    /** @type {Map<number, [Node, Node]>} */
    const segments = new Map();
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < children.length; i++) {
      const node = fragment.appendChild(document.createComment(""));
      segments.set(i, toSegment(node));
    }

    children.forEach((child, i) => {
      subscriber.add(
        child
          .pipe(
            distinctUntilChanged(),
            teardown(() => {
              const oldSegment = segments.get(i);
              if (oldSegment) {
                removeSegment(oldSegment);
                segments.delete(i);
              }
            }),
          )
          .subscribe({
            next: (newNode) => {
              const oldSegment = segments.get(i);
              if (oldSegment) {
                segments.set(i, replaceSegment(newNode, oldSegment));
              }
            },
            error: (error) => {
              subscriber.error(error);
            },
          }),
      );
    });

    subscriber.next(fragment);
    return () => {
      // TODO: I think this one is unnecessary. Let's use some tests
      //       to confirm it and remove it if it's not needed.
      for (const segment of segments.values()) {
        removeSegment(segment);
      }
    };
  });
}

/**
 * Creates a list observable from an array of items and a render function.
 * @template T
 * @param {Observable<T[]>} items
 * @param {(item: T) => Observable<Exclude<Node, DocumentFragment>>} renderItem
 * @returns {Observable<DocumentFragment>}
 */
export function collection(items, renderItem) {
  return new Observable((subscriber) => {
    const fragment = document.createDocumentFragment();
    const listEnd = fragment.appendChild(document.createComment("LIST END"));
    /** @type {Map<T, [Node, Node]>} */
    const childSegments = new Map();
    /** @type {Map<T, Subscription>} */
    const childSubscriptions = new Map();
    subscriber.add(
      items.subscribe((newItems) => {
        for (let index = newItems.length - 1; index >= 0; index -= 1) {
          const item = newItems[index];
          let nextSegment;
          let i = index + 1;
          while (!nextSegment && i < newItems.length) {
            nextSegment = childSegments.get(newItems[i]);
            i += 1;
          }
          if (!childSegments.has(item)) {
            // NOTE: Only put placeholder where the new item should be inserted. The actual element
            //       will be inserted by the subscription.
            const nextNode = nextSegment?.[0] ?? listEnd;
            const { parentNode } = nextNode;
            if (parentNode) {
              const newComment = parentNode.insertBefore(
                document.createComment(""),
                nextNode,
              );
              childSegments.set(item, toSegment(newComment));
            }
          }
          if (!childSubscriptions.has(item)) {
            childSubscriptions.set(
              item,
              renderItem(item)
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
                  next: (newNode) => {
                    const oldSegment = childSegments.get(item);
                    if (oldSegment) {
                      childSegments.set(
                        item,
                        replaceSegment(newNode, oldSegment),
                      );
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
                if (
                  childSegment &&
                  childSegment[1].nextSibling !== nextSegment[0]
                ) {
                  moveSegmentBefore(childSegment, nextSegment[0]);
                }
              } else {
                moveSegmentBefore(childSegment, listEnd);
              }
            }
          }
        }
        const newItemsSet = new Set(newItems);
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
    );
    subscriber.next(fragment);
    return () => {
      for (const subscription of childSubscriptions.values()) {
        subscription.unsubscribe();
      }
    };
  });
}
