import * as THREE from "three";
import {
  createProperty,
  Derived,
  fromObservable,
  onCleanup,
  ReactiveMap,
  Signal,
  Stream,
  withComputation,
} from "@apendua/signal";

/**
 * @import { Source, Subscribable } from "@apendua/signal";
 * @import { XREventMap, InteractionEvent, InteractionEventType, InteractionEventMap, InputEvent } from "./core.js";
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
   * Whether a handler has stopped the event: something along the way took
   * it, and it went no further.
   *
   * @param {InteractionEvent} event
   * @returns {boolean}
   */
  isStopped(event) {
    return this.#done.get(event) ?? false;
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
    this.#dispatchAlong(this.#path(object), event);
  }

  /**
   * The objects an event sent to `object` goes through: the object and its
   * parents, up to the controller.
   *
   * @param {THREE.Object3D<XREventMap>} object
   * @returns {THREE.Object3D<XREventMap>[]}
   */
  #path(object) {
    /** @type {THREE.Object3D<XREventMap>[]} */
    const path = [];
    while (object && !this.#controllers.has(object)) {
      path.push(object);
      // This is a little bit naive because we cannot really guarantee that
      // the parent is of the same type as the object.
      object = /** @type {THREE.Object3D<XREventMap>} */ (object.parent);
    }
    return path;
  }

  /**
   * Send an event along a path, or along its first `reach` objects, until
   * a handler stops it.
   *
   * @template {InteractionEventType} TEvent
   * @param {THREE.Object3D<XREventMap>[]} path
   * @param {XREventMap[TEvent] & THREE.BaseEvent<TEvent>} event
   * @param {number} [reach]
   * @returns {number} How many objects it reached, the one that stopped it
   *   included.
   */
  #dispatchAlong(path, event, reach = path.length) {
    for (let i = 0; i < reach; i += 1) {
      path[i].dispatchEvent(event);
      if (this.#done.get(event)) {
        return i + 1;
      }
    }
    return reach;
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
   * @param {() => XRInputSource | null} [inputSource] What is driving the
   *   controller, for the pointer events to carry: a press already comes
   *   with its own, a move does not. `render()` hands in the controller
   *   handle's, which is the one copy of it; without one the events say
   *   null, which is a controller under a test.
   * @returns {Source<void>}
   */
  addController(controller, onAnimationFrame, inputSource = () => null) {
    return new Stream(() => {
      /**
       * A press under way. `target` is what was pressed, as opposed to the
       * mesh the ray met (`object`), and the release is matched against it:
       * a hand that drifts from a button's label onto its background has not
       * left the button. `path` is the objects the press went through, which
       * its release has to reach, for the reason `targetedPath` gives: the
       * object pressed may have been taken out of the scene while the button
       * was held, and a walk from it would leave every pressed ancestor
       * pressed. `start` is the event the press began with, handed to the
       * events that end it.
       *
       * `reach` is how far along `path` the start went: up to and including
       * the object whose handler stopped it, or the whole path when nothing
       * did. The events that end the press go that far and no further, so
       * whatever is behind the object that took the press hears neither the
       * press nor its end. That holds for the `…end`, the completion and the
       * `…missed`, the `lost` ones included, and it holds whatever became
       * of the object since: one taken out of the scene mid-press no longer
       * listens, and its release still stops where its press did. Each of
       * them may still stop earlier, where a handler stops it, as `drag()`
       * and `carry()` stop the release of a press they took. A start that
       * nothing stops, as a panel leaves the grip's, goes on to whatever
       * takes it, and its end reaches the panel and that object both.
       *
       * @typedef {{
       *   object: THREE.Object3D<XREventMap>,
       *   target: THREE.Object3D<XREventMap> | undefined,
       *   path: THREE.Object3D<XREventMap>[],
       *   reach: number,
       *   start: InputEvent,
       * }} Press
       */
      /** @type {Press | undefined} The trigger's press, while one is held. */
      let selected;
      /** @type {Press | undefined} The grip's, as `selected` is the trigger's. */
      let squeezed;
      /** @type {THREE.Object3D<XREventMap> | undefined} */
      let targetedObject;
      /**
       * The objects the enter went through, which are the ones the leave
       * has to reach. Not walked again from `targetedObject` when the ray
       * leaves: by then the object it met may have been taken out of the
       * scene (a label re-rendered), and a walk from a detached object stops
       * at it, leaving every hovered ancestor hovered. Taken when the mesh
       * under the ray changes, not every frame.
       *
       * @type {THREE.Object3D<XREventMap>[]}
       */
      let targetedPath = [];
      /**
       * What the ray is on, as opposed to which of its meshes it met: a
       * hand drifting from a button's label onto its background has not
       * left the button, and is not told it has. Compared the way a press
       * and its release are, through `getTarget`.
       *
       * @type {THREE.Object3D<XREventMap> | undefined}
       */
      let targetedTarget;
      // The hand has to be looked at once when it arrives; after that only
      // when it moves, or when somebody says the scene changed under it.
      let shouldUpdateIntersections = true;

      const invalidate = () => {
        shouldUpdateIntersections = true;
      };

      /**
       * Begin a press of one button: the event goes along the path from the
       * mesh the ray met, and the press is remembered for its release.
       *
       * @param {"select" | "squeeze"} button
       * @param {XRInputSource} inputSource
       * @returns {Press | undefined}
       */
      const begin = (button, inputSource) => {
        const intersection = this.getIntersection(controller);
        if (!intersection) {
          return undefined;
        }
        const object = intersection.object;
        const path = this.#path(object);
        // Before the start goes out, as the path is: a handler of it may
        // change what is registered or where the object hangs, and the
        // release is matched against what was pressed, not against what
        // the press made of it.
        const target = this.getTarget(object);
        const start = {
          type: /** @type {const} */ (`${button}start`),
          inputSource,
          target: object,
          originalTarget: object,
          controller,
          intersection,
        };
        const reach = this.#dispatchAlong(path, start);
        return { object, target, path, reach, start };
      };

      /**
       * End a press of one button. Still on what was pressed, even if the ray
       * has wandered from its label to its background in the meantime, the
       * press completes: the completing event goes along the path the press
       * went through, so a click reaches the same elements that have been
       * wearing the pressed styling since the start, even if the one pressed
       * has since been re-rendered. Anywhere else, it misses. The end, the
       * completion and the miss each carry the start, and go no further
       * along the path than the start did (see `Press`). A press whose hand
       * went misses wherever the ray was left, and its end and its miss
       * say `lost`.
       *
       * @param {"select" | "squeeze"} button
       * @param {Press | undefined} press
       * @param {XRInputSource} inputSource
       * @param {boolean} [lost] Whether the hand went rather than let go.
       * @returns {void}
       */
      const end = (button, press, inputSource, lost = false) => {
        if (!press) {
          return;
        }
        const intersection = lost ? undefined : this.getIntersection(controller);
        const { object, path, reach, start } = press;
        const releasedOn = intersection && this.getTarget(intersection.object);
        this.#dispatchAlong(
          path,
          {
            type: /** @type {const} */ (`${button}end`),
            inputSource,
            target: object,
            originalTarget: object,
            controller,
            intersection,
            start,
            lost,
          },
          reach,
        );
        if (intersection && press.target && releasedOn === press.target) {
          this.#dispatchAlong(
            path,
            {
              type: button,
              inputSource,
              target: object,
              originalTarget: object,
              controller,
              intersection,
              start,
            },
            reach,
          );
        } else {
          this.#dispatchAlong(
            path,
            {
              type: /** @type {const} */ (`${button}missed`),
              inputSource,
              target: object,
              originalTarget: object,
              controller,
              start,
              lost,
            },
            reach,
          );
        }
      };

      /**
       * The ray is off what it was on: the leave goes along the path the
       * enter went through.
       *
       * @param {THREE.Object3D<XREventMap> | null} relatedTarget Where it
       *   went, or null for nothing.
       * @param {boolean} [lost] Whether it went because the hand did.
       * @returns {void}
       */
      const leave = (relatedTarget, lost = false) => {
        if (!targetedObject) {
          return;
        }
        this.#dispatchAlong(targetedPath, {
          type: "pointerleave",
          inputSource: inputSource(),
          // Set with `targetedObject`, so as defined as it is.
          registeredTarget: /** @type {THREE.Object3D<XREventMap>} */ (targetedTarget),
          relatedTarget,
          target: targetedObject,
          originalTarget: targetedObject,
          controller,
          lost,
        });
      };

      /**
       * The ray is on nothing now: the leave, and nothing targeted after it.
       *
       * @param {boolean} [lost] Whether it went because the hand did.
       * @returns {void}
       */
      const leaveForNothing = (lost = false) => {
        leave(null, lost);
        targetedObject = undefined;
        targetedTarget = undefined;
        targetedPath = [];
      };

      /**
       * @param {THREE.WebXRSpaceEventMap['selectstart']} event
       */
      const onSelectStart = (event) => {
        selected = begin("select", event.data);
      };

      /**
       * @param {THREE.WebXRSpaceEventMap['selectend']} event
       */
      const onSelectEnd = (event) => {
        const press = selected;
        selected = undefined;
        end("select", press, event.data);
      };

      /**
       * @param {THREE.WebXRSpaceEventMap['squeezestart']} event
       */
      const onSqueezeStart = (event) => {
        squeezed = begin("squeeze", event.data);
      };

      /**
       * @param {THREE.WebXRSpaceEventMap['squeezeend']} event
       */
      const onSqueezeEnd = (event) => {
        const press = squeezed;
        squeezed = undefined;
        end("squeeze", press, event.data);
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
          // Always found: the raycast meets nothing but what is under a
          // registered object.
          const target = /** @type {THREE.Object3D<XREventMap>} */ (
            this.getTarget(intersection.object)
          );
          const source = inputSource();
          if (target === targetedTarget) {
            // The same thing, whichever of its meshes the ray is on now.
            this.dispatch(intersection.object, {
              type: "pointermove",
              inputSource: source,
              registeredTarget: target,
              target: intersection.object,
              originalTarget: intersection.object,
              controller,
              intersection,
            });
          } else {
            leave(target);
            this.dispatch(intersection.object, {
              type: "pointerenter",
              inputSource: source,
              registeredTarget: target,
              relatedTarget: targetedTarget ?? null,
              target: intersection.object,
              originalTarget: intersection.object,
              controller,
              intersection,
            });
          }
          if (intersection.object !== targetedObject) {
            targetedPath = this.#path(intersection.object);
          }
          targetedObject = intersection.object;
          targetedTarget = target;
        } else if (!intersection && targetedObject) {
          leaveForNothing();
        }
      };

      /**
       * The hand has gone: three disconnected it, as it disconnects every
       * hand when a session ends, and hides its space only afterwards. No
       * release is coming, so each press it holds ends here, as a miss that
       * says `lost`, which is how `drag()` and `carry()` let go of what it
       * held and how a panel cancels its pointer. And it is on nothing any
       * more, at once: a page drawn only while presenting runs no frame
       * after its session ends, so a leave left to the next frame would
       * keep the hover until the next session.
       *
       * @param {THREE.WebXRSpaceEventMap['disconnected']} event
       */
      const onDisconnected = (event) => {
        const select = selected;
        const squeeze = squeezed;
        selected = undefined;
        squeezed = undefined;
        end("select", select, event.data, true);
        end("squeeze", squeeze, event.data, true);
        this.#setPointer(controller, undefined);
        leaveForNothing(true);
        invalidate();
      };

      // three.js fires this while updating the controller from the XR frame,
      // which is before anything has moved this frame and before world
      // matrices are recomputed — the pose it just wrote is not usable yet.
      // So only note that the ray is stale, and cast it from the frame hook.
      const onMove = invalidate;

      // Whether three is tracking the hand, as of the last frame. Going
      // either way is a reason to look again: nothing else says so, since
      // three stops sending `move` for a hand it has stopped tracking, and
      // the first `move` of one that comes back may be frames away.
      let tracked = controller.visible;
      const stopAnimating = onAnimationFrame(() => {
        if (controller.visible !== tracked) {
          tracked = controller.visible;
          invalidate();
        }
        maybeUpdateIntersections();
      });

      this.#controllers.add(controller);
      this.#invalidate.add(invalidate);

      controller.addEventListener("selectstart", onSelectStart);
      controller.addEventListener("selectend", onSelectEnd);
      controller.addEventListener("squeezestart", onSqueezeStart);
      controller.addEventListener("squeezeend", onSqueezeEnd);
      controller.addEventListener("move", onMove);
      controller.addEventListener("disconnected", onDisconnected);

      return () => {
        controller.removeEventListener("disconnected", onDisconnected);
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
   * What the controller's ray meets first, of everything registered and
   * drawn, or nothing.
   *
   * **A hand three is not tracking points at nothing**, wherever its space
   * was left. three hides the target ray space of a controller that has not
   * connected yet, one that has disconnected — every one of them, when a
   * session ends — and one whose pose it lost this frame, and what it hides
   * keeps the pose it last had. Casting from it would publish a hit and draw
   * a cursor for a hand that is not there, and a press three still reports
   * for it — a trigger pulled with the hand behind the back, or under the
   * system menu — would land on whatever the stale ray met. Every cast comes
   * through here, the hover's and the presses' alike, so the rule is kept
   * here once.
   *
   * @param {THREE.XRTargetRaySpace} controller
   * @returns {THREE.Intersection<THREE.Object3D<XREventMap>> | undefined}
   */
  getIntersection(controller) {
    if (!controller.visible) {
      return undefined;
    }
    // One ray and one list for every cast, since a cast runs every frame a
    // hand moves; only the hit handed back is new.
    const raycaster = _raycaster.setFromXRController(controller);
    const intersections = _intersections;
    intersections.length = 0;
    for (const object of this.#objects) {
      if (!this.#castsOwnWalk(object)) {
        continue;
      }
      intersectVisible(raycaster, object, intersections);
    }
    intersections.sort(byDistance);
    const hit = intersections[0];
    intersections.length = 0;
    return hit;
  }

  /**
   * Whether a registered object is cast from itself: drawn, and not under
   * another registered object. One walk up the parents answers both.
   *
   * Drawn, because `intersectVisible` reads `visible` from the registered
   * object downwards and cannot see what is above it. The registration set
   * is flat, so a scene that hides a whole card the way the renderer
   * expects, one flag on the group it hangs off, used to hide it from the
   * draw and from nothing else: the buttons and the backing plane a
   * projected panel registers for itself went on answering rays.
   *
   * Not under another registered object, because that one's walk recurses
   * every child and prunes on the same `visible` flags, so it already meets
   * every mesh below. A clickable `<g>` around clickable shapes, or a button
   * around an icon, would otherwise cast each of them once per registration
   * above it. The hits are the same set without the duplicates, and
   * `getTarget` still resolves each to the innermost registered object.
   *
   * @param {THREE.Object3D<XREventMap>} object
   * @returns {boolean}
   */
  #castsOwnWalk(object) {
    for (let node = object.parent; node; node = node.parent) {
      if (!node.visible || this.#objects.has(/** @type {THREE.Object3D<XREventMap>} */ (node))) {
        return false;
      }
    }
    return true;
  }

  cleanup() {
    this.#objects.clear();
    this.#pointers.clear();
  }
}

