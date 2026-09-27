import * as THREE from "three";
import { Effect, Signal, withChannel, withComputation } from "@apendua/signal";
import { getBorderBoxSize } from "./mirror.js";
import { place } from "./place.js";
import { moveCaretToEnd, typeIntoInput } from "./typing.js";
import { touchValue } from "./textInput.js";

/**
 * @import {Subscribable} from '@apendua/signal';
 * @import {Mountable} from '../core.js';
 * @import {InputFocus} from './textInput.js';
 * @import {KeyPress} from './typing.js';
 */

/**
 * The keyboard a panel offers its text fields.
 *
 * A headset has nothing to type with, and the keyboard the system offers is
 * chrome — the compositor's, not the page's — so none of it reaches a
 * projected field. What can reach one is a board of ordinary boxes, each a
 * ray target, mirrored by a portal of its own; `@apendua/justui` has such a
 * board, and an app may have another. This package has none, and does not
 * want a dependency on one, so what the portal takes is a factory: given the
 * field, hand back the DOM of a keyboard wired to type into it. Everything
 * else — when it appears, where it hangs, what typing means, when it goes —
 * is decided here, so that every panel with fields in it behaves the same.
 *
 * It appears when a field is pressed, hangs below the panel and reclined
 * toward the hands like a phone on a stand, types into the field through
 * `typeIntoInput`, and goes on `Enter`, on `Escape`, on a press on the
 * panel's own background, when the field leaves the document, and with the
 * panel. While it is up the field carries `data-xr-focus`, which a
 * stylesheet may use the way it uses `:focus` — presentationally, exactly
 * as `data-xr-hover`.
 */

/**
 * The field a keyboard is built for, and what it is handed to reach it:
 * `onKey` does to the field what the key would have done and closes the
 * board on the keys that end an entry; `dismiss` closes it for any other
 * reason a board might have — a "done" key of its own, say.
 *
 * @typedef {object} KeyboardTarget
 * @property {HTMLInputElement} element
 * @property {(press: KeyPress) => void} onKey
 * @property {() => void} dismiss
 */

/**
 * @typedef {object} PortalKeyboardOptions
 * @property {(target: KeyboardTarget) => Subscribable<Mountable>} create
 *   Build the keyboard's DOM for a field: a justdom tree, or anything with
 *   the `Mountable` shape, typically `keyboard(...)` from `@apendua/justui`
 *   dressed in the panel's own classes and handed `target.onKey`. Called
 *   when a field is pressed; the tree is mounted into a portal of its own
 *   and taken down when the board goes.
 * @property {number} [gap] The room between the panel's bottom edge and the
 *   board's top edge, in the panel's px. 12 by default.
 * @property {number} [tilt] How far the board is reclined toward the viewer,
 *   in radians, hinged at its top edge. 24° by default; 0 leaves it in the
 *   panel's plane.
 */

/**
 * The attribute a field carries while the keyboard is typing into it.
 */
export const FOCUS_ATTRIBUTE = "data-xr-focus";

const DEFAULT_GAP = 12;
const DEFAULT_TILT = (24 * Math.PI) / 180;

/**
 * @typedef {object} PortalKeyboardDeps
 * @property {WeakKey} ctx The context the panel was built from, before it
 *   derived its own — the board is a panel of its own, with batches of its
 *   own, and must not see the panel's.
 * @property {PortalKeyboardOptions} options
 * @property {THREE.Object3D} containerObject The panel's perimeter. The
 *   board hangs off the same parent, so it is placed and scaled with the
 *   panel.
 * @property {HTMLElement} containerElement The panel's DOM root, whose size
 *   says where the panel's bottom edge is.
 * @property {number} scale The panel's units per px — what `placeContainer`
 *   scales the container by — so the board's offsets, worked out in px, land
 *   in the parent's frame.
 * @property {(fn: () => void, name: string) => Effect} placeEffect Build an
 *   effect in the panel's own channel, so the board is moved with the
 *   panel's other writes rather than ahead of them.
 * @property {(ctx: WeakKey, options: object) => {
 *   addTo: (parent: THREE.Object3D) => void,
 *   mount: (mountable: Mountable) => void,
 *   disconnect: () => void,
 *   size: () => { width: number, height: number },
 * }} createPortal The portal factory, handed in rather than imported: the
 *   portal imports this.
 */

