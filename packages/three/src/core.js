import * as THREE from "three";
import { Observable } from "rxjs";

/**
 * @import { Subscriber, Subscription } from "rxjs";
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
 * @template {object} T
 * @typedef {{
 *    [P in keyof T as T[P] extends { copy: (x: T[P]) => void } ? P : never]?: T[P];
 *  }} CopyableProps
 */

/**
 * @param {Subscriber<unknown>} subscriber
 * @param {Record<string, Observable<unknown>>} dictionary
 * @param {(key: string, value: unknown) => void} fn
 */
export function watchAll(subscriber, dictionary, fn) {
  for (const key of Object.keys(dictionary)) {
    subscriber.add(
      dictionary[key].subscribe({
        next: (value) => fn(key, value),
      }),
    );
  }
}

/**
 * Subscribes to child observables and appends them to the parent object.
 * @param {Subscriber<unknown>} subscriber
 * @param {THREE.Object3D} object
 * @param {Array<Observable<THREE.Object3D>>} children
 */
export function subscribeChildren(subscriber, object, children) {
  /** @type {Map<number, THREE.Object3D>} */
  const childEntities = new Map();
  for (const [index, child] of children.entries()) {
    subscriber.add(
      child.subscribe((newChildEntity) => {
        const oldChildEntity = childEntities.get(index);
        if (!newChildEntity) {
          if (oldChildEntity) {
            object.remove(oldChildEntity);
            childEntities.delete(index);
          }
        } else {
          if (oldChildEntity) {
            if (oldChildEntity !== newChildEntity) {
              object.remove(oldChildEntity);
              object.add(newChildEntity);
            }
          } else {
            object.add(newChildEntity);
          }
          childEntities.set(index, newChildEntity);
        }
      }),
    );
  }
}

/**
 * Creates a group observable from an array of items and a render function.
 * @template T
 * @param {Observable<T[]>} items - An observable of items.
 * @param {(item: T) => Observable<THREE.Object3D>} renderItem
 * @returns {Observable<THREE.Group>}
 */
export function collection(items, renderItem) {
  return new Observable((subscriber) => {
    const groupEntity = new THREE.Group();
    /** @type {Map<T, THREE.Object3D>} */
    const childEntities = new Map();
    /** @type {Map<T, Subscription>} */
    const childSubscriptions = new Map();
    subscriber.add(
      items.subscribe((newItems) => {
        for (let index = 0; index < newItems.length; index += 1) {
          const item = newItems[index];
          if (!childSubscriptions.has(item)) {
            childSubscriptions.set(
              item,
              renderItem(item).subscribe((newChildEntity) => {
                const oldChildEntity = childEntities.get(item);
                if (oldChildEntity) {
                  groupEntity.remove(oldChildEntity);
                } else {
                  groupEntity.add(newChildEntity);
                }
                childEntities.set(item, newChildEntity);
              }),
            );
          }
        }
        const newItemsSet = new Set(newItems);
        for (const [item, childSubscription] of childSubscriptions.entries()) {
          if (!newItemsSet.has(item)) {
            const childEntity = childEntities.get(item);
            if (childEntity) {
              groupEntity.remove(childEntity);
              childEntities.delete(item);
            }
            childSubscription.unsubscribe();
            childSubscriptions.delete(item);
          }
        }
      }),
    );
    subscriber.next(groupEntity);
    return () => {
      for (const subscription of childSubscriptions.values()) {
        subscription.unsubscribe();
      }
    };
  });
}
