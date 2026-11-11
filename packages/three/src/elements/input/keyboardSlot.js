import { createProperty } from "justdom-signal";
import { sceneService } from "../../sceneServices.js";

/**
 * @import {KeyboardHost} from './keyboardHost.js';
 * @import {SceneHost} from '../../sceneServices.js';
 */

/**
 * Where a scene keeps its keyboard: one per `render()`, filled by the first
 * panel that offers a keyboard and emptied with the scene.
 *
 * A slot rather than the host itself, and a module of its own rather than a
 * corner of `keyboardHost.js`, because of who builds what. The host builds
 * the board as a portal, and a portal is made by `portal.js`, which needs
 * the host to make its own keyboard. So the scene makes the slot, which
 * needs nothing, through `sceneService` (`sceneServices.js`), and the first
 * portal that wants a keyboard puts one in it with the `createPortal` it
 * has to hand.
 *
 * @typedef {object} KeyboardSlot
 * @property {KeyboardHost | null} host
 * @property {WeakKey | null} ctx The scene's own context: where the
 *   keyboard finds the scene and the camera it opens in front of, and the
 *   renderer and interactions a carry needs. The same ones every panel in
 *   the scene has, asked of the scene rather than of whichever panel
 *   happened to open the board.
 */

/**
 * A slot set by hand, by a test that builds a scene's panels without
 * `render()`; the package does not export it. Null by default; see
 * `keyboardSlotOf`. Outside a scene, as on a plain page or under a test
 * runner, a panel with a keyboard keeps one of its own.
 */
export const KeyboardSlotContext = createProperty(
  /**
   * @returns {KeyboardSlot | null}
   */
  () => null,
);

/**
 * @param {WeakKey | null} [ctx]
 * @returns {KeyboardSlot}
 */
export function createKeyboardSlot(ctx = null) {
  return { host: null, ctx };
}

/**
 * Take the scene's keyboard down with the scene.
 *
 * @param {KeyboardSlot} slot
 */
export function disposeKeyboardSlot(slot) {
  slot.host?.dispose();
  slot.host = null;
}

/**
 * Put the scene's keyboard away when a session ends, as the scene does
 * for its slot. A board in the room was opened in front of where the
 * player stood, and a page drawn only while presenting runs nothing
 * after its session ends: left up, the board would come back in the next
 * session where the player no longer is, still typing into the field,
 * and the page would show that field focused in between.
 *
 * @param {KeyboardSlot} slot
 * @param {import('three').EventDispatcher<{ sessionend: {} }>} xr The
 *   renderer's XR manager.
 * @returns {() => void} Stop listening.
 */
export function dismissKeyboardAtSessionEnd(slot, xr) {
  const onSessionEnd = () => {
    slot.host?.dismiss();
  };
  xr.addEventListener("sessionend", onSessionEnd);
  return () => {
    xr.removeEventListener("sessionend", onSessionEnd);
  };
}

/**
 * The slot for the panels under `ctx`: the one set on
 * `KeyboardSlotContext`, or else the scene's, made on the first panel that
 * offers a keyboard, put away at the end of every session and taken down
 * with the scene. Null under neither.
 *
 * @param {WeakKey} ctx
 * @returns {KeyboardSlot | null}
 */
export function keyboardSlotOf(ctx) {
  return KeyboardSlotContext.get(ctx) ?? sceneService(ctx, sceneKeyboardSlot);
}

/**
 * @param {SceneHost} host
 * @returns {KeyboardSlot}
 */
function sceneKeyboardSlot(host) {
  const slot = createKeyboardSlot(host.ctx);
  host.onDispose(dismissKeyboardAtSessionEnd(slot, host.renderer.xr));
  host.onDispose(() => disposeKeyboardSlot(slot));
  return slot;
}
