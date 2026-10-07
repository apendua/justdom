import { Signal, makeNonReactive, onCleanup, useEffect, withComputation } from "@apendua/signal";
import { asReader, InteractionContext, setLocalMatrix } from "./interactions.js";
import { useFrame } from "./render.js";

/**
 * @import { EntityEffect } from "@apendua/signal";
 * @import { Matrix4, Object3D, XRTargetRaySpace } from "three";
 * @import { DragButton, InputEvent, InputCancelEvent, PressEnd, XREventMap } from "./core.js";
 * @import { Reactive } from "./interactions.js";
 */

/**
 * The hand holding the object: which controller, the input source driving it
 * — its gamepad is where a thumbstick is read from — and the button it is
 * holding with. A drag can change hands, so all three can change over its
 * life; what stays the same is the object and where it came from.
 *
 * @typedef {object} Hold
 * @property {XRTargetRaySpace} controller
 * @property {XRInputSource} inputSource
 * @property {DragButton} button
 */

/**
 * @typedef {object} DragOptions
 * @property {DragButton[]} [buttons] Which buttons pick the object up: the
 *   trigger (`select`), the grip (`squeeze`), or both. The trigger alone
 *   unless given. The event says which one it was, so a scene that means
 *   something different by each — a move and a copy, say — can tell.
 * @property {Reactive<boolean>} [enabled] Whether a press can pick the object
 *   up right now — a boolean, a reactive getter, or an observable, as
 *   `makeInteractive` takes. It gates picking up and taking over; a drag
 *   already under way always runs to its release.
 */

/**
 * @typedef {object} Drag
 * @property {<T extends Object3D<XREventMap>>() => EntityEffect<T>} draggable
 *   The operator that makes the object carriable, for its operator list.
 * @property {() => Hold | null} held The hand holding the object, or null
 *   while nobody is. Reactive: read it inside an effect and the effect
 *   re-runs as the object is picked up, handed over, and let go.
 */

/**
 * Where the object was before it was picked up, so it can be put back.
 *
 * @typedef {object} Origin
 * @property {Object3D} parent
 * @property {Matrix4} matrix
 */

/**
 * Picking an object up and carrying it about with a hand.
 *
 * The object is reparented onto the controller that pressed on it, so the
 * hand's own movement is what moves it, and put back under its original
 * parent — where it is in the room, not where it was — on the release. For as
 * long as it is held it dispatches `dragmove` once a frame with its world
 * matrix, and `dragstart` and `dragend` around that, so the scene it belongs
 * to can decide what the pose means: a cell to snap to, a preview to show, a
 * drop to refuse. The events go to the object itself; listen with
 * `on("dragend", …)` in the same operator list.
 *
 * Two things the bookkeeping is here for, because every scene that did it by
 * hand got at least one of them wrong at some point:
 *
 * - **It remembers which hand, not merely that it is held.** A press from the
 *   other hand while the object is carried is a handover — the object moves
 *   to that hand, and the drag carries on, one `dragstart` and one `dragend`
 *   for the whole of it. Only the holding hand's release, of the button it is
 *   holding with, ends the drag; the first hand letting go of an object it no
 *   longer holds changes nothing. The same hand pressing its other button
 *   changes nothing either.
 * - **It swallows the presses it takes.** A press that picks the object up,
 *   and the release that lets it go, do not reach whatever is behind — the
 *   board the object sits on, the tray it was pulled off — so picking up a
 *   brick never also picks up the board.
 *
 * One `drag()` per object: the hold is the object's. Interactivity is not
 * part of it — an object that can be pointed at without being carriable is
 * common — so `makeInteractive()` goes in the same list. Taking the object out
 * of the scene mid-drag takes it off the hand too. A hand that disconnects
 * mid-drag lets go where it is: the manager ends its press with a `lost`
 * release, which this hears as any other.
 *
 * ```js
 * const { draggable, held } = drag(ctx, { enabled: () => props.movable });
 * $(mesh, [
 *   makeInteractive(),
 *   draggable(),
 *   effects((o) => {
 *     if (!held()) {
 *       o.position.copy(props.position); // the props place it whenever a hand does not
 *     }
 *   }),
 *   on("dragend", (event) => {
 *     board.drop(event.matrixWorld, event.reset);
 *   }),
 * ]);
 * ```
 *
 * @param {WeakKey} ctx
 * @param {DragOptions} [options]
 * @returns {Drag}
 */
