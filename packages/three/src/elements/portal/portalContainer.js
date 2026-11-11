/**
 * A panel's container element, from the build to the release: the one the
 * portal makes for a mounted tree, or the page's own element claimed in its
 * place, and the release that takes the panel down and leaves that element
 * as the page had it.
 */

import { BUSY_ATTRIBUTE, LOADING_ATTRIBUTE } from "../mirror/mutationRules.js";
import { isPortalRoot } from "../mirror/styleReads.js";
import { startUnlinking, takeDown, unlink } from "./portalNodes.js";
import { PORTAL_ATTRIBUTE } from "./portalRoot.js";
import { finishTeardownOf } from "./portalTeardown.js";

/**
 * @import {PortalState} from './portalState.js';
 * @import {Unlinked} from './portalNodes.js';
 */

/**
 * The portal's own container: an element parked off-screen on the body for
 * a mounted tree to live in, marked as the top of a panel.
 *
 * @returns {HTMLElement}
 */
export function createContainerElement() {
  const containerElement = document.createElement("div");
  containerElement.setAttribute(PORTAL_ATTRIBUTE, "");
  containerElement.style.position = "absolute";
  containerElement.style.top = "0";
  containerElement.style.left = "0";
  // Out of sight by being out of the viewport: shifted up and left by its own
  // size, so its far corner meets the page's origin and all of it lies where
  // the page cannot scroll. Not `visibility: hidden`, which it used to be:
  // that is inherited, so every element inside reported `hidden` to CSS and
  // content could no longer hide or show a part of itself with it. A
  // transform is the panel's alone, and it moves nothing the mirror
  // measures — sizes are unchanged, positions are taken relative to this
  // container, and the container's own transform is never mirrored (see
  // `isTransformed`). Nor does `left`/`top` do it: an offset that large
  // widens the room an absolute box shrinks to fit in, and the text rewraps.
  //
  // The transform also makes this container the containing block of any
  // `position: fixed` descendant, which is what the mirror already assumes
  // (see `getPortalContainer`); before, such a box anchored to the viewport
  // and drifted from the panel whenever the page scrolled.
  //
  // Only the portal's own container is treated this way. A root the page
  // hands over is on show and the page's to style; see `claimRoot`.
  containerElement.style.transform = "translate(-100%, -100%)";
  // Visible, explicitly, so that the panel answers only for itself. The
  // property is inherited, and a computed value does not say where it came
  // from: a page that hides its own furniture while a session runs — a
  // `visibility: hidden` on `<body>`, or on a wrapper the portal ends up in
  // — would otherwise hide every element of every panel, where the mirror's
  // other root-scoped questions all stop at this container.
  containerElement.style.visibility = "visible";
  // What `visibility: hidden` used to do for free and moving off-screen does
  // not: keep the panel out of the page's own interaction. Without this a
  // Tab lands on invisible buttons and Enter clicks them, a screen reader
  // reads the panel, find-in-page matches its text, and focusing something
  // scrolls this `overflow: hidden` box — which the portal's scroll listener
  // would faithfully mirror. `inert` refuses all of that and none of what
  // the portal needs: clicks it synthesises with `dispatchEvent` still
  // arrive, a checkbox still toggles on them, and computed styles are
  // untouched. `aria-hidden` says the same to assistive technology that
  // predates `inert`.
  containerElement.setAttribute("inert", "");
  containerElement.setAttribute("aria-hidden", "true");
  // Out of sight, but not out of flow enough on its own: a descendant wider or
  // taller than the panel — an unbreakable string, a fixed-size image — is
  // ordinarily left to bleed past this container's own box, and with nothing
  // between it and `<html>` clipping that overflow, it is the page itself
  // that grows a scrollbar for a panel nobody can see. Clipping here keeps
  // that overflow this container's problem instead of the document's.
  containerElement.style.overflow = "hidden";
  document.body.appendChild(containerElement);
  return containerElement;
}

/**
 * Take an element the page owns as the top of a panel: mark it, and nothing
 * else — its styles, its place in the document and what it holds are the
 * page's. The checks are for the three ways the mark can lie. Every walk in
 * the mirror climbs to the nearest element carrying it and stops, so a
 * panel inside a panel is a mirror that never reaches the outer one's top,
 * and an element two portals watch is two mirrors each crediting the other's
 * work to itself; and an element outside the document has no layout to
 * mirror, and its arrival in the document later is a mutation of its new
 * parent, which no observer of the element itself will hear.
 *
 * @param {HTMLElement} root
 * @returns {HTMLElement}
 */
