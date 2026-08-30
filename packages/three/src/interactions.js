import * as THREE from "three";
import { Observable } from "rxjs";
import {
  createProperty,
  Derived,
  fromObservable,
  onCleanup,
  ReactiveMap,
  Signal,
  withComputation,
} from "@apendua/signal";

/**
 * @import { Subscribable } from "@apendua/signal";
 * @import { XREventMap, InteractionEvent, InteractionEventType, InteractionEventMap } from "./core.js";
 */

/**
 * Where a controller's ray currently lands, for every controller that is
 * pointing at something interactive. Keyed by target ray space, so a two
 * handed player has two entries; a hand that points at nothing has none.
 *
 * @typedef {ReactiveMap<
 *   THREE.XRTargetRaySpace,
 *   Signal<THREE.Intersection<THREE.Object3D<XREventMap>>>
 * >} Pointers
 */

/**
 * A value that may be supplied as a constant, as a reactive getter — anything
 * `observable()` can track — or as an observable that is subscribed to directly.
 *
 * @template T
 * @typedef {T | (() => T) | Subscribable<T>} Reactive
 */

export class InteractionManager {
  /** @type {Set<THREE.Object3D<XREventMap>>} */
  #objects;
  /** @type {WeakMap<InteractionEvent, boolean>} */
  #done;
  /**
   * One per controller: marks that hand's intersection as due for another
   * look. Per controller rather than a single flag, so that two hands do not
   * race for it and leave one of them stuck on a stale hit.
   *
   * @type {Set<() => void>}
   */
  #invalidate;
  /** @type {Set<THREE.Object3D<any>>} */
  #controllers;
  /** @type {Pointers} */
  #pointers;

  constructor() {
    this.#objects = new Set();
    this.#done = new WeakMap();
    this.#invalidate = new Set();
    this.#controllers = new Set();
    this.#pointers = new ReactiveMap();
  }

  /**
   * The live hit of every controller that is aiming at something. The manager
   * already raycasts once per controller per update to route pointer events,
   * so this is that same result, published instead of thrown away.
   *
   * @returns {Pointers}
   */
  get pointers() {
    return this.#pointers;
  }

