import * as THREE from "three";
import { Observable, switchMap } from "rxjs";
import { createProperty } from "@apendua.dev/context";

/**
 * @import { XREventMap, InteractionEvent, InteractionEventType } from "./core.js";
 */

export class InteractionManager {
  /** @type {Set<THREE.Object3D<XREventMap>>} */
  #objects;
  /** @type {WeakMap<InteractionEvent, boolean>} */
  #done;

  constructor() {
    this.#objects = new Set();
    this.#done = new WeakMap();
  }

  /**
   * @param {InteractionEvent} event
   */
  stopPropagation(event) {
    this.#done.set(event, true);
  }

  /**
   * @param {THREE.Object3D<XREventMap>} object
   */
  add(object) {
    this.#objects.add(object);
  }

  /**
   * @param {THREE.Object3D<XREventMap>} object
   */
  remove(object) {
    this.#objects.delete(object);
  }

  /**
   * @param {THREE.Object3D<XREventMap>} object
   * @param {InteractionEvent & { type: InteractionEventType }} event
   */
  dispatchEvent(object, event) {
    let nextObject = object;
    do {
      object.dispatchEvent(event);
      if (this.#done.get(event)) {
        return;
      }
      // This is a little bit naive because we cannot really guarantee that
      // the parent is of the same type as the object.
      nextObject = /** @type {THREE.Object3D<XREventMap>} */ (
        nextObject.parent
      );
    } while (nextObject);
  }

  /**
   * @param {THREE.XRTargetRaySpace} controller
   * @returns {Observable<void>}
   */
  init(controller) {
    return new Observable(() => {
      /** @type {THREE.Object3D<XREventMap> | undefined} */
      let selectedObject;
      /** @type {THREE.Object3D<XREventMap> | undefined} */
      let squeezedObject;

      /**
       * @param {XREventMap['selectstart']} event
       */
      const onSelectStart = (event) => {
        const intersection = this.getIntersection(controller);
        if (intersection) {
          selectedObject = intersection.object;
          this.dispatchEvent(intersection.object, {
            type: "selectstart",
            data: event.data,
            target: event.target,
            intersection,
          });
        }
      };

      /**
       * @param {XREventMap['selectend']} event
       */

      const onSelectEnd = (event) => {
        const intersection = this.getIntersection(controller);
        if (intersection && selectedObject === intersection.object) {
          this.dispatchEvent(intersection.object, {
            type: "selectend",
            data: event.data,
            target: event.target,
            intersection,
          });
        } else if (selectedObject) {
          this.dispatchEvent(selectedObject, {
            type: "selectmissed",
            data: event.data,
            target: event.target,
          });
        }
        selectedObject = undefined;
      };

      /**
       * @param {XREventMap['squeezestart']} event
       */
      const onSqueezeStart = (event) => {
        const intersection = this.getIntersection(controller);
        if (intersection) {
          squeezedObject = intersection.object;
          this.dispatchEvent(intersection.object, {
            type: "squeezestart",
            data: event.data,
            target: event.target,
            intersection,
          });
        }
      };

      /**
       * @param {XREventMap['squeezeend']} event
       */
      const onSqueezeEnd = (event) => {
        const intersection = this.getIntersection(controller);
        if (intersection && squeezedObject === intersection.object) {
          this.dispatchEvent(intersection.object, {
            type: "squeezeend",
            data: event.data,
            target: event.target,
            intersection,
          });
        } else if (squeezedObject) {
          this.dispatchEvent(squeezedObject, {
            type: "squeezemissed",
            data: event.data,
            target: event.target,
          });
        }
        squeezedObject = undefined;
      };

      controller.addEventListener("selectstart", onSelectStart);
      controller.addEventListener("selectend", onSelectEnd);
      controller.addEventListener("squeezestart", onSqueezeStart);
      controller.addEventListener("squeezeend", onSqueezeEnd);

      return () => {
        controller.removeEventListener("selectstart", onSelectStart);
        controller.removeEventListener("selectend", onSelectEnd);
        controller.removeEventListener("squeezestart", onSqueezeStart);
        controller.removeEventListener("squeezeend", onSqueezeEnd);
      };
    });
  }

  /**
   * @param {THREE.XRTargetRaySpace} controller
   * @returns {THREE.Intersection<THREE.Object3D<XREventMap>> | undefined}
   */
  getIntersection(controller) {
    const raycaster = new THREE.Raycaster().setFromXRController(controller);
    const objects = Array.from(this.#objects);
    const intersections =
      /** @type {typeof raycaster.intersectObjects<THREE.Object3D<XREventMap>>} */ (
        raycaster.intersectObjects
      ).call(raycaster, objects);
    return intersections[0];
  }

  cleanup() {
    this.#objects.clear();
  }
}

export const InteractionContext = createProperty(
  /**
   * @returns {InteractionManager}
   */
  () => {
    throw new Error("InteractionContext not set");
  },
);

/**
 * @param {WeakKey} ctx
 * @param {InteractionEvent} event
 */
export const stopPropagation = (ctx, event) => {
  const manager = InteractionContext.get(ctx);
  manager.stopPropagation(event);
};

/**
 * @template {THREE.Object3D<XREventMap>} TEntity
 * @param {WeakKey} ctx
 * @return {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function interactive(ctx) {
  const manager = InteractionContext.get(ctx);
  return (source) => {
    return source.pipe(
      switchMap((entity) => {
        manager.add(entity);
        return new Observable((subscriber) => {
          subscriber.next(entity);
          return () => {
            manager.remove(entity);
          };
        });
      }),
    );
  };
}
