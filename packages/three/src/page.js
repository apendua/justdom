/**
 * The part of this package a page uses with no scene to hand: asking which
 * panel an element is mirrored into, scrolling an element the way a panel
 * scrolls one, and the attribute the keyboard marks the field it types into
 * with. Nothing here imports three.js, so a widget that a page shows, and a
 * portal may mirror, can ask these questions without the page's own bundle
 * carrying a renderer it never makes. `index.js` exports the same for a
 * scene.
 */
export { FOCUS_ATTRIBUTE, getPortalRoot } from "./elements/portalRoot.js";
export { scrollElementBy } from "./elements/renderingUpdates.js";