/**
 * @param {PortalKeyboardDeps} deps
 */
export function createPortalKeyboard({
  ctx,
  options,
  containerObject,
  containerElement,
  scale,
  placeEffect,
  createPortal,
}) {
  const { create, gap = DEFAULT_GAP, tilt = DEFAULT_TILT } = options;

  /**
   * The field being typed into, or null while the board is down.
   *
   * @type {Signal<HTMLInputElement | null>}
   */
  const target = Signal.of(null);

  const dismiss = () => {
    target.set(null);
  };

  // In the default channel, like the pump's own watch: a press writes the
  // target, and the board has to come up on that write's flush, not on a
  // frame the panel's channel happens to be pumped on.
  const board = withChannel(
    null,
    () =>
      new Effect(
        () => {
          const element = target.get();
          if (!element) {
            return;
          }
          const parent = containerObject.parent;
          if (!parent) {
            // A panel not in the scene has nowhere to hang a board.
            return;
          }
          // The construction is not this effect's to track: the portal it
          // builds and the tree the factory builds read what they read for
          // themselves, and a dependency taken here would rebuild the board
          // on the next keystroke.
          return withComputation(null, () => {
            element.setAttribute(FOCUS_ATTRIBUTE, "");
            // As tapping a field on a phone does, and said to the mirror,
            // which draws the caret from the selection.
            moveCaretToEnd(element);
            touchValue(element);

            // The hinge, at the panel's bottom edge; and under it the drop
            // that puts the board's top edge at the hinge, the board's own
            // container centring itself on its origin as every panel does.
            const pivot = new THREE.Group();
            const drop = new THREE.Group();
            pivot.add(drop);
            parent.add(pivot);

            const panel = createPortal(ctx, {
              opaqueToRays: true,
              // A board that has been asked for is wanted now, and it comes
              // up under a panel that is already there; a frame standing in
              // for it would be one more thing to look at.
              loadingFrame: false,
            });
            panel.addTo(drop);

            const dismissIfCurrent = () => {
              if (target.peek() === element) {
                dismiss();
              }
            };
            /** @param {KeyPress} press */
            const onKey = (press) => {
              typeIntoInput(element, press);
              if (press.key === "Enter" || press.key === "Escape") {
                dismissIfCurrent();
              }
            };
            const subscription = create({ element, onKey, dismiss: dismissIfCurrent }).subscribe({
              next: (mountable) => {
                panel.mount(mountable);
              },
            });

            const placement = placeEffect(() => {
              const panelSize = getBorderBoxSize(containerElement);
              const boardSize = panel.size();
              pivot.rotation.set(-tilt, 0, 0);
              place(pivot, 0, -(panelSize.height / 2 + gap) * scale, 0);
              place(drop, 0, -(boardSize.height / 2) * scale, 0);
            }, "portal-keyboard-place");

            return () => {
              placement.dispose();
              subscription.unsubscribe();
              panel.disconnect();
              parent.remove(pivot);
              element.removeAttribute(FOCUS_ATTRIBUTE);
            };
          });
        },
        { name: "portal-keyboard" },
      ),
  );

  /** @type {InputFocus} */
  const focus = {
    isFocused: (element) => target.get() === element,
    press: (element) => {
      target.set(element);
    },
  };

  return {
    focus,
    dismiss,
    /**
     * A node has left the panel. If it is the field being typed into, the
     * board has nothing to type into any more.
     *
     * @param {Node} node
     */
    released(node) {
      if (target.peek() === node) {
        dismiss();
      }
    },
    dispose() {
      board.dispose();
    },
  };
}
