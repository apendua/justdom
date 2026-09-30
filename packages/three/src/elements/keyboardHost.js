import * as THREE from "three";
import { Effect, Signal, withChannel, withComputation } from "@apendua/signal";
import { getBorderBoxSize } from "./mirror.js";
import { place } from "./place.js";
import { moveCaretToEnd, typeIntoInput } from "./typing.js";
import { InputFocusContext, touchValue } from "./textInput.js";
import { createKeyboardPreview } from "./keyboardPreview.js";
import { DEFAULT_KEYBOARD_SCALE, shouldReuse, viewerPose } from "./keyboardPlacement.js";
import { createKeyboardHandles } from "./keyboardHandles.js";
import { levelPose } from "../carry.js";
import { CameraContext, RendererContext, SceneContext } from "../render.js";

/**
 * @import {Unsubscribable} from '@apendua/signal';
 * @import {Mountable} from '../core.js';
 * @import {KeyPress} from './typing.js';
 * @import {KeyboardTarget, PortalKeyboardOptions} from './portalKeyboard.js';
 * @import {KeyboardHandles} from './keyboardHandles.js';
 * @import {KeyboardPreview} from './keyboardPreview.js';
 * @import {LevelPose} from '../carry.js';
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
 * Where it opens is the `placement` of the panel whose field opened it. In
 * front of the player, the default, it is put in the room once, at a size
 * of its own, and stays there while the typing moves from panel to panel;
 * below a panel, it follows the typing from one panel to the next, at the
 * panel's size. `keyboardPlacement.js` has the pose.
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
 *   of its own, and none of the app's defaults — except the panel's
 *   `haptics`, which the board's keys follow, since the same hand presses
 *   both, with the hover on unless the panel turned it off by name.
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
 * Where the board is while it is up: the anchor it hangs from, the hinge
 * its top edge turns on, and the drop that puts its top edge at the hinge,
 * the board's own container centring itself on its origin as every panel
 * does. Made when the board opens and kept until it goes, so that a board
 * built again for another panel's `create` comes up where the last one was.
 *
 * In the room, the anchor is in the scene, posed once, and scaled to the
 * board's own size. On a panel, it is hung off the parent of the panel
 * being typed for, with nothing of its own, and moves to the next one.
 *
 * @typedef {object} Frame
 * @property {THREE.Group} anchor
 * @property {THREE.Group} pivot
 * @property {THREE.Group} drop
 * @property {"room" | "panel"} mode
 * @property {KeyboardBinding} openedFor The panel whose field opened it,
 *   whose options say how the board sits in the room.
 * @property {KeyboardBinding | null} attachedTo The panel it hangs off,
 *   on a panel.
 * @property {Effect | null} placement
 * @property {KeyboardHandles | null} handles What the player moves it by,
 *   in the room.
 */

/**
 * The board itself: what built it, and what to take down.
 *
 * @typedef {object} Board
 * @property {PortalKeyboardOptions["create"]} create
 * @property {ReturnType<CreatePortal>} panel
 * @property {Unsubscribable} subscription
 * @property {KeyboardPreview | null} preview The field above the keys, in
 *   the room, unless the panel said `preview: false`.
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
 * The scene and the camera, if the board is under a `render()` that has
 * them; null for a portal on a plain page or under a test runner. And
 * whether there is a renderer too, which a carry follows the hand by.
 *
 * @param {WeakKey} ctx
 * @returns {{ scene: THREE.Scene, camera: THREE.Camera, frames: boolean } | null}
 */
function roomOf(ctx) {
  /** @type {{ scene: THREE.Scene, camera: THREE.Camera }} */
  let room;
  try {
    room = { scene: SceneContext.get(ctx), camera: CameraContext.get(ctx) };
  } catch {
    return null;
  }
  try {
    RendererContext.get(ctx);
    return { ...room, frames: true };
  } catch {
    return { ...room, frames: false };
  }
}

/**
 * Where the head is, level.
 *
 * @param {THREE.Camera} camera
 * @returns {LevelPose}
 */
function headOf(camera) {
  camera.updateWorldMatrix(true, false);
  return levelPose(camera.matrixWorld);
}

/**
 * @param {object} deps
 * @param {CreatePortal} deps.createPortal The portal factory, handed in
 *   rather than imported: the portal imports this.
 * @param {WeakKey | null} [deps.ctx] The scene's context, which the room is
 *   looked for in; without one, the context of the panel that opens the
 *   board.
 * @returns {KeyboardHost}
 */
