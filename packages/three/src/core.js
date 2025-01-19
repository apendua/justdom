import * as THREE from "three";
import { Observable } from "rxjs";

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
 * @template TData
 * @template TTarget
 * @typedef {object} Event
 * @property {TData} data
 * @property {TTarget} target
 * @property {THREE.Intersection<THREE.Object3D<XREventMap>>} [intersection]
 */

/**
 * @typedef {object} InteractionEventMap
 * @property {Event<XRInputSource, THREE.XRTargetRaySpace>} selectstart
 * @property {Event<XRInputSource, THREE.XRTargetRaySpace>} selectend
 * @property {Event<XRInputSource, THREE.XRTargetRaySpace>} selectmissed
 * @property {Event<XRInputSource, THREE.XRTargetRaySpace>} squeezestart
 * @property {Event<XRInputSource, THREE.XRTargetRaySpace>} squeezeend
 * @property {Event<XRInputSource, THREE.XRTargetRaySpace>} squeezemissed
 */

/**
 * @typedef {InteractionEventMap[keyof InteractionEventMap]} InteractionEvent
 */

/**
 * @typedef {keyof InteractionEventMap} InteractionEventType
 */

/**
 * @typedef {THREE.Object3DEventMap & InteractionEventMap} XREventMap
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
 * @typedef {{
 *   add: (child: T) => void;
 *   remove: (child: T) => void;
 * }} Parent
 */

/**
 * @template T
 * @param {Observable<T[]>} items
 * @param {(item: T) => Observable<THREE.Object3D<XREventMap>>} renderItem
 * @returns {Observable<THREE.Group<XREventMap>>}
 */
export function collection(items, renderItem) {
  return new Observable((subscriber) => {
    /** @type {THREE.Group<XREventMap>} */
    const groupEntity = new THREE.Group();
    /** @type {Map<T, THREE.Object3D<XREventMap>>} */
    const childEntities = new Map();
    /** @type {Map<T, import('rxjs').Subscription>} */
    const childSubscriptions = new Map();
    subscriber.add(
      items.subscribe((newItems) => {
        console.log("newItems", newItems);
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
