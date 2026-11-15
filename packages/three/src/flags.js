/**
 * The flags a ray and a page share that the scene's own layer asks about,
 * here under the panels so that `mouse.js` can read them. This module
 * imports nothing, as `elements/portal/portalRoot.js`, which exports them
 * with the rest of the flags, imports nothing of three.js.
 */

/**
 * Set on every control a hand's pointer is over, for a stylesheet to answer
 * as it would `:hover`. See
 * `elements/input/pointerForwarding.js`.
 */
export const HOVER_ATTRIBUTE = "data-xr-hover";

/**
 * Set by a page on a control that is a key: one a finger presses as it
 * lands and holds until it lifts, as a phone's keyboard takes a finger,
 * rather than one it taps on its lift. The keys of `keyboard` in
 * `justdom-three-ui` carry it. A hand's trigger presses every control as it
 * closes, so this says nothing to a hand. It is for the finger on a touch
 * screen, which waits to see whether it moves (a look) or stays (a long
 * press) before it presses anything else; see `followMouse` in `mouse.js`
 * and `installTouch` in `justdom-xr`.
 */
export const KEY_ATTRIBUTE = "data-xr-key";

/**
 * Whether a ray is on a key: whether any element of `doc` that carries
 * `KEY_ATTRIBUTE` has the hover flag a ray sets. A finger's ray is the only
 * one that asks, and the only one aimed at the page as it does.
 *
 * @param {Document} [doc]
 * @returns {boolean}
 */
export function isRayOnKey(doc = document) {
  return doc.querySelector(`[${KEY_ATTRIBUTE}][${HOVER_ATTRIBUTE}]`) !== null;
}
