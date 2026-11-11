/**
 * What a panel does when the page under it changes: the observer's
 * mutations, the container's size and scroll, and the animation clock's
 * batches. `buildPortal` registers each of these with the state it built.
 */

import { CameraContext, RendererContext } from "../../scene.js";
import { coverBox } from "../blocker.js";
import { getBorderBoxSize } from "../mirror/geometryReads.js";
import { isBookkeepingMutation, LOADING_ATTRIBUTE } from "../mirror/mutationRules.js";
import { placeAndScale } from "../place.js";
import { markLoaded } from "./portalLoading.js";
import { attach, detach, getOrCreateObjectForNode, projectChanges } from "./portalNodes.js";

/**
 * The panel's units per px: a centimetre a px, which is what `placeContainer`
 * scales the container by and what anything hung beside the panel — the
 * keyboard — has to work its px offsets through.
 */
export const PANEL_SCALE = 0.01;

/**
 * @import {PortalState} from './portalState.js';
 * @import {MutationBatch} from './animationClock.js';
 */

/**
 * What a batch owes gets paid at the end of the frame, before anything is
 * drawn. Most of what invalidates a batch arrives as its own task and is
 * settled by the microtask the batch queues for itself; what arrives from
 * inside the frame callback — a sampled CSS animation, a scroll drag in an
 * immersive session — is not, and would otherwise be drawn a frame late.
 *
 * @param {PortalState} state
 * @param {number} time
 */
export function flushBatches(state, time) {
  // The layers' order first, which moves what the batches draw.
  const renderer = RendererContext.get(state.ctx);
  const camera = CameraContext.get(state.ctx);
  if (renderer && camera) {
    state.layerOrder.frame(time, renderer, camera);
  }
  // First, so that a step the panel has just crossed is one the runs
  // re-rasterize against rather than one they find out about next frame.
  state.textScale?.measure();
  // And the step it is preparing, which that measurement may have moved.
  if (state.textScale) {
    state.textPreparer?.retarget(state.textScale.prepared());
  }
  state.paintBatch.flush();
  // And the layers cut in pieces, once their draws are this frame's.
  state.layerOrder.cut();
}

/**
 * Put the container where a panel of this size goes: a centimetre a px,
 * centred on its origin, and flipped half a turn about x so the CSS y
 * axis runs the right way. Written by the resize effect at every commit,
 * and by the loading frame's ticks during the mount — see there for why
 * the mount cannot wait for the effect.
 *
 * @param {PortalState} state
 * @param {number} width in the panel's px
 * @param {number} height
 * @returns {void}
 */
export function placeContainer(state, width, height) {
  const scale = PANEL_SCALE;
  const sizeX = scale * width;
  const sizeY = scale * height;
  // The rotation is written first and committed by `placeAndScale` with
  // everything else: setting an Euler keeps the quaternion in step, and the
  // quaternion is what the matrix is composed from.
  //
  // This one object matters out of all proportion to its number. Three
  // recomputes a world matrix for every descendant of anything that
  // recomposed its own — an object that auto-updates sets the flag that
  // forces the whole subtree beneath it — so a container left to itself
  // would hand the entire panel the work its boxes just opted out of.
  state.containerObject.rotation.set(Math.PI, 0, 0);
  placeAndScale(state.containerObject, -sizeX / 2, sizeY / 2, 0, scale, scale, scale);
  // The strips go where the edges are, from the same writes: a mount's
  // frame ticks move the panel as well as the commit does.
  state.handles?.layout(width, height, scale);
}

/** @param {PortalState} state */
export function resizeCallback(state) {
  const size = getBorderBoxSize(state.containerElement);
  placeContainer(state, size.width, size.height);
  // The measurement wants the middle of the panel, and the middle moves
  // with the size. In the container's own pixels, which is the frame it is
  // handed back through.
  state.textScale?.setPanelSize(size.width, size.height);
  // Container-local px units, y down; content sits at negative local z
  // (toward the viewer after the flip above), so +1 puts the blocker just
  // behind everything the portal draws.
  if (state.blocker) {
    coverBox(state.blocker, size.width, size.height, 1);
  }
  if (state.depthQuad) {
    coverBox(state.depthQuad, size.width, size.height, 0);
  }
}

/**
 * One observer flush, applied as one transaction. The mirror routes each
 * record to the signals of exactly the nodes it names — deduplicating
 * against `oldValue`, so the hover handlers re-asserting an attribute
 * invalidate nothing — and the object tree is reconciled for the nodes
 * that came and went.
 *
 * @param {PortalState} state
 * @param {MutationRecord[]} mutationList
 * @returns {boolean} Whether the flush changed the content, rather than
 *   only the portal's own bookkeeping attributes.
 */
