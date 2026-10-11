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
 *   further, and the manager sends the release that ends it no further
 *   either.
 * @property {(event: InputCancelEvent & PressEnd, button: DragButton) => H | null} release
 *   Hear a release. If it is the holding hand's release of the button it
 *   holds with, it is the one that ends the hold: it is stopped, and the
 *   hold is handed back for the caller to end. Otherwise null, and the
 *   release is left to go as far as its press did. `held` is the caller's to
 *   clear, so a `drag()` can send its `dragend` while `held()` still says
 *   the hand.
 */

/**
 * What `drag()` and `carry()` keep about a hand holding an object, and the
 * rule both follow for the presses they take.
 *
 * A press taken here goes no further, so the release that ends it goes no
 * further either: whatever is behind hears both or neither. The manager
 * keeps that rule, not this hold: it sends a press's release only as far
 * along the press's path as the start went (`Press` in `interactions.js`).
 * So it is decided by the press, not by whether the object is held or
 * enabled when the release comes, and it holds for an object, or a carry's
 * handle, taken out of the scene mid-press, which no longer listens. A carry
 * is put down when it is disabled, and a drag may be enabled again while a
 * press it refused is still held, and in both the release still belongs to
 * its press.
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
  return {
    held,
    take(event) {
      manager.stopPropagation(event);
    },
    release(event, button) {
      const current = held.get();
      if (!current || current.controller !== event.controller || current.button !== button) {
        return null;
      }
      manager.stopPropagation(event);
      return current;
    },
  };
}
