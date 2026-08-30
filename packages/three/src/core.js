import { filtered, just, observable, Stream, Subject } from "@apendua/signal";
import { addDependency, batch, Derived } from "@apendua/signal";

/**
 * @import { Source, Subscribable, Unsubscribable } from "@apendua/signal";
 * @import { Object3D, XRTargetRaySpace, Intersection, Object3DEventMap } from 'three';
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
 * @template X
 * @template A
 * @template [B=never]
 * @typedef {(
 *   X extends (...args: any[]) => any ? A : B
 * )} IfFunction
 */

/**
 * @template {object} T
 * @typedef {{
 *   [P in keyof T as IfEquals<{ [Q in P]: T[P] }, { -readonly [Q in P]: T[P] },
 *   IfFunction<T[P], never, P>>]?: IfFunction<T[P], never, T[P]>;
 * }} WritableProps
 */

/**
 * @template {object} T
 * @typedef {{
 *    [P in keyof T as T[P] extends { copy: (x: T[P]) => void } ? P : never]?: T[P];
 *  }} CopyableProps
 */

/**
 * @typedef {object} InputEvent
 * @property {XRInputSource} inputSource
 * @property {Object3D<XREventMap>} target
 * @property {Object3D<XREventMap>} originalTarget
 * @property {XRTargetRaySpace} controller
 * @property {Intersection<Object3D<XREventMap>>} intersection
 */

/**
 * @typedef {object} InputCancelEvent
 * @property {XRInputSource} inputSource
 * @property {Object3D<XREventMap>} target
 * @property {Object3D<XREventMap>} originalTarget
 * @property {XRTargetRaySpace} controller
 */

/**
 * @typedef {object} PointerEvent
 * @property {Object3D<XREventMap>} target
 * @property {Object3D<XREventMap>} originalTarget
 * @property {XRTargetRaySpace} controller
 * @property {Intersection<Object3D<XREventMap>>} intersection
 */

/**
 * @typedef {object} PointerCancelEvent
 * @property {Object3D<XREventMap>} target
 * @property {Object3D<XREventMap>} originalTarget
 * @property {XRTargetRaySpace} controller
 */

/**
 * @template TTarget
 * @typedef {object} SimpleEvent
 * @property {TTarget} target
 * @property {Intersection<Object3D<XREventMap>>} [intersection]
 */

/**
 * @typedef {object} InteractionEventMap
 * @property {InputEvent} selectstart
 * @property {InputCancelEvent} selectend
 * @property {InputEvent} select
 * @property {InputCancelEvent} selectmissed
 * @property {InputEvent} squeezestart
 * @property {InputCancelEvent} squeezeend
 * @property {InputEvent} squeeze
 * @property {InputCancelEvent} squeezemissed
 * @property {PointerEvent} pointermove
 * @property {PointerEvent} pointerenter
 * @property {PointerCancelEvent} pointerleave
 */

/**
 * @typedef {InteractionEventMap[keyof InteractionEventMap]} InteractionEvent
 */

/**
 * @typedef {keyof InteractionEventMap} InteractionEventType
 */

/**
 * @typedef {Object3DEventMap & InteractionEventMap} XREventMap
 */

/**
 * @template E
 * @typedef {(e: E) => void} Handler
 */

/**
 * @template T
 * @typedef {{
 *   add: (child: T) => void;
 *   remove: (child: T) => void;
 * }} Parent
 */

/**
 * @typedef {object} Component
 * @property {(parent: Object3D) => () => void} addTo
 */

/**
 * A DOM tree that has not been put anywhere yet: what `@apendua/justdom`
 * builds and what a portal mounts.
 *
 * A *segment* is the pair of sibling nodes a tree spans — its first and its
 * last, which may be the same node — and `replace` swaps whatever currently
 * occupies that span for this tree's own nodes, handing back the span they
 * now occupy. That one method is the entire protocol between the two
 * packages, which is why it is written out here rather than imported: this
 * is `justdom`'s `Mountable` to the letter, TypeScript compares the two
 * structurally, and `freedom` therefore describes its own signatures without
 * depending on `justdom` at all. Pass a justdom tree to `dom()` exactly as
 * before.
 *
 * @typedef {object} Mountable
 * @property {(segment: [first: Node, last: Node]) => [first: Node, last: Node]} replace
 */

/**
 * @template T
 * @template K
 * @param {Object3D} parent
 * @param {Subscribable<Iterable<T>>} items
 * @param {(item: T) => K} getKey
 * @param {(item: T, index: () => number) => Subscribable<Component>} renderItem
 * @returns {Source<never>}
 */
export function addDynamicToParent(parent, items, getKey, renderItem) {
  return new Stream((subscriber) => {
    /** @type {Map<K, () => void>} */
    const mountedChildEntities = new Map();
    /** @type {Map<K, Unsubscribable>} */
    const childSubscriptions = new Map();
    /** @type {Map<K, number>} */
    const childIndexes = new Map();
    /** @type {Subject<K>} */
    const childIndexesSubject = new Subject();
    /**
     * @param {T} item
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
    subscriber.add(
      items.subscribe({
        next: (newItems) => {
          /** @type {Set<K>} */
          const newItemsSet = new Set();
          const newItemsArray = Array.from(newItems);
          for (let i = 0; i < newItemsArray.length; i++) {
            const item = newItemsArray[i];
            const key = getKey(item);
            if (!childIndexes.has(key)) {
              childIndexes.set(key, i);
            }
            newItemsSet.add(key);
            if (!childSubscriptions.has(key)) {
              childSubscriptions.set(
                key,
                // No `distinctUntilChanged`: a node-backed child already stops
                // at the value it was holding, and every other one hands back a
                // freshly built component per emission.
                renderItem(item, createGetIndex(item)).subscribe({
                  next: (newChildEntity) => {
                    const unmount = mountedChildEntities.get(key);
                    if (unmount) {
                      unmount();
                    }
                    if (newChildEntity) {
                      mountedChildEntities.set(key, newChildEntity.addTo(parent));
                    }
                  },
                }),
              );
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
              const unmount = mountedChildEntities.get(key);
              if (unmount) {
                unmount();
                mountedChildEntities.delete(key);
              }
              childSubscription.unsubscribe();
              childSubscriptions.delete(key);
            }
          }
        },
      }),
    );
    return () => {
      for (const subscription of childSubscriptions.values()) {
        subscription.unsubscribe();
      }
      for (const unmount of mountedChildEntities.values()) {
        unmount();
      }
    };
  });
}

/**
 * @template T
 * @param {Subscribable<T> | (() => T)} value
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
 * @param {(item: T, index: () => number) => Subscribable<Component>} renderItem
 * @returns {Source<Component>}
 */
export function list(items, renderItem) {
  items = normalize(items);
  return just({
    addTo: (parent) => {
      const subscription = addDynamicToParent(
        parent,
        items,
        (item) => item,
        renderItem,
      ).subscribe();
      return () => {
        subscription.unsubscribe();
      };
    },
  });
}

/**
 * @template K
 * @template T
 * @param {Subscribable<Iterable<[K, T]>> | (() => Iterable<[K, T]>)} items
 * @param {(item: T, key: K, index: () => number) => Subscribable<Component>} renderItem
 * @returns {Source<Component>}
 */
export function keyedList(items, renderItem) {
  items = normalize(items);
  return just({
    addTo: (parent) => {
      const subscription = addDynamicToParent(
        parent,
        items,
        (item) => item[0],
        (item, index) => renderItem(item[1], item[0], index),
      ).subscribe();
      return () => {
        subscription.unsubscribe();
      };
    },
  });
}
