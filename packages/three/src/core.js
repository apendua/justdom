import * as THREE from "three";
import { distinctUntilChanged, Observable, switchMap, takeUntil } from "rxjs";
import { just } from "./operators";

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
 * @property {THREE.Object3D<XREventMap>} target
 * @property {THREE.Object3D<XREventMap>} originalTarget
 * @property {THREE.XRTargetRaySpace} controller
 * @property {THREE.Intersection<THREE.Object3D<XREventMap>>} intersection
 */

/**
 * @typedef {object} InputCancelEvent
 * @property {XRInputSource} inputSource
 * @property {THREE.Object3D<XREventMap>} target
 * @property {THREE.Object3D<XREventMap>} originalTarget
 * @property {THREE.XRTargetRaySpace} controller
 */

/**
 * @typedef {object} PointerEvent
 * @property {THREE.Object3D<XREventMap>} target
 * @property {THREE.Object3D<XREventMap>} originalTarget
 * @property {THREE.XRTargetRaySpace} controller
 * @property {THREE.Intersection<THREE.Object3D<XREventMap>>} intersection
 */

/**
 * @typedef {object} PointerCancelEvent
 * @property {THREE.Object3D<XREventMap>} target
 * @property {THREE.Object3D<XREventMap>} originalTarget
 * @property {THREE.XRTargetRaySpace} controller
 */

/**
 * @template TTarget
 * @typedef {object} SimpleEvent
 * @property {TTarget} target
 * @property {THREE.Intersection<THREE.Object3D<XREventMap>>} [intersection]
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
 * @typedef {object} Component
 * @property {(parent: THREE.Object3D) => () => void} mount
 */

/**
 * @template T
 * @param {THREE.Object3D} parent
 * @param {Observable<Iterable<T>>} items
 * @param {(item: T) => Observable<Component>} renderItem
 * @returns {Observable<never>}
 */
export function addToParent(parent, items, renderItem) {
  return new Observable((subscriber) => {
    /** @type {Map<T, () => void>} */
    const mountedChildEntities = new Map();
    /** @type {Map<T, import('rxjs').Subscription>} */
    const childSubscriptions = new Map();
    subscriber.add(
      items.subscribe((newItems) => {
        /** @type {Set<T>} */
        const newItemsSet = new Set();
        for (const item of newItems) {
          newItemsSet.add(item);
          if (!childSubscriptions.has(item)) {
            childSubscriptions.set(
              item,
              renderItem(item)
                .pipe(distinctUntilChanged())
                .subscribe((newChildEntity) => {
                  const unmount = mountedChildEntities.get(item);
                  if (unmount) {
                    unmount();
                  }
                  if (newChildEntity) {
                    mountedChildEntities.set(
                      item,
                      newChildEntity.mount(parent),
                    );
                  }
                }),
            );
          }
        }
        for (const [item, childSubscription] of childSubscriptions.entries()) {
          if (!newItemsSet.has(item)) {
            const unmount = mountedChildEntities.get(item);
            if (unmount) {
              unmount();
              mountedChildEntities.delete(item);
            }
            childSubscription.unsubscribe();
            childSubscriptions.delete(item);
          }
        }
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
 * @template {THREE.Object3D} U
 * @param {Observable<Iterable<T>>} items
 * @param {(item: T) => Observable<Component>} renderItem
 * @returns {(source: Observable<U>) => Observable<U>}
 */
export function addDynamic(items, renderItem) {
  return switchMap((parent) => {
    return just(parent).pipe(takeUntil(addToParent(parent, items, renderItem)));
  });
}

/**
 * @template T
 * @param {Observable<Iterable<T>>} items
 * @param {(item: T) => Observable<Component>} renderItem
 * @returns {Observable<THREE.Group<XREventMap>>}
 */
export function collection(items, renderItem) {
  return new Observable((subscriber) => {
    /** @type {THREE.Group<XREventMap>} */
    const parent = new THREE.Group();
    subscriber.add(
      addToParent(parent, items, renderItem).subscribe(subscriber),
    );
    subscriber.next(parent);
  });
}
