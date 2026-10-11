import { Signal } from "@apendua/signal";

/**
 * @import { XRTargetRaySpace } from "three";
 * @import { DragButton, InputEvent, InputCancelEvent, PressEnd } from "./core.js";
 * @import { InteractionManager } from "./interactions.js";
 */

/**
 * @typedef {object} HeldBy
 * @property {XRTargetRaySpace} controller
 * @property {DragButton} button
 */

/**
 * @template {HeldBy} H
 * @typedef {object} HandHold
 * @property {Signal<H | null>} held The hand holding the object, and the
 *   button it holds with, or null while nobody is.
 * @property {(event: InputEvent) => void} take Take a press: it goes no
 *   further, and neither will the release that ends it.
 * @property {(event: InputCancelEvent & PressEnd, button: DragButton) => H | null} release
 *   Hear a release. One that ends a press `take` took goes no further. If it
 *   is the holding hand's release of the button it holds with, it is the one
 *   that ends the hold, and the hold is handed back for the caller to end;
 *   otherwise null. `held` is the caller's to clear, so a `drag()` can send
 *   its `dragend` while `held()` still says the hand.
 */

/**
 * What `drag()` and `carry()` keep about a hand holding an object, and the
 * rule both follow for the presses they take.
 *
 * A press taken here goes no further, so the release that ends it goes no
 * further either: whatever is behind hears both or neither. That is decided
 * by the press, not by whether the object is held or enabled when the
 * release comes. A carry is put down when it is disabled, and a drag may be
 * enabled again while a press it refused is still held, and in both the
 * release still belongs to its press. The manager hands every release its
 * press's start (`PressEnd`), which is what is looked up. It is looked up
 * in a set of the starts taken here, and not asked of the manager
 * (`isStopped`): a handler inside the object may have stopped the start and
 * let its release through, and stopped is not stopped by this hold.
 *
 * The rule holds while the object, or a carry's handle, is in the scene. One
 * taken out mid-press no longer listens, and the manager sends the release
 * along the path it recorded at the press, on to whatever is behind.
 *
 * Only the holding hand's release, of the button it holds with, ends the
 * hold. A handover moves the hold to another hand, and the first hand's
 * release then ends nothing.
 *
 * @template {HeldBy} H
 * @param {InteractionManager} manager
 * @returns {HandHold<H>}
 */
export function createHold(manager) {
  const held = Signal.of(/** @type {H | null} */ (null));
  /** @type {WeakSet<InputEvent>} */
  const taken = new WeakSet();
  return {
    held,
    take(event) {
      manager.stopPropagation(event);
      taken.add(event);
    },
    release(event, button) {
      if (!taken.has(event.start)) {
        return null;
      }
      manager.stopPropagation(event);
      const current = held.get();
      return current && current.controller === event.controller && current.button === button
        ? current
        : null;
    },
  };
}
