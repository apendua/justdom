import { isTextInput } from "./typing.js";

/**
 * @import {Subscribable} from '@apendua/signal';
 * @import {Mountable} from '../core.js';
 * @import {InputFocus} from './textInput.js';
 * @import {KeyPress} from './typing.js';
 * @import {KeyboardBinding, KeyboardHost} from './keyboardHost.js';
 * @import {KeyboardPreviewOptions} from './keyboardPreview.js';
 */

export { FOCUS_ATTRIBUTE } from "./keyboardHost.js";

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
 * The board is the scene's, not the panel's: `keyboardHost.js` keeps one
 * per `render()`, and a field pressed in another panel moves the typing
 * there rather than bringing up a second board. What is here is a panel's
 * side of that — its options, its frame, and when it lets go.
 *
 * It appears when a field is pressed, in front of the player and reclined
 * toward the hands like a phone on a stand (or below the panel, with
 * `placement: "panel"`), types into the field through
 * `typeIntoInput`, and goes on `Escape`, on a press anywhere in a panel
 * but on a field, when the field leaves the document, and with the panel.
 * `Enter` submits and leaves the field being typed into, as it does on a
 * page, so a list can be filled one entry after another. While it is up the field carries `data-xr-focus`, which a
 * stylesheet may use the way it uses `:focus` — presentationally, exactly
 * as `data-xr-hover`.
 */

/**
 * The field a keyboard is built for, and what it is handed to reach it:
 * `onKey` does to the field being typed into what the key would have done,
 * and closes the board on `Escape`; `dismiss` closes it for any other
 * reason a board might have — a "done" key of its own, say.
 *
 * A board outlives the field it was built for: pressing another field, in
 * this panel or another one with the same `create`, moves the typing
 * without building the board again. `element` is the field it was built
 * for; `field()` is the one it is typing into now.
 *
 * @typedef {object} KeyboardTarget
 * @property {HTMLInputElement} element
 * @property {() => HTMLInputElement} field Reactive.
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
 * @property {"viewer" | "panel" | ((placement: KeyboardPlacement) => void)} [placement]
 *   Where the board opens. `"viewer"`, the default, puts it in front of the
 *   player, `reach` ahead of the eyes and `drop` below them, turned to face
 *   them, and leaves it there in the room while it is up: moving to a field
 *   in another panel does not move it. `"panel"` hangs it below the panel
 *   of the field being typed into, `gap` under its bottom edge, scaled with
 *   the panel, and moves it to the next field's panel. A function poses the
 *   board itself when it opens (see `KeyboardPlacement`). Where there is no
 *   camera to be in front of — a portal on a plain page, or under a test
 *   runner — `"viewer"` and a function are `"panel"`.
 * @property {number} [reach] How far ahead of the eyes the board's top edge
 *   opens, in metres. 0.45 by default.
 * @property {number} [drop] How far below the eyes, in metres. 0.2 by
 *   default.
 * @property {number} [scale] How big the board is in the room, in metres per
 *   CSS px of it. A millimetre by default, whichever panel's field opened
 *   it. Not used by `"panel"`, where the board is the panel's scale.
 * @property {number} [gap] The room between the panel's bottom edge and the
 *   board's top edge, in the panel's px, with `"panel"`. 12 by default.
 * @property {number} [tilt] How far the board is reclined toward the viewer,
 *   in radians, hinged at its top edge. 24° by default; 0 stands it upright.
 * @property {boolean | KeyboardPreviewOptions} [preview] Whether a board in
 *   the room carries a copy of the field being typed into above its keys,
 *   leaning toward the player: the value unmasked, the caret, and a caret
 *   the ray can place — so the typing can be watched where the hands are
 *   rather than on the panel. On by default; an object says how it leans,
 *   how far above the keys it is and what it is dressed in (see
 *   `KeyboardPreviewOptions`). Not used by `"panel"`, where the field is
 *   right above the board already.
 */

/**
 * What a `placement` function is handed to pose the board with, once, as it
 * opens. `anchor` is in the scene, scaled already; the board's top edge is
 * at its origin and its face, reclined by `tilt`, looks down its +z. Set its
 * position and rotation in world terms.
 *
 * @typedef {object} KeyboardPlacement
 * @property {import('three').Object3D} anchor
 * @property {import('three').Camera} camera
 * @property {import('three').Object3D} panelObject The panel whose field was
 *   pressed.
 * @property {HTMLInputElement} field
 */

/**
 * Whether a click on this element is a press that will give it the typing:
 * a field the keyboard can type into. Its own press moves the typing there
 * right after the click, so the click is not focus leaving.
 *
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
function takesTheTyping(target) {
  // By shape rather than `instanceof`: the element may be from another
  // window than the one this module was loaded in.
  const node = /** @type {Node | null} */ (target);
  if (!node || typeof node.nodeType !== "number" || !isTextInput(node)) {
    return false;
  }
  const field = /** @type {HTMLInputElement} */ (node);
  return !field.disabled && !field.readOnly;
}

/**
 * A panel's side of the scene's keyboard: the `InputFocus` its fields are
 * built with, and the three ways a panel lets go of the board — a press in
 * it anywhere but on a field, a node of its leaving, and the panel itself
 * going.
 *
 * A press is heard as the click it becomes. Every press the portal turns
 * into a click on an element — a button, a row, a label — and a press on
 * the background, which it turns into a click on the panel's root, bubbles
 * to the root; so does a mouse click on a panel mirrored from the page. On
 * a page, each of those takes focus away from the field, and so here each
 * of them puts the keyboard away. A press that became a scroll clicks
 * nothing, and leaves the keyboard be.
 *
 * @param {KeyboardHost} host
 * @param {KeyboardBinding} binding
 */
export function bindPortalKeyboard(host, binding) {
  /** @type {InputFocus} */
  const focus = {
    isFocused: (element) => host.field() === element,
    press: (element) => {
      host.focus(element, binding);
    },
  };

  /** @param {Event} event */
  const onClick = (event) => {
    if (host.field() !== null && !takesTheTyping(event.target)) {
      host.dismiss();
    }
  };
  binding.containerElement.addEventListener("click", onClick);

  return {
    focus,
    /**
     * A node has left the panel. If it is the field being typed into, the
     * board has nothing to type into any more.
     *
     * @param {Node} node
     */
    released(node) {
      host.release(node);
    },
    dispose() {
      binding.containerElement.removeEventListener("click", onClick);
      host.unbind(binding);
    },
  };
}
