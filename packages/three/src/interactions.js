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
  /** @type {boolean} */
  #shouldUpdateIntersections;

  constructor() {
    this.#objects = new Set();
    this.#done = new WeakMap();
    this.#shouldUpdateIntersections = false;
  }

  /**
   * @param {InteractionEvent} event
   */
  stopPropagation(event) {
    this.#done.set(event, true);
  }

  updateIntersections() {
    this.#shouldUpdateIntersections = true;
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
      // NOTE: Object3D.dispatchEvent mutates the event by updating the target.
      nextObject.dispatchEvent(event);
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
   * @param {(fn: XRFrameRequestCallback) => Observable<never>} onAnimationFrame
   * @returns {Observable<void>}
   */
  init(controller, onAnimationFrame) {
    return new Observable(() => {
      /** @type {THREE.Object3D<XREventMap> | undefined} */
      let selectedObject;
      /** @type {THREE.Object3D<XREventMap> | undefined} */
      let squeezedObject;
      /** @type {THREE.Object3D<XREventMap> | undefined} */
      let targetedObject;

      /**
       * @param {THREE.WebXRSpaceEventMap['selectstart']} event
       */
      const onSelectStart = (event) => {
        const intersection = this.getIntersection(controller);
        const { data: inputSource } = event;
        if (intersection) {
          selectedObject = intersection.object;
          this.dispatchEvent(selectedObject, {
            type: "selectstart",
            inputSource,
            target: selectedObject,
            originalTarget: selectedObject,
            controller,
            intersection,
          });
        }
      };

      /**
       * @param {THREE.WebXRSpaceEventMap['selectend']} event
       */

      const onSelectEnd = (event) => {
        const intersection = this.getIntersection(controller);
        const { data: inputSource } = event;
        if (intersection && selectedObject === intersection.object) {
          this.dispatchEvent(intersection.object, {
            type: "selectend",
            inputSource,
            target: selectedObject,
            originalTarget: selectedObject,
            controller,
            intersection,
          });
        } else if (selectedObject) {
          this.dispatchEvent(selectedObject, {
            type: "selectmissed",
            inputSource,
            target: selectedObject,
            originalTarget: selectedObject,
            controller,
          });
        }
        selectedObject = undefined;
      };

      /**
       * @param {THREE.WebXRSpaceEventMap['squeezestart']} event
       */
      const onSqueezeStart = (event) => {
        const intersection = this.getIntersection(controller);
        const { data: inputSource } = event;
        if (intersection) {
          squeezedObject = intersection.object;
          this.dispatchEvent(intersection.object, {
            type: "squeezestart",
            inputSource,
            target: squeezedObject,
            originalTarget: squeezedObject,
            controller,
            intersection,
          });
        }
      };

      /**
       * @param {THREE.WebXRSpaceEventMap['squeezeend']} event
       */
      const onSqueezeEnd = (event) => {
        const intersection = this.getIntersection(controller);
        const { data: inputSource } = event;
        if (intersection && squeezedObject === intersection.object) {
          this.dispatchEvent(intersection.object, {
            type: "squeezeend",
            inputSource,
            target: squeezedObject,
            originalTarget: squeezedObject,
            controller,
            intersection,
          });
        } else if (squeezedObject) {
          this.dispatchEvent(squeezedObject, {
            type: "squeezemissed",
            inputSource,
            target: squeezedObject,
            originalTarget: squeezedObject,
            controller,
          });
        }
        squeezedObject = undefined;
      };

      /**
       * @param {boolean} [force]
       */
      const maybeUpdateIntersections = (force = false) => {
        if (!force && !this.#shouldUpdateIntersections) {
          return;
        }
        this.#shouldUpdateIntersections = false;
        const intersection = this.getIntersection(controller);
        if (intersection) {
          if (targetedObject === intersection.object) {
            this.dispatchEvent(targetedObject, {
              type: "pointermove",
              target: targetedObject,
              originalTarget: targetedObject,
              controller,
              intersection,
            });
          } else {
            if (targetedObject) {
              this.dispatchEvent(targetedObject, {
                type: "pointerleave",
                target: targetedObject,
                originalTarget: targetedObject,
                controller,
              });
            }
            this.dispatchEvent(intersection.object, {
              type: "pointerenter",
              target: intersection.object,
              originalTarget: intersection.object,
              controller,
              intersection,
            });
          }
          targetedObject = intersection.object;
        } else if (!intersection && targetedObject) {
          this.dispatchEvent(targetedObject, {
            type: "pointerleave",
            target: targetedObject,
            originalTarget: targetedObject,
            controller,
          });
          targetedObject = undefined;
        }
      };

      const onMove = () => {
        maybeUpdateIntersections(true);
      };

      const subscription = onAnimationFrame(() => {
        maybeUpdateIntersections();
      }).subscribe();

      controller.addEventListener("selectstart", onSelectStart);
      controller.addEventListener("selectend", onSelectEnd);
      controller.addEventListener("squeezestart", onSqueezeStart);
      controller.addEventListener("squeezeend", onSqueezeEnd);
      controller.addEventListener("move", onMove);

      return () => {
        controller.removeEventListener("selectstart", onSelectStart);
        controller.removeEventListener("selectend", onSelectEnd);
        controller.removeEventListener("squeezestart", onSqueezeStart);
        controller.removeEventListener("squeezeend", onSqueezeEnd);
        controller.removeEventListener("move", onMove);

        if (subscription) {
          subscription.unsubscribe();
        }
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
 * @param {WeakKey} ctx
 */
export const updateIntersections = (ctx) => {
  const manager = InteractionContext.get(ctx);
  manager.updateIntersections();
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