export function drag(ctx, options = {}) {
  const { buttons = ["select"], enabled = true } = options;
  const manager = InteractionContext.get(ctx);
  const isEnabled = asReader(enabled);
  /** @type {Signal<Hold | null>} */
  const hold = Signal.of(/** @type {Hold | null} */ (null));
  /** @type {Origin | null} */
  let origin = null;

  const take = makeNonReactive(
    /**
     * @param {Object3D<XREventMap>} object
     * @param {InputEvent} event
     * @param {DragButton} button
     */
    (object, event, button) => {
      if (!isEnabled()) {
        return;
      }
      manager.stopPropagation(event);
      const { controller, inputSource } = event;
      const current = hold.get();
      if (current) {
        if (current.controller === controller) {
          // Already holding it, with the other button.
          return;
        }
        // The other hand taking hold is a handover: the object moves to the
        // new hand mid-drag and still remembers where it came from.
        hold.set({ controller, inputSource, button });
        controller.attach(object);
        return;
      }
      const { parent } = object;
      if (!parent) {
        return;
      }
      origin = { parent, matrix: object.matrix.clone() };
      const matrixWorld = object.matrixWorld.clone();
      hold.set({ controller, inputSource, button });
      controller.attach(object);
      object.dispatchEvent({
        type: "dragstart",
        target: object,
        controller,
        inputSource,
        button,
        matrixWorld,
      });
    },
  );

  const release = makeNonReactive(
    /**
     * @param {Object3D<XREventMap>} object
     * @param {InputCancelEvent & PressEnd} event
     * @param {DragButton} button
     */
    (object, event, button) => {
      const current = hold.get();
      if (!current) {
        // Not held — but the press that this releases was swallowed above
        // while it was carriable, so the release is swallowed too rather than
        // reaching whatever is behind as a release it never saw the press of.
        if (isEnabled()) {
          manager.stopPropagation(event);
        }
        return;
      }
      manager.stopPropagation(event);
      if (current.controller !== event.controller || current.button !== button) {
        // Released by a hand, or a button, that is not the one holding it.
        return;
      }
      // Where the object ended up is read while it is still on the hand; the
      // drag is over once it is back under its own parent, so that whatever
      // places it from its props can do so again on this very frame.
      const matrixWorld = object.matrixWorld.clone();
      const home = origin;
      origin = null;
      if (home) {
        home.parent.attach(object);
      }
      object.dispatchEvent({
        type: "dragend",
        target: object,
        ...current,
        matrixWorld,
        reset: () => {
          if (home) {
            setLocalMatrix(object, home.matrix);
          }
        },
      });
      hold.set(null);
    },
  );

  /**
   * @template {Object3D<XREventMap>} T
   * @returns {EntityEffect<T>}
   */
  const draggable = () => (object) => {
    for (const button of buttons) {
      const start = /** @type {"selectstart" | "squeezestart"} */ (`${button}start`);
      const end = /** @type {"selectend" | "squeezeend"} */ (`${button}end`);
      /** @param {InputEvent} event */
      const onStart = (event) => take(object, event, button);
      /** @param {InputCancelEvent & PressEnd} event */
      const onEnd = (event) => release(object, event, button);
      object.addEventListener(start, onStart);
      object.addEventListener(end, onEnd);
      onCleanup(() => {
        object.removeEventListener(start, onStart);
        object.removeEventListener(end, onEnd);
      });
    }
    useEffect(
      () => {
        const current = hold.get();
        if (!current) {
          return;
        }
        // One event for the hold, sent again every frame: its matrix is the
        // object's own, live, and nothing else in it changes until the hold
        // does, which runs this again.
        const move = /** @type {const} */ ({
          type: "dragmove",
          target: object,
          ...current,
          matrixWorld: object.matrixWorld,
        });
        useFrame(ctx, () => {
          // Detached from the frame's own computation, so that whatever the
          // listeners read does not subscribe the frame loop to it.
          withComputation(null, () => {
            object.dispatchEvent(move);
          });
        });
      },
      { name: "dragmove" },
    );
    onCleanup(() => {
      // Taken out of the scene while held. Whoever mounted it takes it off the
      // parent it was mounted on, which is not the hand it is on now, so it
      // leaves the hand here — the alternative is an object that stays on the
      // controller for the rest of the session.
      if (withComputation(null, () => hold.get())) {
        object.removeFromParent();
        origin = null;
        hold.set(null);
      }
    });
  };

  return {
    draggable,
    held: () => hold.get(),
  };
}
