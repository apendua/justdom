/**
 * The attribute a portal marks its container element with. It lives here,
 * in a module that imports nothing, so that everything that needs to know
 * where a portal's tree ends, the mirror's ancestor walks and
 * `getPortalRoot` on a page that has no scene, can share it, and so that
 * the page's side of it does not bring three.js along (see `page.js`).
 */
export const PORTAL_ATTRIBUTE = "data-xr-portal";

/*
 * The flags the portal writes on the elements it mirrors, for a stylesheet to
 * answer as it would the pseudo-class each stands for. Here for the same
 * reasons, and the mirror's contract sets (`PRESENTATIONAL_ATTRIBUTES` in
 * `mirror.js`) and every writer take the names from here.
 */

/**
 * Set on every control a hand's pointer is over, for a stylesheet to answer
 * as it would `:hover`. See `pointerForwarding.js`.
 */
export const HOVER_ATTRIBUTE = "data-xr-hover";

/**
 * Set on every control a hand is pressing, as `:active`.
 */
export const ACTIVE_ATTRIBUTE = "data-xr-active";

/**
 * Set on a mirrored checkbox while it is ticked, as `:checked`. See
 * `checkbox.js`.
 */
export const CHECKED_ATTRIBUTE = "data-xr-checked";

/**
 * Set on the field the keyboard is typing into, as `:focus`. See
 * `keyboardHost.js`.
 */
export const FOCUS_ATTRIBUTE = "data-xr-focus";

/**
 * Every flag above: what a portal over the page's own element takes off that
 * element's subtree when it closes, and what the mirror's contract sets are
 * made from.
 */
export const ELEMENT_FLAGS = /** @type {const} */ ([
  HOVER_ATTRIBUTE,
  ACTIVE_ATTRIBUTE,
  CHECKED_ATTRIBUTE,
  FOCUS_ATTRIBUTE,
]);

/**
 * The portal a node was projected through, if it was.
 *
 * Worth having because a click inside a portal and a click on the page are not
 * the same kind of event, however alike they look. The ones the portal
 * synthesises from a ray are the panel's own; the ones the browser raises are
 * somebody using a mouse on whatever else the page happens to be showing — a
 * VR button, a debug overlay, an emulator's controls. A component that dresses
 * itself in a `document` listener to hear "clicked elsewhere" hears both, and
 * closes itself on the mouse click that was busy pressing the trigger.
 *
 * Listening on this instead scopes that to the panel, which is what "elsewhere"
 * was ever meant to mean. It returns null off the page's own DOM, where
 * `document` is the right answer and there is nothing to disambiguate.
 *
 * @param {Node | null} node
 * @returns {HTMLElement | null}
 */
export function getPortalRoot(node) {
  const element =
    node?.nodeType === Node.ELEMENT_NODE
      ? /** @type {Element} */ (node)
      : (node?.parentElement ?? null);
  return /** @type {HTMLElement | null} */ (element?.closest(`[${PORTAL_ATTRIBUTE}]`) ?? null);
}
