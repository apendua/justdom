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
 *   Hear a release. One that ends a press `take` took goes no further. It
 *   ends the hold if it is the holding hand's release of the button it holds
 *   with, and then the hold is what it hands back; otherwise null.
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
 * press's start (`PressEnd`), which is what is looked up.
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