export function claimRoot(root) {
  // The panel this element was the root of may still be taking its objects
  // down, and that has to be over before another starts on the element.
  finishTeardownOf(root);
  if (!root.isConnected) {
    throw new Error("A portal can only mirror an element that is in the document.");
  }
  if (isPortalRoot(root)) {
    throw new Error("This element is already being mirrored by a portal.");
  }
  if (root.parentElement?.closest(`[${PORTAL_ATTRIBUTE}]`)) {
    throw new Error(
      "A portal cannot mirror an element inside a panel; it is already part of that panel.",
    );
  }
  if (root.querySelector(`[${PORTAL_ATTRIBUTE}]`)) {
    throw new Error(
      "A portal cannot mirror an element with a panel inside it; mirror the two separately.",
    );
  }
  root.setAttribute(PORTAL_ATTRIBUTE, "");
  return root;
}

/**
 * Take the panel down. Everything that could change it stops, and the
 * panel leaves the scene, the raycast and the page, all in this task:
 * `takeDownContainer`, then `unlink` over everything under the element,
 * then, for an element the page owns, the portal's marks. What is left
 * on the element afterwards is the page's own, the hover and press flags
 * included, which `unlink` takes off with the marks.
 *
 * Then the objects' own teardowns, which are most of the cost: queued on
 * the scene's scheduler and run a budget at a time where there is one,
 * run here where the portal paces itself. `portalTeardown.js` has the
 * rules.
 *
 * @param {PortalState} state
 */
export function disconnect(state) {
  if (state.released) {
    return;
  }
  state.released = true;
  const unlinked = startUnlinking();
  takeDownContainer(state, unlinked);
  unlink(state, state.containerElement, unlinked);
  if (state.root) {
    state.containerElement.removeAttribute(PORTAL_ATTRIBUTE);
    state.containerElement.removeAttribute(LOADING_ATTRIBUTE);
    state.containerElement.removeAttribute(BUSY_ATTRIBUTE);
  }
  takeDown(state, unlinked);
}

/**
 * Everything the portal set up around its content, taken down by
 * `disconnect` before anything under the container.
 *
 * @param {PortalState} state
 * @param {Unlinked} unlinked Where the objects held for a commit are
 *   collected, with the rest of the panel's.
 */
function takeDownContainer(state, unlinked) {
  // First: the board is a panel of its own hanging off this one's parent,
  // and it comes down before the parent is left.
  state.portalKeyboard?.dispose();
  state.ownKeyboardHost?.dispose();
  state.pump?.dispose();
  state.textPreparer?.dispose();
  state.panelScrolls.dispose();
  state.forwarder.dispose();
  state.unregisterPanel();
  // A panel closed before it finished mounting still had a frame up.
  state.stopLoadingFrame();
  // Nothing is waiting for a commit that is not going to come. Both lists
  // are collected here by name, because an object can be in neither
  // place the walks look — built for a commit, then its node left — and
  // `unlink` is idempotent for the ones that are. An object built for an
  // arrival hangs off no parent yet, so nothing above it is hidden with
  // the container: it is hidden itself.
  for (const node of state.pendingAttachments) {
    const object = state.nodeToObject.get(node);
    if (object) {
      object.visible = false;
    }
    unlink(state, node, unlinked);
  }
  state.pendingAttachments.clear();
  for (const node of state.pendingRemovals) {
    unlink(state, node, unlinked);
  }
  state.pendingRemovals.clear();
  if (state.blocker) {
    // Removing is safe whether `markLoaded` ever added it.
    state.interactionManager.remove(state.blocker);
  }
  // The portal's own container goes with it. One the page handed over is
  // the page's, and stays exactly where it is; `disconnect` takes the
  // portal's marks off it.
  if (!state.root && state.containerElement.parentNode) {
    state.containerElement.parentNode.removeChild(state.containerElement);
  }
  if (state.containerObject.parent) {
    state.containerObject.parent.remove(state.containerObject);
  }
  // Out of the raycast as well as the scene: every object under the
  // container stays registered as a ray target until its teardown runs,
  // and the manager casts none whose parents include a hidden one.
  state.containerObject.visible = false;
  state.handles?.dispose();
  if (document.fonts) {
    document.fonts.removeEventListener("loadingdone", state.onFontsLoaded);
  }
  state.stopWatchingStyles();
  state.containerElement.removeEventListener("scroll", state.onScroll, true);
  state.stopWatchingPage();
  state.containerElement.removeEventListener("load", state.onLoad, true);
  // A frame asked for by an image that landed just as the portal came down.
  state.loadFrame?.();
  state.resizeEffect.dispose();
  state.outlines?.dispose();
  state.mutationObserver.disconnect();
  state.animationClock.dispose();
  // After the observer, so nothing can ask for a rebuild on the way out.
  state.stopFlushing();
  state.layerOrder.dispose();
  state.paintBatch.dispose();
  state.depthQuad.material.dispose();
  state.boxBatch.dispose();
  state.textBatch.dispose();
}
