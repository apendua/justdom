/**
 * The part of this package a page uses with no scene to hand: asking which
 * panel an element is mirrored into, and scrolling an element the way a
 * panel scrolls one. Nothing here imports three.js, so a widget that a
 * page shows, and a portal may mirror, can ask these questions without the
 * page's own bundle carrying a renderer it never makes. `index.js`
 * exports the same functions for a scene.
 */
export { getPortalRoot } from "./elements/portalRoot.js";
export { scrollElementBy } from "./elements/renderingUpdates.js";