  /**
   * @param {THREE.XRTargetRaySpace} controller
   * @param {THREE.Intersection<THREE.Object3D<XREventMap>> | undefined} intersection
   */
  #setPointer(controller, intersection) {
    // Reading the map registers a reactive dependency, and this runs from the
    // animation loop — that is, from inside somebody else's computation.
    // Detaching first keeps that computation from subscribing to writes it
    // makes itself on the very next frame.
    withComputation(null, () => {
      const pointer = this.#pointers.get(controller);
      if (!intersection) {
        this.#pointers.delete(controller);
      } else if (pointer) {
        pointer.set(intersection);
      } else {
        this.#pointers.set(controller, Signal.of(intersection));
      }
    });
  }

  /**
   * @param {InteractionEvent} event
   */
  stopPropagation(event) {
    this.#done.set(event, true);
  }

  /**
   * Ask for every hand's intersection to be worked out again on the next
   * frame. Worth calling after something moves the scene in a way no
   * controller motion would account for.
   */
  updateIntersections() {
    for (const invalidate of this.#invalidate) {
      invalidate();
    }
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
   * The registered object a hit belongs to.
   *
   * A raycast lands on whichever mesh the ray actually met, and that is rarely
   * the thing anybody registered: a projected button is a background quad and
   * a quad of text, both descendants of the object that carries the handlers.
   * Which of the two the ray happened to touch is not a distinction a player
   * makes, so anywhere a press has to be matched against a release, they are
   * compared by this rather than by the mesh.
   *
   * @param {THREE.Object3D<XREventMap> | undefined} object
   * @returns {THREE.Object3D<XREventMap> | undefined}
   */
  getTarget(object) {
    /** @type {THREE.Object3D<XREventMap> | null | undefined} */
    let node = object;
    while (node) {
      if (this.#objects.has(node)) {
        return node;
      }
      node = /** @type {THREE.Object3D<XREventMap> | null} */ (node.parent);
    }
    return undefined;
  }

  /**
   * @param {THREE.XRTargetRaySpace} controller
   * @param {(fn: XRFrameRequestCallback) => () => void} onAnimationFrame
   *   Puts the callback on the frame loop and hands back the way off again. It
   *   must run late — after everything that moves the scene, with world
   *   matrices already up to date — because that is when the ray is worked out.
   * @returns {Observable<void>}
   */
  addController(controller, onAnimationFrame) {
    return new Observable(() => {
      /** @type {THREE.Object3D<XREventMap> | undefined} */
      let selectedObject;
      /**
       * What was pressed, as opposed to which of its meshes the ray met. The
       * release is matched against this: a hand that drifts from a button's
       * label onto its background has not left the button.
       *
       * @type {THREE.Object3D<XREventMap> | undefined}
       */
      let selectedTarget;
      /** @type {THREE.Object3D<XREventMap> | undefined} */
      let squeezedObject;
      /** @type {THREE.Object3D<XREventMap> | undefined} */
      let squeezedTarget;
      /** @type {THREE.Object3D<XREventMap> | undefined} */
      let targetedObject;
      // The hand has to be looked at once when it arrives; after that only
      // when it moves, or when somebody says the scene changed under it.
      let shouldUpdateIntersections = true;

      const invalidate = () => {
        shouldUpdateIntersections = true;
      };

      /**
       * @param {THREE.WebXRSpaceEventMap['selectstart']} event
       */
      const onSelectStart = (event) => {
        const intersection = this.getIntersection(controller);
        const { data: inputSource } = event;
        if (intersection) {
          selectedObject = intersection.object;
          selectedTarget = this.getTarget(selectedObject);
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
        // Still on what was pressed, even if the ray has wandered from its
        // label to its background in the meantime. `select` is dispatched from
        // the mesh the press landed on, so the click reaches the same element
        // that has been wearing the pressed styling since `selectstart`.
        const releasedOn = intersection && this.getTarget(intersection.object);
        if (intersection && selectedObject && selectedTarget && releasedOn === selectedTarget) {
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
        selectedTarget = undefined;
      };

      /**
       * @param {THREE.WebXRSpaceEventMap['squeezestart']} event
       */
      const onSqueezeStart = (event) => {
        const intersection = this.getIntersection(controller);
        const { data: inputSource } = event;
        if (intersection) {
          squeezedObject = intersection.object;
          squeezedTarget = this.getTarget(squeezedObject);
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
        // Matched by what was grabbed rather than by which of its meshes the
        // ray met, for the same reason a press and its release are.
        const releasedOn = intersection && this.getTarget(intersection.object);
        if (intersection && squeezedObject && squeezedTarget && releasedOn === squeezedTarget) {
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
        squeezedTarget = undefined;
      };

      const maybeUpdateIntersections = () => {
        if (!shouldUpdateIntersections) {
          return;
        }
        shouldUpdateIntersections = false;
        const intersection = this.getIntersection(controller);
        // Publish the hit before the handlers run: where the ray landed is a
        // fact about this frame, not something a listener gets to veto.
        this.#setPointer(controller, intersection);
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

      // three.js fires this while updating the controller from the XR frame,
      // which is before anything has moved this frame and before world
      // matrices are recomputed — the pose it just wrote is not usable yet.
      // So only note that the ray is stale, and cast it from the frame hook.
      const onMove = invalidate;

      const stopAnimating = onAnimationFrame(() => {
        maybeUpdateIntersections();
      });

      this.#controllers.add(controller);
      this.#invalidate.add(invalidate);

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

        this.#controllers.delete(controller);
        this.#invalidate.delete(invalidate);
        this.#pointers.delete(controller);

        stopAnimating();
      };
    });
  }

  /**
   * @param {THREE.XRTargetRaySpace} controller
   * @returns {THREE.Intersection<THREE.Object3D<XREventMap>> | undefined}
   */
  getIntersection(controller) {
    const raycaster = new THREE.Raycaster().setFromXRController(controller);
    /** @type {THREE.Intersection<THREE.Object3D<XREventMap>>[]} */
    const intersections = [];
    for (const object of this.#objects) {
      intersectVisible(raycaster, object, intersections);
    }
    intersections.sort(byDistance);
    return intersections[0];
  }

  cleanup() {
    this.#objects.clear();
    this.#pointers.clear();
  }
}

/**
 * @param {{ distance: number }} a
 * @param {{ distance: number }} b
 * @returns {number}
 */
function byDistance(a, b) {
  return a.distance - b.distance;
}

/**
 * Three's own `intersectObjects` recursion, minus the one thing it refuses
 * to consult: `visible`. The raycaster deliberately ignores visibility — a
 * defensible default for a scene tool — but here it made every hidden row
 * of a scrolled list a full ray test: a registered scroller is raycast as a
 * subtree, and a 500-row list paid five hundred inverse-matrix transforms
 * per controller per frame to hit nothing anyone could see. The mirror's
 * contract is the renderer's: an object culled out of the draw is out of
 * the raycast, and its subtree with it — which is what `div()` already
 * promises when it drops a hidden row's registration.
 *
 * @param {THREE.Raycaster} raycaster
 * @param {THREE.Object3D<XREventMap>} object
 * @param {THREE.Intersection<THREE.Object3D<XREventMap>>[]} intersections
 * @returns {void}
 */
function intersectVisible(raycaster, object, intersections) {
  if (!object.visible) {
    return;
  }
  if (object.layers.test(raycaster.layers)) {
    object.raycast(raycaster, intersections);
  }
  for (const child of object.children) {
    intersectVisible(raycaster, /** @type {THREE.Object3D<XREventMap>} */ (child), intersections);
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
 * Whether a value is a source rather than a value.
 *
 * Structural on purpose: `instanceof Observable` was the test until the
 * package's own sources stopped being RxJS observables, and it would have gone
 * on compiling while quietly reclassifying every one of them as a constant.
 * What the caller is allowed to pass is a `Subscribable` — something with a
 * `subscribe` — so that is what gets asked.
 *
 * @param {unknown} value
 * @returns {value is Subscribable<any>}
 */
function isSubscribable(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (/** @type {{ subscribe?: unknown }} */ (value).subscribe) === "function"
  );
}

/**
 * Normalizes the three accepted shapes of a reactive value into a tracked
 * reader. A `Derived` in front of the function form for its equality cutoff —
 * the `distinctUntilChanged` this used to route through — and `fromObservable`
 * for the observable form, whose "no value yet" reads as `NoValueError` and
 * makes a reading effect wait, exactly as a source that has not emitted did.
 *
 * @template T
 * @param {Reactive<T>} value
 * @returns {() => T}
 */
function asReader(value) {
  if (isSubscribable(value)) {
    const source = fromObservable(value);
    return () => source.get();
  }
  if (typeof value === "function") {
    const source = new Derived(/** @type {() => T} */ (value));
    return () => source.get();
  }
  return () => value;
}

/**
 * @typedef {object} Interactions
 * @property {(event: InteractionEvent) => void} stopPropagation
 * @property {<TEntity extends THREE.Object3D<XREventMap>>(enabled?: Reactive<boolean>) => import("@apendua/signal").EntityEffect<TEntity>} makeInteractive
 */

/**
 * @param {WeakKey} ctx
 * @return {Interactions}
 */
export function interactions(ctx) {
  const manager = InteractionContext.get(ctx);
  return {
    stopPropagation: (event) => {
      manager.stopPropagation(event);
    },
    /**
     * Registers the entity with the interaction manager for as long as the
     * operator stays subscribed. With no argument the entity is interactive the
     * whole time; pass a boolean, a reactive getter, or an observable to turn
     * interactivity on and off while the entity itself stays in the scene.
     *
     * The entity is always passed downstream — `enabled` decides whether rays
     * can hit it, not whether it exists.
     */
    makeInteractive: (enabled = true) => {
      const isEnabled = asReader(enabled);
      return (entity) => {
        if (!isEnabled()) {
          return;
        }
        manager.add(entity);
        onCleanup(() => {
          manager.remove(entity);
        });
      };
    },
  };
}

/**
 * @param {THREE.Object3D} object
 * @param {THREE.Matrix4} matrix
 */
export function setLocalMatrix(object, matrix) {
  matrix.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrix();
}

/**
 * @param {THREE.Object3D} object
 * @param {THREE.Matrix4} matrix
 */
export function setWorldMatrix(object, matrix) {
  const { parent } = object;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    setLocalMatrix(object, parent.matrixWorld.clone().invert().multiply(matrix));
  } else {
    setLocalMatrix(object, matrix);
  }
}
