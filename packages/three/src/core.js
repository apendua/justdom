import * as THREE from "three";
import { distinctUntilChanged, filter, Observable, Subject, switchMap, takeUntil } from "rxjs";
import { just } from "./operators";
import { addDependency, batch, Changes, Derived } from "@apendua.dev/signal";

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
 * @property {(parent: THREE.Object3D) => () => void} addTo
 */

/**
 * @template T
 * @param {THREE.Object3D} parent
 * @param {Observable<Iterable<T>>} items
 * @param {(item: T, index: () => number) => Observable<Component>} renderItem
 * @returns {Observable<never>}
 */
export function addDynamicToParent(parent, items, renderItem) {
  return new Observable((subscriber) => {
    /** @type {Map<T, () => void>} */
    const mountedChildEntities = new Map();
    /** @type {Map<T, import('rxjs').Subscription>} */
    const childSubscriptions = new Map();
    /** @type {Map<T, number>} */
    const childIndexes = new Map();
    /** @type {Subject<T>} */
    const childIndexesSubject = new Subject();
    /**
     * @param {T} item
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
    subscriber.add(
      items.subscribe((newItems) => {
        /** @type {Set<T>} */
        const newItemsSet = new Set();
        const newItemsArray = Array.from(newItems);
        for (let i = 0; i < newItemsArray.length; i++) {
          const item = newItemsArray[i];
          newItemsSet.add(item);
          if (!childSubscriptions.has(item)) {
            childSubscriptions.set(
              item,
              renderItem(item, createGetIndex(item))
                .pipe(distinctUntilChanged())
                .subscribe((newChildEntity) => {
                  const unmount = mountedChildEntities.get(item);
                  if (unmount) {
                    unmount();
                  }
                  if (newChildEntity) {
                    mountedChildEntities.set(item, newChildEntity.addTo(parent));
                  }
                }),
            );
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
 * @param {(item: T, index: () => number) => Observable<Component>} renderItem
 * @returns {(source: Observable<U>) => Observable<U>}
 */
export function addDynamic(items, renderItem) {
  return switchMap((parent) => {
    return just(parent).pipe(takeUntil(addDynamicToParent(parent, items, renderItem)));
  });
}

/**
 * @template T
 * @param {Observable<Iterable<T>>} items
 * @param {(item: T, index: () => number) => Observable<Component>} renderItem
 * @returns {Observable<THREE.Group<XREventMap>>}
 */
export function collection(items, renderItem) {
  return new Observable((subscriber) => {
    /** @type {THREE.Group<XREventMap>} */
    const parent = new THREE.Group();
    subscriber.add(addDynamicToParent(parent, items, renderItem).subscribe(subscriber));
    subscriber.next(parent);
  });
}
