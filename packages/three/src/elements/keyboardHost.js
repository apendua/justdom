import * as THREE from "three";
import { Signal, withComputation } from "@apendua/signal";
import { getBorderBoxSize } from "./mirror.js";
import { place } from "./place.js";
import { moveCaretToEnd, typeIntoInput } from "./typing.js";
import { touchValue } from "./textInput.js";

/**
 * @import {Effect, Unsubscribable} from '@apendua/signal';
 * @import {Mountable} from '../core.js';
 * @import {KeyPress} from './typing.js';
 * @import {KeyboardTarget, PortalKeyboardOptions} from './portalKeyboard.js';
 */

/**
 * The one keyboard a scene types with.
 *
 * A scene may have many panels with fields in them, and a player has one
 * pair of hands: whichever field was pressed last is the one being typed
 * into, whatever panel it is in. So the board is not a panel's but the
 * scene's. Pressing a field in another panel moves the typing there; the
 * board stays up, and is only built again if that panel asks for a
 * different board — a different `create`. Everything a panel still decides
 * for itself it hands over through a `KeyboardBinding`: which factory, how
 * the board hangs, and the frame to hang it in.
 *
 * The board comes and goes imperatively, from the press and the dismissal
 * themselves, rather than from an effect over the target. A panel taken
 * down has to take its board down with it before `disconnect` returns, and
 * a press wants the board in the same turn; an effect would do both a
 * flush later.
 */

/**
 * The attribute a field carries while the keyboard is typing into it.
 */
export const FOCUS_ATTRIBUTE = "data-xr-focus";

const DEFAULT_GAP = 12;
const DEFAULT_TILT = (24 * Math.PI) / 180;

/**
 * What a panel tells the host about itself when one of its fields is
 * pressed.
 *
 * @typedef {object} KeyboardBinding
 * @property {PortalKeyboardOptions} options The panel's keyboard, its own
 *   options laid over the scene's.
 * @property {WeakKey} ctx What the board is built from: the context the
 *   panel was built from, before it derived its own, and without the
 *   scene's panel options — the board is a panel of its own, with batches
 *   of its own, and none of the app's defaults.
 * @property {THREE.Object3D} containerObject The panel's perimeter. The
 *   board hangs off the same parent, so it is placed and scaled with the
 *   panel.
 * @property {HTMLElement} containerElement The panel's DOM root, whose size
 *   says where the panel's bottom edge is.
 * @property {number} scale The panel's units per px, so the board's
 *   offsets, worked out in px, land in the parent's frame.
 * @property {(fn: () => void, name: string) => Effect} placeEffect Build an
 *   effect in the panel's own channel, so the board is moved with the
 *   panel's other writes rather than ahead of them.
 */

/**
 * @typedef {object} KeyboardFocus
 * @property {HTMLInputElement} element
 * @property {KeyboardBinding} binding
 */

/**
 * @typedef {object} KeyboardHost
 * @property {() => HTMLInputElement | null} field The field being typed
 *   into, or null while the board is down. Reactive.
 * @property {(element: HTMLInputElement, binding: KeyboardBinding) => void} focus
 *   A field was pressed: type into it, bringing the board up if it is not.
 * @property {() => void} dismiss Put the board away.
 * @property {(node: Node) => void} release A node has left its panel; if it
 *   is the field being typed into, the board goes.
 * @property {(binding: KeyboardBinding) => void} unbind A panel is going; if
 *   the field being typed into is one of its, the board goes with it.
 * @property {() => void} dispose
 */

/**
 * The board while it is up: what built it, and what to take down.
 *
 * @typedef {object} Board
 * @property {PortalKeyboardOptions["create"]} create
 * @property {ReturnType<CreatePortal>} panel
 * @property {Unsubscribable} subscription
 * @property {THREE.Group} pivot The hinge, at the panel's bottom edge.
 * @property {THREE.Group} drop Under the hinge, the drop that puts the
 *   board's top edge at it.
 * @property {KeyboardBinding | null} attachedTo
 * @property {Effect | null} placement
 */

/**
 * @typedef {(ctx: WeakKey, options: object) => {
 *   addTo: (parent: THREE.Object3D) => void,
 *   mount: (mountable: Mountable) => void,
 *   disconnect: () => void,
 *   size: () => { width: number, height: number },
 * }} CreatePortal
 */

/**
 * @param {object} deps
 * @param {CreatePortal} deps.createPortal The portal factory, handed in
 *   rather than imported: the portal imports this.
 * @returns {KeyboardHost}
 */