/** Scratch for `getIntersection`. */
const _raycaster = new THREE.Raycaster();
/** @type {THREE.Intersection<THREE.Object3D<XREventMap>>[]} */
const _intersections = [];

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
 * promises when it drops a hidden row's registration. The manager's
 * `#castsOwnWalk` is the other half of the same contract, for what hangs
 * over a registered object rather than under it.
 *
 * @param {THREE.Raycaster} raycaster
 * @param {THREE.Object3D<XREventMap>} object
 * @param {THREE.Intersection<THREE.Object3D<XREventMap>>[]} intersections
 * @returns {void}
 */
export function intersectVisible(raycaster, object, intersections) {
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
export function asReader(value) {
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
 * @property {(event: InteractionEvent) => boolean} isStopped Whether a
 *   handler has stopped the event.
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
    isStopped: (event) => manager.isStopped(event),
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

/** Scratch for `setWorldMatrix`, which a carry calls once a frame. */
const _local = new THREE.Matrix4();

/**
 * Put an object at a world matrix: one walk up the ancestors, for the
 * parent's world matrix that turns it into a local one. `matrix` is left as
 * it was, and nothing is allocated, so it is fit for a frame callback.
 *
 * @param {THREE.Object3D} object
 * @param {THREE.Matrix4} matrix
 */
export function setWorldMatrix(object, matrix) {
  const { parent } = object;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    setLocalMatrix(object, _local.copy(parent.matrixWorld).invert().multiply(matrix));
  } else {
    setLocalMatrix(object, matrix);
  }
}
