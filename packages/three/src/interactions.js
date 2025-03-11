import * as THREE from "three";
import { Observable, switchMap } from "rxjs";
import { createProperty } from "@apendua.dev/context";

/**
 * @import { XREventMap, InteractionEvent, InteractionEventType, InteractionEventMap } from "./core.js";
 */

export class InteractionManager {
  /** @type {Set<THREE.Object3D<XREventMap>>} */
  #objects;
  /** @type {WeakMap<InteractionEvent, boolean>} */
  #done;
  /** @type {boolean} */
  #shouldUpdateIntersections;
  /** @type {Set<THREE.Object3D<any>>} */
  #controllers;

  constructor() {
    this.#objects = new Set();
    this.#done = new WeakMap();
    this.#shouldUpdateIntersections = false;
    this.#controllers = new Set();
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
   * @template {InteractionEventType} TEvent
   * @param {THREE.Object3D<XREventMap>} object
   * @param {XREventMap[TEvent] & THREE.BaseEvent<TEvent>} event
   */
  dispatch(object, event) {
    /** @type {THREE.Object3D<XREventMap>[]} */
    const allTargets = [];
    while (object && !this.#controllers.has(object)) {
      allTargets.push(object);
      // This is a little bit naive because we cannot really guarantee that
      // the parent is of the same type as the object.
      object = /** @type {THREE.Object3D<XREventMap>} */ (object.parent);
    }
    for (const target of allTargets) {
      target.dispatchEvent(event);
      if (this.#done.get(event)) {
        return;
      }
    }
  }

  /**
   * @param {THREE.XRTargetRaySpace} controller
   * @param {(fn: XRFrameRequestCallback) => Observable<never>} onAnimationFrame
   * @returns {Observable<void>}
   */
  addController(controller, onAnimationFrame) {
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
          this.dispatch(selectedObject, {
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
          this.dispatch(selectedObject, {
            type: "selectend",
            inputSource,
            target: selectedObject,
            originalTarget: selectedObject,
            controller,
          });
          this.dispatch(selectedObject, {
            type: "select",
            inputSource,
            target: selectedObject,
            originalTarget: selectedObject,
            controller,
            intersection,
          });
        } else if (selectedObject) {
          this.dispatch(selectedObject, {
            type: "selectend",
            inputSource,
            target: selectedObject,
            originalTarget: selectedObject,
            controller,
          });
          this.dispatch(selectedObject, {
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
          this.dispatch(intersection.object, {
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
          this.dispatch(squeezedObject, {
            type: "squeezeend",
            inputSource,
            target: squeezedObject,
            originalTarget: squeezedObject,
            controller,
          });
          this.dispatch(squeezedObject, {
            type: "squeeze",
            inputSource,
            target: squeezedObject,
            originalTarget: squeezedObject,
            controller,
            intersection,
          });
        } else if (squeezedObject) {
          this.dispatch(squeezedObject, {
            type: "squeezeend",
            inputSource,
            target: squeezedObject,
            originalTarget: squeezedObject,
            controller,
          });
          this.dispatch(squeezedObject, {
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
            this.dispatch(targetedObject, {
              type: "pointermove",
              target: targetedObject,
              originalTarget: targetedObject,
              controller,
              intersection,
            });
          } else {
            if (targetedObject) {
              this.dispatch(targetedObject, {
                type: "pointerleave",
                target: targetedObject,
                originalTarget: targetedObject,
                controller,
              });
            }
            this.dispatch(intersection.object, {
              type: "pointerenter",
              target: intersection.object,
              originalTarget: intersection.object,
              controller,
              intersection,
            });
          }
          targetedObject = intersection.object;
        } else if (!intersection && targetedObject) {
          this.dispatch(targetedObject, {
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

      this.#controllers.add(controller);

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
