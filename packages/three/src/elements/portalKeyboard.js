/**
 * @import {Subscribable} from '@apendua/signal';
 * @import {Mountable} from '../core.js';
 * @import {InputFocus} from './textInput.js';
 * @import {KeyPress} from './typing.js';
 * @import {KeyboardBinding, KeyboardHost} from './keyboardHost.js';
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
 * `onKey` does to the field being typed into what the key would have done
 * and closes the board on the keys that end an entry; `dismiss` closes it
 * for any other reason a board might have — a "done" key of its own, say.
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
 * @property {number} [gap] The room between the panel's bottom edge and the
 *   board's top edge, in the panel's px. 12 by default.
 * @property {number} [tilt] How far the board is reclined toward the viewer,
 *   in radians, hinged at its top edge. 24° by default; 0 leaves it in the
 *   panel's plane.
 */

/**
 * A panel's side of the scene's keyboard: the `InputFocus` its fields are
 * built with, and the three ways a panel lets go of the board — a press on
 * its background, a node of its leaving, and the panel itself going.
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

  return {
    focus,
    /**
     * A press on the panel's background: away from the fields, whichever
     * panel they are in, as tapping outside the field on a phone is.
     */
    dismiss() {
      host.dismiss();
    },
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
      host.unbind(binding);
    },
  };
}