export function createKeyboardHost({ createPortal }) {
  /** @type {Signal<KeyboardFocus | null>} */
  const target = Signal.of(/** @type {KeyboardFocus | null} */ (null));

  /** @type {Board | null} */
  let board = null;

  /** @param {KeyPress} press */
  const onKey = (press) => {
    const current = target.peek();
    if (!current) {
      return;
    }
    typeIntoInput(current.element, press);
    if (press.key === "Enter" || press.key === "Escape") {
      dismiss();
    }
  };

  /**
   * Take the board down, leaving the target as it is.
   */
  function closeBoard() {
    if (!board) {
      return;
    }
    const { panel, subscription, pivot, placement } = board;
    board = null;
    placement?.dispose();
    subscription.unsubscribe();
    panel.disconnect();
    pivot.removeFromParent();
  }

  /**
   * @param {KeyboardFocus} focus
   * @returns {Board}
   */
  function buildBoard({ element, binding }) {
    const pivot = new THREE.Group();
    const drop = new THREE.Group();
    pivot.add(drop);

    const panel = createPortal(binding.ctx, {
      opaqueToRays: true,
      // A board that has been asked for is wanted now, and it comes up
      // under a panel that is already there; a frame standing in for it
      // would be one more thing to look at.
      loadingFrame: false,
    });
    panel.addTo(drop);

    const { create } = binding.options;
    /** @type {KeyboardTarget} */
    const keyboardTarget = {
      element,
      field: () => target.get()?.element ?? element,
      onKey,
      dismiss,
    };
    const subscription = create(keyboardTarget).subscribe({
      next: (mountable) => {
        panel.mount(mountable);
      },
    });
    return { create, panel, subscription, pivot, drop, attachedTo: null, placement: null };
  }

  /**
   * Hang the board off the panel of the field being typed into.
   *
   * @param {Board} current
   * @param {KeyboardBinding} binding
   */
  function attach(current, binding) {
    const parent = binding.containerObject.parent;
    if (current.attachedTo === binding || !parent) {
      return;
    }
    current.placement?.dispose();
    parent.add(current.pivot);
    current.attachedTo = binding;
    const { gap = DEFAULT_GAP, tilt = DEFAULT_TILT } = binding.options;
    const { pivot, drop, panel } = current;
    current.placement = binding.placeEffect(() => {
      const panelSize = getBorderBoxSize(binding.containerElement);
      const boardSize = panel.size();
      pivot.rotation.set(-tilt, 0, 0);
      place(pivot, 0, -(panelSize.height / 2 + gap) * binding.scale, 0);
      place(drop, 0, -(boardSize.height / 2) * binding.scale, 0);
    }, "portal-keyboard-place");
  }

  /**
   * @param {HTMLInputElement | undefined} from
   * @param {HTMLInputElement | undefined} to
   */
  function moveFocusMark(from, to) {
    if (from === to) {
      return;
    }
    from?.removeAttribute(FOCUS_ATTRIBUTE);
    if (to) {
      to.setAttribute(FOCUS_ATTRIBUTE, "");
      // As tapping a field on a phone does, and said to the mirror, which
      // draws the caret from the selection.
      moveCaretToEnd(to);
      touchValue(to);
    }
  }

  function dismiss() {
    const current = target.peek();
    if (!current) {
      return;
    }
    withComputation(null, () => {
      closeBoard();
      moveFocusMark(current.element, undefined);
      target.set(null);
    });
  }

  return {
    field: () => target.get()?.element ?? null,
    focus(element, binding) {
      if (!binding.containerObject.parent) {
        // A panel not in the scene has nowhere to hang a board.
        return;
      }
      // Untracked: a press can arrive from anywhere, and what the board's
      // construction reads — the portal it builds, the tree the factory
      // builds — is theirs to track, not the caller's.
      withComputation(null, () => {
        const previous = target.peek();
        if (previous?.element === element && previous.binding === binding && board) {
          return;
        }
        moveFocusMark(previous?.element, element);
        const next = { element, binding };
        target.set(next);
        if (board && board.create !== binding.options.create) {
          closeBoard();
        }
        board ??= buildBoard(next);
        attach(board, binding);
      });
    },
    dismiss,
    release(node) {
      if (target.peek()?.element === node) {
        dismiss();
      }
    },
    unbind(binding) {
      if (target.peek()?.binding === binding) {
        dismiss();
      }
    },
    dispose() {
      dismiss();
    },
  };
}