export function mutationCallback(state, mutationList) {
  if (mutationList.every(isBookkeepingMutation)) {
    return false;
  }
  projectChanges(state, () => {
    state.mirror.ingest(mutationList);
    for (const mutation of mutationList) {
      if (mutation.type !== "childList") {
        continue;
      }
      state.sawContent = true;
      mutation.addedNodes.forEach((node) => {
        // A node the portal has never seen goes to the queue and gets
        // built when the pump reaches it — that is the slicing. One it
        // has seen — a reinsertion, a move — already paid its cost and
        // reattaches without queueing, in the frame the rest of the
        // change lands in. One already out of the tree again by this
        // flush, a spinner made and dropped between two reads, has
        // nothing to build, and queueing it would count it as an arrival
        // towards `MAX_BUILD_WAIT`.
        if (state.pump && !state.nodeToObject.has(node)) {
          if (state.containerElement.contains(node)) {
            state.pump.enqueue(node);
          }
          return;
        }
        // Listed whether or not the parent has an object yet: a node
        // moved under a row still queued to be built has nowhere to go
        // *now*, and somewhere to go by the commit.
        if (getOrCreateObjectForNode(state, node)) {
          attach(state, node);
        }
      });
    }
    for (const mutation of mutationList) {
      if (mutation.type !== "childList") {
        continue;
      }
      mutation.removedNodes.forEach((node) => {
        // Moved if the tree still holds it; gone otherwise, however many
        // times the flush put it back in between.
        if (!state.containerElement.contains(node)) {
          detach(state, node);
        }
      });
    }
  });
  contentChanged(state);
  if (!state.pumpQueued) {
    // A flush that left the panel nothing to do, such as a write of what
    // was already there, has no commit coming. The panel already shows
    // all of it, so what the flush counted goes up in outlines mode now.
    state.outlines?.commit();
  }
  return true;
}

/**
 * What follows any change to the panel's content, once it has been routed
 * into the mirror and the object tree: an observer flush, or the first
 * look at an element the page handed over with content already in it.
 * The rays are cast again by the caller: by the observer's callback, the
 * first look, or the pump's tick once it has built.
 *
 * @param {PortalState} state
 */
export function contentChanged(state) {
  // A class swap is how most transitions begin, and inside an immersive
  // session the mutation is the only trace of one that reaches us: the
  // events that would announce it are dispatched with the rendering
  // updates the session has suspended. Observer callbacks are microtasks
  // and keep arriving, so this is where the clock gets to look.
  state.animationClock.sweep();
  if (state.sawContent && state.loading.get()) {
    // The mount is under way: say so where the DOM can see it, and start
    // placing the panel and the frame that may stand in for it. Both end
    // with `markLoaded`. The flag is written once, not on every flush of
    // the mount, since the observer reports a write of the value already
    // there as a record of its own. Such a record does not lead back here:
    // `mutationCallback` skips a flush made only of the portal's flags.
    if (!state.containerElement.hasAttribute(LOADING_ATTRIBUTE)) {
      state.containerElement.setAttribute(LOADING_ATTRIBUTE, "");
    }
    state.startLoadingFrame();
  }
  if (state.pump) {
    state.pump.schedule();
  } else {
    // No frames to slice across: everything above was built synchronously,
    // so the first flush that carried content is also the moment the panel
    // is done mounting.
    markLoaded(state);
  }
}

/**
 * What the animation clock's batches mean in the mirror's vocabulary:
 * `animated` is a style change stretched over time, `animatedSelf` the
 * same confined to the element, `transformed` confined to its transform,
 * `reflow` is rects
 * moving without a mutation — a settling transform for its own subtree,
 * an animating layout property for everyone.
 *
 * @param {PortalState} state
 * @param {MutationBatch[]} batches
 */
export function applyAnimationBatches(state, batches) {
  projectChanges(state, () => {
    for (const animationBatch of batches) {
      if (animationBatch.types.has("animated") && animationBatch.targets) {
        state.mirror.animatedStyles(animationBatch.targets);
      }
      if (animationBatch.types.has("animatedSelf") && animationBatch.targets) {
        state.mirror.animatedStyles(animationBatch.targets, { subtree: false });
      }
      if (animationBatch.types.has("transformed") && animationBatch.targets) {
        state.mirror.transformed(animationBatch.targets);
      }
      if (animationBatch.types.has("reflow")) {
        state.mirror.reflowed(animationBatch.targets);
      }
    }
  });
}

/**
 * A scroll mutates nothing — no attribute, no child, no character — so the
 * observer never hears about it. What it does change is exactly one thing
 * the mirror keeps: the scroller's offset signal. Everything that follows —
 * the content group sliding, the clip boxes of the scrolled subtree, the
 * culling at the window's edges — derives from that signal as arithmetic
 * on cached values; nothing is re-measured, however long the list is. The
 * listener is capturing because scroll events do not bubble.
 *
 * @param {PortalState} state
 * @param {Event} event
 */
export function scrollCallback(state, event) {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  projectChanges(state, () => {
    state.mirror.scrolled(target);
  });
  // A scroll settles synchronously, budget or no budget. Everything the
  // offset moves is arithmetic on cached values, cheap by the mirror's own
  // design; what a budget would buy here is not a smoother frame but a
  // torn one, the content sliding in this frame and its clipping catching
  // up over the next several, because the translation is one shallow task
  // and the clipping is one per row. An interaction has to land whole in
  // the frame that carries it; deferral is for content changes, which
  // nobody's hand is resting on. The flush drains whatever else the
  // channel holds along with it — the queue cannot take one signal's
  // consequences and leave another's — which is the accepted cost of a
  // hand on the panel, and no more than every scroll cost before the panel
  // learned to defer at all.
  state.channel?.flush({ budget: Infinity });
  state.motionChannel?.flush({ budget: Infinity });
  // Content has moved out from under a ray that did not move with it. The
  // manager only recasts when a hand moves or when it is told the scene
  // changed, and this is the second case.
  state.interactionManager.updateIntersections();
}