export function createKeyboardHost({ createPortal, ctx: sceneCtx = null }) {
  /** @type {Signal<KeyboardFocus | null>} */
  const target = Signal.of(/** @type {KeyboardFocus | null} */ (null));

  /** @type {Frame | null} */
  let frame = null;
  /** @type {Board | null} */
  let board = null;

  /**
   * Where the player last put the board down, and where their head was
   * when they did: the next board opens there, unless they have since
   * walked or turned away from it (`shouldReuse`). For the life of the
   * scene; nothing is kept past it.
   *
   * @type {{ board: LevelPose, head: LevelPose } | null}
   */
  let putDown = null;

  /** @param {KeyPress} press */
  const onKey = (press) => {
    const current = target.peek();
    if (!current) {
      return;
    }
    typeIntoInput(current.element, press);
    // Not on Enter: on a page the field keeps its focus after a submit, and
    // an app that clears it wants the next entry typed straight in.
    if (press.key === "Escape") {
      dismiss();
    }
  };

  /**
   * Make the frame for a board about to open, and put it where it goes.
   *
   * @param {KeyboardFocus} focus
   * @returns {Frame}
   */
  function openFrame({ element, binding }) {
    const anchor = new THREE.Group();
    const pivot = new THREE.Group();
    const drop = new THREE.Group();
    anchor.add(pivot);
    pivot.add(drop);
    const {
      placement = "viewer",
      reach,
      drop: below,
      scale = DEFAULT_KEYBOARD_SCALE,
    } = binding.options;
    const room = placement === "panel" ? null : roomOf(sceneCtx ?? binding.ctx);
    if (!room) {
      return {
        anchor,
        pivot,
        drop,
        mode: "panel",
        openedFor: binding,
        attachedTo: null,
        placement: null,
        handles: null,
      };
    }
    room.scene.add(anchor);
    // The board's container is scaled to the panel's units per px, as every
    // panel's is; this makes a px of it `scale` metres in the room.
    anchor.scale.setScalar(scale / binding.scale);
    const head = headOf(room.camera);
    if (putDown && shouldReuse(putDown.head, head)) {
      // Where the player put it, over wherever the scene would have.
      anchor.position.copy(putDown.board.position);
      anchor.rotation.set(0, putDown.board.yaw, 0);
    } else if (typeof placement === "function") {
      placement({
        anchor,
        camera: room.camera,
        panelObject: binding.containerObject,
        field: element,
      });
    } else {
      const pose = viewerPose(room.camera.matrixWorld, { reach, drop: below });
      anchor.position.copy(pose.position);
      anchor.rotation.set(0, pose.yaw, 0);
    }

    const { draggable = true } = binding.options;
    const handles =
      draggable && room.frames
        ? createKeyboardHandles(sceneCtx ?? binding.ctx, {
            anchor,
            pivot,
            width: typeof draggable === "object" ? draggable.handleWidth : undefined,
            onPutDown: () => {
              anchor.updateWorldMatrix(true, false);
              putDown = { board: levelPose(anchor.matrixWorld), head: headOf(room.camera) };
            },
          })
        : null;

    return {
      anchor,
      pivot,
      drop,
      mode: "room",
      openedFor: binding,
      attachedTo: null,
      placement: null,
      handles,
    };
  }

  function closeFrame() {
    if (!frame) {
      return;
    }
    frame.handles?.dispose();
    frame.placement?.dispose();
    frame.anchor.removeFromParent();
    frame = null;
  }

  /**
   * Take the board down, leaving its frame and the target as they are.
   */
  function closeBoard() {
    if (!board) {
      return;
    }
    const { panel, subscription, preview } = board;
    board = null;
    subscription.unsubscribe();
    preview?.dispose();
    panel.disconnect();
  }

  /**
   * @param {KeyboardFocus} focus
   * @param {Frame} current
   * @returns {Board}
   */
  function buildBoard({ element, binding }, current) {
    // The preview only in the room: below a panel, the field it would copy
    // is right there above the keys already, which is the whole of what
    // the preview is for.
    const { preview: previewOption = true } = binding.options;
    const preview =
      current.mode === "room" && previewOption
        ? createKeyboardPreview({
            field: () => target.get()?.element ?? null,
            options: typeof previewOption === "object" ? previewOption : {},
          })
        : null;
    const panel = createPortal(
      // The preview is the one field in the board's panel that is being
      // typed into, as far as its caret is concerned.
      preview ? InputFocusContext.set(binding.ctx, preview.focus) : binding.ctx,
      {
        opaqueToRays: true,
        // A board that has been asked for is wanted now; a frame standing in
        // for it would be one more thing to look at.
        loadingFrame: false,
      },
    );
    panel.addTo(current.drop);
    if (preview) {
      panel.mount(preview.mountable);
    }

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
        if (preview) {
          preview.mountBoard(mountable);
        } else {
          panel.mount(mountable);
        }
      },
    });
    return { create, panel, subscription, preview };
  }

  /**
   * Keep the board hanging from its frame's hinge as its size changes, and,
   * on a panel, below that panel as the panel's size changes. Built again
   * whenever the board or the panel it hangs off is another one.
   *
   * @param {Frame} current
   * @param {Board} shown
   */
  function placeBoard(current, shown) {
    current.placement?.dispose();
    const { pivot, drop } = current;
    const binding = current.attachedTo ?? current.openedFor;
    const { gap = DEFAULT_GAP, tilt = DEFAULT_TILT } = binding.options;
    const units = binding.scale;
    if (current.mode === "panel") {
      current.placement = binding.placeEffect(() => {
        const panelSize = getBorderBoxSize(binding.containerElement);
        const boardSize = shown.panel.size();
        pivot.rotation.set(-tilt, 0, 0);
        place(pivot, 0, -(panelSize.height / 2 + gap) * units, 0);
        place(drop, 0, -(boardSize.height / 2) * units, 0);
      }, "portal-keyboard-place");
    } else {
      // In the default channel: the board in the room is no panel's, and
      // moves with nothing but itself.
      current.placement = withChannel(
        null,
        () =>
          new Effect(
            () => {
              const boardSize = shown.panel.size();
              pivot.rotation.set(-tilt, 0, 0);
              place(drop, 0, -(boardSize.height / 2) * units, 0);
              current.handles?.layout(boardSize.width, boardSize.height, units);
            },
            { name: "portal-keyboard-place" },
          ),
      );
    }
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
      closeFrame();
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
        const current = (frame ??= openFrame(next));
        let changed = false;
        if (current.mode === "panel" && current.attachedTo !== binding) {
          // On a panel, the board goes to the panel of the field being
          // typed into; in the room, it stays where it was put.
          /** @type {THREE.Object3D} */ (binding.containerObject.parent).add(current.anchor);
          current.attachedTo = binding;
          changed = true;
        }
        if (!board) {
          board = buildBoard(next, current);
          changed = true;
        }
        if (changed) {
          placeBoard(current, board);
        }
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
