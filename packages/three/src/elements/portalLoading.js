/**
 * How a panel goes from loading to shown: the busy and loading attributes
 * on its container, the drawn flag its strips wait for, and the images and
 * fonts whose arrival moves its content. `buildPortal` builds the panel and
 * hands each of these its `PortalState`.
 */

import { BUSY_ATTRIBUTE, LOADING_ATTRIBUTE } from "./mirror/mutationRules.js";
import { isSvgElement } from "./plugins.js";
import { projectChanges } from "./portalNodes.js";

/**
 * @import {PortalState} from './portalState.js';
 */

/**
 * Set `BUSY_ATTRIBUTE` on the container while a coming frame has work for
 * the panel: the clock sampling styles that move, or the pump bringing an
 * update in. Written only when that changes, since the observer reports
 * every write.
 *
 * @param {PortalState} state
 */
export function showBusy(state) {
  const busy = state.hasFrames && (state.clockSampling || state.pumpQueued);
  if (busy !== state.containerElement.hasAttribute(BUSY_ATTRIBUTE)) {
    state.containerElement.toggleAttribute(BUSY_ATTRIBUTE, busy);
  }
}

/**
 * Something of the panel is drawn now, the loading frame or the panel
 * itself: show the drag strips around it.
 *
 * @param {PortalState} state
 */
export function markDrawn(state) {
  state.handles?.setShown(true);
  state.drawn.set(true);
}

/**
 * The initial mount is done: show the panel, let its buttons register, and
 * tell whoever wanted telling. Once, ever — a panel that is already visible
 * absorbs later updates incrementally, and taking it off screen for them
 * would be worse than any frame they cost.
 *
 * @param {PortalState} state
 */
export function markLoaded(state) {
  if (!state.sawContent || !state.loading.get()) {
    return;
  }
  // The frame goes in the tick that attached the content, so the panel
  // takes its place in the same drawn frame — see `commit`, which the pump
  // runs just before this.
  state.stopLoadingFrame();
  state.containerElement.removeAttribute(LOADING_ATTRIBUTE);
  // The blocker before the flip: flipping `loading` is what lets the
  // panel's own controls register, and the background should be in the
  // raycast set before the things drawn in front of it.
  if (state.blocker) {
    state.interactionManager.add(state.blocker);
  }
  state.loading.set(false);
  state.onLoadingChanged?.(false);
  // Whether or not a frame stood in for it, the panel is drawn now.
  markDrawn(state);
}

/**
 * Say that images have arrived — once for however many of them did.
 *
 * An `<img>` the author gave no size to has just been handed one by the
 * picture, so its own box changed and everything after it in the flow has
 * moved — which the mirror settles from the picture's own place in the
 * tree, exactly as it settles a row that grew. What still wants coalescing
 * is that they arrive one at a time: a panel of nine icons announced nine
 * settlings, back to back, for a layout that settled once. Waiting a frame
 * costs nothing anybody was waiting on, because a picture that has just
 * decoded cannot be on screen before the next frame anyway.
 *
 * @param {PortalState} state
 */
function announceLoads(state) {
  // The frame sources this can draw on — the renderer's loop and
  // `requestAnimationFrame` — both deliver asynchronously, so the handle is
  // always in place by the time this reads it.
  state.loadFrame?.();
  state.loadFrame = null;
  const arrived = [...state.loaded];
  state.loaded.clear();
  projectChanges(state, () => {
    state.mirror.contentLoaded(arrived);
  });
  state.interactionManager.updateIntersections();
}

/**
 * An image arriving is the other event the observer cannot see: nothing was
 * mutated and nothing restyled. Capturing, because `load` does not bubble.
 *
 * The picture itself does not come through here — the texture is fetched by
 * URL rather than read off this element, and `image.js` hears the same event
 * for itself. This is only the layout half.
 *
 * An `<image>` inside an `<svg>` has no layout half. Whatever size its
 * picture turns out to be, nothing in the HTML flow moves for it, and the
 * image node hears the event for itself. So its load is not announced, or
 * a diagram of forty pictures would re-measure the panel once for each.
 *
 * @param {PortalState} state
 * @param {Event} event
 */
export function loadCallback(state, event) {
  const target = event.target;
  if (!(target instanceof Node) || target.nodeType !== Node.ELEMENT_NODE) {
    return;
  }
  if (isSvgElement(target)) {
    return;
  }
  state.loaded.add(target);
  if (!state.loadFrame) {
    state.loadFrame = state.requestFrames(() => announceLoads(state));
  }
}

/** @param {PortalState} state */
export function fontLoadingCallback(state) {
  // Fonts arriving restyle and re-measure everything at once; there is no
  // node to scope that to.
  projectChanges(state, () => {
    state.mirror.fontsLoaded();
  });
}
