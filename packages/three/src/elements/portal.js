import * as THREE from "three";
import { batch, observable, Signal, UpdateChannel, withChannel } from "@apendua/signal";
import { div, getContentGroup, PortalReadyContext } from "./div.js";
import { text } from "./text.js";
import { checkbox } from "./checkbox.js";
import { createMirror, getBorderBoxSize, PORTAL_ATTRIBUTE } from "./mirror.js";
import { createAnimationClock } from "./animationClock.js";
import { watchDocumentStyles } from "./documentStyles.js";
import { createBlocker, coverBox } from "./blocker.js";
import { BoxBatchContext, createBoxBatch } from "./boxBatch.js";
import { TextBatchContext, createTextBatch } from "./textBatch.js";
import { TextScaleContext, createTextScale } from "./textScale.js";
import { keepSubtreeMatrices, placeAndScale } from "./place.js";
import { createFrameRequester } from "./frameRequester.js";
import { createPortalPump } from "./portalPump.js";
import { createPortalScheduler, PortalSchedulerContext } from "./portalScheduler.js";
import { CameraContext, frames, onLateFrame, RendererContext } from "../render.js";
import { InteractionContext } from "../interactions.js";

/**
 * @import {Mountable} from '../core.js';
 * @import {Object3D} from 'three';
 * @import {MutationBatch} from './animationClock.js';
 * @import {PortalScheduler} from './portalScheduler.js';
 */

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

/**
 * @typedef {object} PortalOptions
 * @property {boolean} [opaqueToRays] Whether the panel stops rays that land on
 *   it. True by default, which is what any panel with something to press wants.
 *   False leaves the portal drawn but untouchable, for a readout the player
 *   only looks at — a head-locked overlay in particular, which sits between
 *   the eye and everything else and would otherwise be in the way of every
 *   ray that crossed it.
 * @property {number | (() => number)} [budget] Milliseconds of each frame the
 *   portal may spend mounting and settling content, **when it paces
 *   itself** — a portal built outside a rendering context, with no shared
 *   scheduler to answer to. Under `render()` the budget is the scene's, not
 *   the panel's: one pool per frame divided across every portal (see
 *   `RenderOptions.portalBudget`), because three panels each honouring a
 *   private five milliseconds would cost the shared frame fifteen — and this
 *   option is ignored. It bounds when work stops being *started*, not how
 *   long a piece takes: at least one node is built and at least one update
 *   runs per frame, so a single expensive node overshoots the budget rather
 *   than stalling forever. 5 by default. A getter is read at the top of
 *   every pump frame, which keeps the time-versus-smoothness trade a live
 *   one — the same contract as `makeInteractive`.
 * @property {number} [priority] This portal's say in the shared pool: pumps
 *   of higher priority are offered each frame's budget before lower ones,
 *   so a panel the player is waiting on can be told to finish first — and
 *   starving the others meanwhile is then the point, not a hazard. Within a
 *   priority the offer rotates frame by frame, so equals share the pool and
 *   none waits forever on a peer. 0 by default.
 * @property {number} [maxTextScale] The most device pixels this panel's text
 *   is rasterized for each of its CSS pixels. Measured per panel by default
 *   (`textScale.js` says how) and capped at 4, which is what a panel of a
 *   few dozen labels should be left alone to do. Lower it for a panel that
 *   would rather be soft than large: what a step costs is quadratic in it,
 *   and a list of hundreds of rows reaches the ceiling with every one of
 *   them at once — the array texture behind it, the mirror of that array,
 *   and the canvas each run keeps, all sixteen times what they were. 2 is
 *   the setting for such a panel; 1 turns the measurement off in all but
 *   name. Never raises: 4 is what a run is allowed to cost at all.
 * @property {(loading: boolean) => void} [onLoadingChanged] Told when the
 *   panel finishes mounting its initial content. Fires once, with `false`:
 *   the loading state starts true and never comes back, because a panel that
 *   is already visible absorbs later updates incrementally instead of hiding
 *   itself again. For showing a spinner somewhere; `isLoading()` on the
 *   handle is the reactive way to ask.
 */

/**
 * @param {WeakKey} ctx
 * @param {PortalOptions} [options]
 */
export function createPortal(
  ctx,
  { opaqueToRays = true, budget = 5, priority = 0, maxTextScale, onLoadingChanged } = {},
) {
  const containerObject = new THREE.Group();

  // Nothing to see until the initial content has fully mounted: the panel
  // would otherwise assemble itself in front of the player, boxes first, text
  // a few frames later. `markLoaded` below is what shows it.
  containerObject.visible = false;

  // The panel's perimeter. Everything the portal draws hangs off this, and
  // everything it draws keeps its own matrices; this is what makes that hold
  // whatever the scene above the panel does about its own.
  keepSubtreeMatrices(containerObject);

  /**
   * The boxes of this panel, drawn together rather than one at a time. Its
   * own, not shared with other portals: the buckets hang off this container,
   * so their instance matrices are in its frame, and a panel is the unit that
   * comes and goes.
   */
  const boxBatch = createBoxBatch(containerObject);

  /**
   * And its text, drawn from arrays of exactly-sized runs rather than a
   * texture apiece. Kept separate from the boxes' batch because what they
   * batch by is different — a box is described by numbers, a run by pixels —
   * even though both hang off this container and both follow the same walk.
   */
  const textBatch = createTextBatch(containerObject);

  // Everything this portal projects is built with the batches in scope. The
  // context is derived rather than mutated, so a second portal built from the
  // same `ctx` gets its own and neither can see the other's.
  ctx = BoxBatchContext.set(ctx, boxBatch);
  ctx = TextBatchContext.set(ctx, textBatch);

  /**
   * How finely this panel's text is worth rasterizing, measured off what the
   * panel is really painting rather than guessed from the page. Null where
   * there is nothing to measure against — a portal on a plain page, or under
   * a test runner — and the runs then fall back to the page's own device
   * pixel ratio, which is the right answer when the panel *is* the page.
   *
   * @type {ReturnType<typeof createTextScale> | null}
   */
  let textScale = null;
  try {
    textScale = createTextScale(
      containerObject,
      RendererContext.get(ctx),
      CameraContext.get(ctx),
      maxTextScale,
    );
    ctx = TextScaleContext.set(ctx, textScale.read);
  } catch {
    // No renderer or camera on this context. Same shape of absence the late
    // frame hook below is written for, and the same answer: the panel does
    // without.
  }

  /**
   * Whether the panel is still mounting its initial content. True from the
   * start; flipped exactly once, by `markLoaded`, when everything the first
   * mount brought has been built and the reactive graph over it has settled.
   *
   * @type {Signal<boolean>}
   */
  const loading = Signal.of(true);

  // Interactive elements ask this before registering as ray targets. The
  // raycast set is flat — an ancestor's `visible` shields nothing that
  // registered itself — so hiding the container above is only half of the
  // loading state; the other half is the buttons holding off until the panel
  // is actually there to press.
  ctx = PortalReadyContext.set(ctx, () => !loading.get());

  // What a batch owes gets paid at the end of the frame, before anything is
  // drawn. Most of what invalidates a batch arrives as its own task and is
  // settled by the microtask the batch queues for itself; what arrives from
  // inside the frame callback — a sampled CSS animation, a scroll drag in an
  // immersive session — is not, and would otherwise be drawn a frame late.
  const flushBatches = () => {
    // First, so that a step the panel has just crossed is one the runs
    // re-rasterize against rather than one they find out about next frame.
    textScale?.measure();
    boxBatch.flush();
    textBatch.flush();
  };
  /** @type {() => void} */
  let stopFlushing = () => {};
  try {
    stopFlushing = onLateFrame(ctx, flushBatches);
  } catch {
    // No renderer to take frames from — a portal on a plain page, or under a
    // test runner. Nothing invalidates a batch from inside a frame there,
    // because there are no frames, so the microtask is the whole mechanism
    // and is enough on its own.
  }

  /** @type {WeakMap<Node, Object3D>} */
  const nodeToObject = new WeakMap();

  /** @type {WeakMap<Object3D, Node>} */
  const objectToNode = new WeakMap();

  /** @type {WeakMap<Object3D, () => void>} */
  const objectToCleanup = new WeakMap();

  /**
   * The reactive state of everything this portal projects. Every mutation,
   * scroll, animation sample and load below is routed through it — inside a
   * signal `batch()`, so however much one flush touches, the reactive graph
   * settles once — and every cached read the element components make comes
   * back out of it.
   */
  const mirror = createMirror();

  // The DOM root everything this portal projects lives under, and the root
  // of the object tree it is projected into.
  const containerElement = document.createElement("div");
  containerElement.setAttribute(PORTAL_ATTRIBUTE, "");
  containerElement.style.position = "absolute";
  containerElement.style.top = "0";
  containerElement.style.left = "0";
  containerElement.style.visibility = "hidden";
  document.body.appendChild(containerElement);
  mirror.adopt(containerElement);
  nodeToObject.set(containerElement, containerObject);
  objectToNode.set(containerObject, containerElement);

  const interactionManager = InteractionContext.get(ctx);

  // With only clickable elements as ray targets (see div.js), the portal
  // still has to be opaque to rays as a whole — a panel should block the
  // scene behind it, and a miss between two buttons should not click the
  // board. One invisible plane spanning the container does that, and doubles
  // as the single "background" hit target instead of dozens of divs.
  //
  // A panel that says it is not opaque to rays goes without the plane
  // altogether rather than with an unregistered one: nothing hits it, so
  // there is no background to cover and nothing to keep in step with the
  // panel's size.
  const blocker = opaqueToRays ? createBlocker() : null;
  if (blocker) {
    containerObject.add(blocker);
    // Not a ray target yet: the raycast set is flat, so the container being
    // invisible would not shield the plane, and a loading panel would block
    // rays before there was anything visible to block them for. `markLoaded`
    // registers it with everything else.

    // Hitting the background is a fact the DOM inside the portal is entitled
    // to hear about: it is what "clicked outside" means to a menu that wants
    // to close itself, and there is no other way for it to learn that the ray
    // landed on the panel rather than on one of its buttons. The event bubbles
    // out of the container to `document` like any other.
    //
    // Deliberately without stopping propagation: a panel the scene made
    // grabbable is still grabbable by its background, which is how it behaved
    // before there was anything listening here at all.
    blocker.addEventListener("select", () => {
      containerElement.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  // Shared by everything here that has to wait for a frame rather than be
  // told about something: the pump below, the animation clock, which samples
  // styles while they move, and the images further down, which have arrived
  // and want announcing once rather than each.
  const requestFrames = createFrameRequester(ctx);

  // Whether this environment can hand out frames at all. Slicing work across
  // frames only makes sense where frames exist; under a test runner with
  // neither a renderer nor `requestAnimationFrame`, the sliced path would
  // wait forever on a frame that never comes, so the portal falls back to
  // mounting synchronously, exactly as it did before it learned to slice.
  let hasFrames = false;
  try {
    frames(ctx);
    hasFrames = true;
  } catch {
    hasFrames = typeof requestAnimationFrame === "function";
  }

  /**
   * The panel's own update channel. Everything the portal derives — layout,
   * geometry, text runs — is built into it, which is what lets a big mount be
   * spread over frames: invalidations pile up here instead of running at the
   * end of every batch, and the pump below drains them a budget's worth at a
   * time.
   *
   * Manual rather than triggered, because the pump divides one frame budget
   * between two jobs — building queued nodes and draining this channel — and
   * a channel that flushed itself on its own trigger would spend the whole
   * budget without asking. `maxStalePasses: Infinity` for the same reason: a
   * large mount legitimately overruns the budget many frames in a row, and
   * the catch-up drain the default would force is precisely the stall this
   * exists to avoid.
   *
   * Atomic, because a panel is one surface. A budget spent running the
   * effects moved the boxes it reached and left the rest where they were, so
   * an update too big for one frame arrived as a wave — rows sliding a few
   * at a time — where the initial mount, hidden until everything had
   * settled, arrived whole. An atomic channel spends the budget on what the
   * effects *read* instead — the measuring and the rasterizing, which is
   * where a panel's cost is — and runs the effects together, in the frame
   * that finds nothing left to read. Until then the panel stands as it was.
   * The objects the pump builds meanwhile, and the ones whose nodes left,
   * wait for that same frame; see `commit` below.
   *
   * Null where there are no frames — see above — and every `withChannel`
   * below degrades to the default channel, which is synchronous mounting.
   *
   * @type {UpdateChannel | null}
   */
  const channel = hasFrames
    ? new UpdateChannel({
        name: "portal",
        order: 1,
        manual: true,
        atomic: true,
        maxStalePasses: Infinity,
      })
    : null;

  /**
   * Who paces this portal. The scheduler `render()` installed, whenever
   * there is one — that is what makes the budget global, one pool of frame
   * time divided across every panel in the scene, because the frame the
   * budget guards is shared and three panels each honouring a private five
   * milliseconds would cost it fifteen. A portal built outside a rendering
   * context — a test runner, a plain page — paces itself with a private
   * scheduler instead, and only there does this portal's own `budget`
   * option govern; under a shared scheduler the pool is the scheduler's,
   * and this portal's say in it is `priority`.
   *
   * @type {PortalScheduler | null}
   */
  const scheduler = !hasFrames
    ? null
    : (PortalSchedulerContext.get(ctx) ??
      createPortalScheduler({
        budget,
        requestFrames,
      }));

  /**
   * Run a change to the panel's state as one transaction in the panel's own
   * region: `batch()` is what settles the reactive graph once however much
   * the change touches, and the channel is where every invalidation it
   * causes queues, for the pump to drain a budget's worth per frame. With no
   * channel — no frames — this degrades to a plain batch, which runs the
   * consequences at its end, synchronously, exactly as the portal always
   * did.
   *
   * @param {() => void} fn
   */
  const projectChanges = (fn) => withChannel(channel, () => batch(fn));

  /**
   * Take down everything the portal made for a node and for everything under
   * it: the subscription that keeps each object in step with its element,
   * and with it the object's place in the raycast set.
   *
   * Descendants are looked for in two places, and both are needed. The DOM
   * is the obvious one — but by the time a portal is told to disconnect, the
   * component that owned the tree has usually unmounted its nodes already,
   * so the container is empty and a walk of it reaches nothing. The object
   * graph is the copy that outlives that: every element still has its
   * object, hanging off its parent's content group, still subscribed and
   * still registered as a ray target.
   *
   * Left uncleaned they are ghosts of the worst kind — detached from the
   * scene so nothing draws them, detached from the document so nothing
   * restyles them, but still hit-tested and still sitting exactly where the
   * panel was. A panel closed and reopened would draw underneath its own
   * ghosts, which take every hover and every click and dispatch them into a
   * dead tree.
   *
   * Both walks are idempotent — the maps are cleared as they go — so a node
   * reachable both ways is cleaned once.
   *
   * @param {Node} node
   */
  function cleanup(node) {
    const object = nodeToObject.get(node);
    if (object) {
      const cleanupFn = objectToCleanup.get(object);
      if (cleanupFn) {
        cleanupFn();
        objectToCleanup.delete(object);
      }
      nodeToObject.delete(node);
      objectToNode.delete(object);
      // A snapshot: tearing an object down detaches it from its parent,
      // which would mutate the array a live walk is reading.
      for (const child of [...getContentGroup(object).children]) {
        const childNode = objectToNode.get(child);
        // A child whose node is still in the tree was moved out of this
        // subtree, not removed with it: its object sits here only until the
        // commit places it under its new parent, and what is under it moved
        // with it. Left alone, subtree and all — and still drawn where it
        // was, which is what the commit is for. Whatever the tree does hold
        // is the other walk's, so this skips nothing that is anybody's to
        // clean.
        if (childNode && !containerElement.contains(childNode)) {
          cleanup(childNode);
        }
      }
    }
    node.childNodes.forEach((childNode) => {
      cleanup(childNode);
    });
  }

  /**
   * Build the object for this one node and nothing below it. The recursion
   * over children is the caller's business, because the two callers want it
   * done differently: the synchronous path walks the subtree here and now,
   * and the pump queues the children to be built a budget per frame.
   *
   * @param {Node} node
   * @returns {THREE.Object3D | undefined}
   */
  function createObjectForNode(node) {
    mirror.adopt(node);
    /** @type {import("@apendua/signal").Subscribable<THREE.Object3D> | undefined} */
    let object$;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = /** @type {HTMLElement} */ (node);
      switch (element.tagName.toLowerCase()) {
        case "input": {
          const input = /** @type {HTMLInputElement} */ (element);
          // Only the checkbox so far. Every other kind of input is a box with
          // chrome inside it that the DOM does not describe — a caret, a
          // slider's thumb, a stepper's arrows — and a box is what `div` draws.
          object$ = input.type === "checkbox" ? checkbox(ctx, input) : div(ctx, element);
          break;
        }
        default: {
          object$ = div(ctx, element);
        }
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      object$ = text(ctx, /** @type {Text} */ (node));
    }
    if (!object$) {
      return undefined;
    }
    /** @type {THREE.Object3D | undefined} */
    let object;
    const subscription = object$.subscribe({
      next: (value) => {
        object = value;
      },
    });
    if (!object) {
      throw new Error("Failed to create Object3D for node");
    }
    nodeToObject.set(node, object);
    objectToNode.set(object, node);
    objectToCleanup.set(object, () => {
      subscription.unsubscribe();
    });
    return object;
  }

  /**
   * @param {Node} node
   * @returns {THREE.Object3D | undefined}
   */
  function getOrCreateObjectForNode(node) {
    if (nodeToObject.has(node)) {
      return nodeToObject.get(node);
    }
    const object = createObjectForNode(node);
    if (!object) {
      return undefined;
    }
    // A box carries its DOM children inside a content group — the group a
    // scroll translates — so that is where they attach.
    const content = getContentGroup(object);
    let childNode = node.firstChild;
    while (childNode) {
      const childObject = getOrCreateObjectForNode(childNode);
      if (childObject) {
        content.add(childObject);
      }
      childNode = childNode.nextSibling;
    }
    return object;
  }

  /**
   * Whether any content has arrived at all. `markLoaded` waits for it: a
   * portal created and left empty has mounted nothing, and declaring it
   * loaded would show a blank panel and register its blocker over whatever
   * is behind it.
   */
  let sawContent = false;

  /**
   * Objects built and not yet in the scene, each with the content group it
   * belongs under, in the order they were built. Held for the commit rather
   * than attached on the spot, so that a row appearing and the rows it
   * pushes down arrive in the same frame — the channel holds the moves, so
   * the scene has to hold the arrivals. Only a pumped portal keeps this
   * list; with no frames to slice across there is nothing to hold for.
   *
   * @type {Array<[parent: Object3D, child: Object3D]>}
   */
  const pendingAttachments = [];

  /**
   * Objects whose nodes left the tree and which are still in the scene, for
   * the same reason: a row leaving and the rows that close over it are one
   * change. Only the object's *place* waits; everything else about it is
   * taken down the moment its node goes — see `detach`.
   *
   * @type {Set<Object3D>}
   */
  const pendingRemovals = new Set();

  /**
   * Put an object where it belongs: now, or at the commit if there is one
   * to wait for. Both callers go through here so that a node re-inserted
   * mid-update and one built by the pump keep the same frame.
   *
   * @param {Object3D} parentObject
   * @param {Object3D} object
   */
  const attach = (parentObject, object) => {
    if (pump) {
      pendingAttachments.push([getContentGroup(parentObject), object]);
    } else {
      getContentGroup(parentObject).add(object);
    }
  };

  /**
   * Take a node's object down. What stands in the scene stays until the
   * commit; everything behind it goes now.
   *
   * The two halves come apart on purpose. An object left standing keeps
   * the removed row on screen until the rows around it close over it, which
   * is the one frame the change should take. Its effects are another
   * matter: still subscribed, they would be queued by the very mutation
   * that removed the node, warmed against DOM that is no longer in the
   * document — a style, a rect, a `Range` measurement, a rasterization,
   * each for nothing — and run in the sweep to write an object about to be
   * taken out. Cleaning up now unsubscribes them before any frame, as the
   * observer callback always did, and leaves the object as it was drawn.
   *
   * A child that *moved* out of the removed subtree — appended elsewhere in
   * the same flush — is still in the tree, and its object is still under
   * this one's content group, its new place being only pending. `cleanup`
   * passes over it, so it stays exactly as drawn until the commit, which
   * puts it where it now belongs before this object is taken down.
   *
   * @param {Node} node
   */
  const detach = (node) => {
    const object = nodeToObject.get(node);
    cleanup(node);
    if (!object) {
      // Nothing was drawn for it — a comment node, or a node that left
      // before its turn — so there is nothing to hold for the commit, and
      // no frame to ask for.
      return;
    }
    if (pump) {
      pendingRemovals.add(object);
    } else {
      object.removeFromParent();
    }
  };

  /**
   * The moment the scene changes: the pump has swept the channel, so every
   * box that moved has moved, and this is what goes with it. Arrivals
   * first, each still checked against the tree, since a node can leave
   * between being built and being placed; then the departures. In that
   * order so that an object moved out of a departing subtree is under its
   * new parent before the old one is taken down, whichever of the two the
   * observer happened to report first.
   */
  const commit = () => {
    const changed = pendingAttachments.length > 0 || pendingRemovals.size > 0;
    for (const [parentObject, object] of pendingAttachments) {
      const node = objectToNode.get(object);
      // `add` is also the move: an object already under this parent goes to
      // the end of its children, which is where a re-appended node went in
      // the tree, and where the batches' walk expects to meet it.
      if (node && containerElement.contains(node)) {
        parentObject.add(object);
      }
    }
    pendingAttachments.length = 0;
    for (const object of pendingRemovals) {
      object.removeFromParent();
    }
    pendingRemovals.clear();
    if (changed) {
      // The batches draw what a walk of the panel finds, and the walk just
      // changed. Every box and run told its batch about itself when it was
      // built — but that rebuild ran while the object was still loose, and
      // found nothing where it now hangs. Without this the new boxes stayed
      // out of the draw until something unrelated restyled the panel, while
      // whatever draws itself appeared at once: text over no card.
      boxBatch.invalidate();
      textBatch.invalidate();
    }
  };

  /**
   * The initial mount is done: show the panel, let its buttons register, and
   * tell whoever wanted telling. Once, ever — a panel that is already visible
   * absorbs later updates incrementally, and taking it off screen for them
   * would be worse than any frame they cost.
   */
  const markLoaded = () => {
    if (!sawContent || !loading.get()) {
      return;
    }
    // The blocker before the flip: flipping `loading` is what lets the
    // panel's own controls register, and the background should be in the
    // raycast set before the things drawn in front of it.
    containerObject.visible = true;
    if (blocker) {
      interactionManager.add(blocker);
    }
    loading.set(false);
    onLoadingChanged?.(false);
  };

  /**
   * Build one queued node, if it is still worth building, and queue its
   * children. One node, deliberately — this is what the budget meters, so it
   * is what the slicing grain has to be. The first version built a queued
   * node's whole subtree in one go, which sliced a burst of sibling rows
   * beautifully and a panel mounted as a single tree not at all: one root,
   * one frame, every cost this exists to spread.
   *
   * A node can leave the tree between being queued and its turn arriving —
   * a spinner replaced by the content it stood for — and building it then
   * would make an object for a ghost; the containment check drops it, and
   * with it the subtree it would have queued.
   *
   * Attachment is the builder's job on this path, and it has to work from
   * both ends: whoever of parent and child is built second finds the other
   * and connects. Children discovered by walking their parent are queued
   * after it, and attach themselves on their own turn. But a node the
   * observer reports directly — content mounted mid-build, a scrollbar
   * appearing the moment layout gives its widget a size — can reach the
   * queue *ahead* of the parent it belongs under, build first, and find no
   * object to attach to. It hangs unparented until the parent's own turn
   * walks its children and adopts any object already built and loose. A
   * first cut assumed queue order alone made the child always second, and
   * every panel whose content arrived while the mount was being sliced lost
   * that content to orphaned objects — built, mirrored, and in no scene.
   *
   * Connecting is not the same as appearing. A child joins its parent's
   * object here and now — the parent is not in the scene either, or is
   * about to be placed with it — but the root of a built branch, whose
   * parent *is* already in the scene, waits for the commit; see `attach`.
   *
   * @param {Node} node
   * @returns {boolean} whether anything was genuinely built
   */
  const buildQueuedNode = (node) => {
    if (!containerElement.contains(node)) {
      // A stale entry — the node left the tree between being queued and its
      // turn. Nothing was built for it, so there is nothing to take down.
      return false;
    }
    const object = nodeToObject.get(node) ?? createObjectForNode(node);
    if (!object) {
      // In the tree but nothing to draw — a comment, and in particular the
      // markers `children()` fences its segments with.
      return false;
    }
    if (!object.parent) {
      const parentObject = node.parentNode ? nodeToObject.get(node.parentNode) : undefined;
      if (parentObject) {
        attach(parentObject, object);
      }
    }
    node.childNodes.forEach((childNode) => {
      const childObject = nodeToObject.get(childNode);
      if (!childObject) {
        // Never built (or a comment, which builds to nothing either way):
        // queue it, and its own turn will attach it — its parent exists now.
        pump?.enqueue(childNode);
      } else if (!childObject.parent) {
        // Built before this parent was — the observer reported it directly,
        // out of tree order — and left loose. Adopt it, subtree and all: its
        // own children attached to *it* on their turns, so the whole branch
        // arrives with it. On the spot rather than at the commit: this
        // object is not in the scene yet itself, so nothing appears early.
        getContentGroup(object).add(childObject);
      }
    });
    return true;
  };

  /**
   * What spreads this portal's work across frames: the queue of nodes
   * waiting to be built, the tick that spends each frame's slice, and the
   * watcher that asks for frames whenever work lands in the channel. Null
   * where there are no frames, in which case everything mounts synchronously
   * and `markLoaded` is called from the mutation callback instead.
   */
  const pump =
    channel && scheduler
      ? createPortalPump({
          channel,
          scheduler,
          priority,
          buildNode: buildQueuedNode,
          onCommit: commit,
          hasPendingCommit: () => pendingAttachments.length > 0 || pendingRemovals.size > 0,
          onSettled: markLoaded,
          // Content appeared or moved under whatever rays are resting on
          // the panel.
          afterTick: () => interactionManager.updateIntersections(),
        })
      : null;

  function resizeCallback() {
    const scale = 0.01;
    const size = getBorderBoxSize(containerElement);
    const sizeX = scale * size.width;
    const sizeY = scale * size.height;
    // The rotation is written first and committed by `placeAndScale` with
    // everything else: setting an Euler keeps the quaternion in step, and the
    // quaternion is what the matrix is composed from.
    //
    // This one object matters out of all proportion to its number. Three
    // recomputes a world matrix for every descendant of anything that
    // recomposed its own — an object that auto-updates sets the flag that
    // forces the whole subtree beneath it — so a container left to itself
    // would hand the entire panel the work its boxes just opted out of.
    containerObject.rotation.set(Math.PI, 0, 0);
    placeAndScale(containerObject, -sizeX / 2, sizeY / 2, 0, scale, scale, scale);
    // The measurement wants the middle of the panel, and the middle moves
    // with the size. In the container's own pixels, which is the frame it is
    // handed back through.
    textScale?.setPanelSize(size.width, size.height);
    // Container-local px units, y down; content sits at negative local z
    // (toward the viewer after the flip above), so +1 puts the blocker just
    // behind everything the portal draws.
    if (blocker) {
      coverBox(blocker, size.width, size.height, 1);
    }
  }

  const resizeSubscription = withChannel(channel, () => observable(resizeCallback).subscribe());

  /**
   * One observer flush, applied as one transaction. The mirror routes each
   * record to the signals of exactly the nodes it names — deduplicating
   * against `oldValue`, so the hover handlers re-asserting an attribute
   * invalidate nothing — and the object tree is reconciled for the nodes
   * that came and went.
   *
   * @param {MutationRecord[]} mutationList
   */
  const mutationCallback = (mutationList) => {
    projectChanges(() => {
      mirror.ingest(mutationList);
      /** @type {Set<Node>} */
      const alreadySeen = new Set();
      for (const mutation of mutationList) {
        if (mutation.type !== "childList") {
          continue;
        }
        sawContent = true;
        const parentObject = nodeToObject.get(mutation.target);
        mutation.addedNodes.forEach((node) => {
          alreadySeen.add(node);
          // A node the portal has never seen goes to the queue and gets
          // built when the pump reaches it — that is the slicing. One it
          // has seen — a reinsertion, a move — already paid its cost and
          // reattaches without queueing, in the frame the rest of the
          // change lands in.
          if (pump && !nodeToObject.has(node)) {
            pump.enqueue(node);
            return;
          }
          const childObject = getOrCreateObjectForNode(node);
          if (childObject && parentObject) {
            attach(parentObject, childObject);
          }
        });
      }
      for (const mutation of mutationList) {
        if (mutation.type !== "childList") {
          continue;
        }
        mutation.removedNodes.forEach((node) => {
          // If this node was added somewhere else it does not make sense to
          // clean it up, so if we detect that it was already seen, we skip it.
          if (!alreadySeen.has(node)) {
            pump?.discard(node);
            detach(node);
          }
        });
      }
    });
    // A class swap is how most transitions begin, and inside an immersive
    // session the mutation is the only trace of one that reaches us: the
    // events that would announce it are dispatched with the rendering
    // updates the session has suspended. Observer callbacks are microtasks
    // and keep arriving, so this is where the clock gets to look.
    animationClock.sweep();
    // Every hand's hit is worked out only when that hand moves, so a menu that
    // opens under a ray resting on the button that opened it would go on
    // reporting the button as hovered until the player twitched. The scene
    // changed under them; ask for the rays to be cast again.
    interactionManager.updateIntersections();
    if (pump) {
      pump.schedule();
    } else {
      // No frames to slice across: everything above was built synchronously,
      // so the first flush that carried content is also the moment the panel
      // is done mounting.
      markLoaded();
    }
  };

  const mutationObserver = new MutationObserver(mutationCallback);
  mutationObserver.observe(containerElement, {
    childList: true,
    subtree: true,
    attributes: true,
    // The old values are what let the mirror tell a write from a change: the
    // hover handlers re-assert `data-xr-*` on every pointer event, and a
    // value that merely got written again invalidates nothing at all.
    attributeOldValue: true,
    characterDataOldValue: true,
    // `style` makes rAF-driven inline-style animation just work: each write
    // is a mutation scoped to the element that moved.
    // `disabled` is here for the checkbox: whether one is a ray target follows
    // it, and it is a reflected attribute, so watching it catches the property
    // assignment as well as setAttribute. Without it a control disabled after
    // mounting would stay pointable until something else happened to restyle.
    attributeFilter: [
      "data-xr-hover",
      "data-xr-active",
      "data-xr-checked",
      "disabled",
      "class",
      "style",
    ],
    characterData: true,
  });

  /**
   * What the animation clock's batches mean in the mirror's vocabulary:
   * `animated` is a style change stretched over time, `reflow` is rects
   * moving without a mutation — a settling transform for its own subtree,
   * an animating layout property for everyone.
   *
   * @param {MutationBatch[]} batches
   */
  const applyAnimationBatches = (batches) => {
    projectChanges(() => {
      for (const animationBatch of batches) {
        if (animationBatch.types.has("animated") && animationBatch.targets) {
          mirror.animatedStyles(animationBatch.targets);
        }
        if (animationBatch.types.has("reflow")) {
          mirror.reflowed(animationBatch.targets);
        }
      }
    });
  };

  // CSS transitions, keyframe animations and Web Animations mutate nothing —
  // the styles move while the DOM holds still — so the observer above never
  // hears about them. The clock samples the animating elements once per
  // frame instead, and requests no frames at all while nothing animates.
  const animationClock = createAnimationClock(
    containerElement,
    (batches) => {
      applyAnimationBatches(batches);
      // Animated content moves under a stationary ray just like mutated
      // content does.
      interactionManager.updateIntersections();
    },
    requestFrames,
  );

  /**
   * A scroll mutates nothing — no attribute, no child, no character — so the
   * observer never hears about it. What it does change is exactly one thing
   * the mirror keeps: the scroller's offset signal. Everything that follows —
   * the content group sliding, the clip boxes of the scrolled subtree, the
   * culling at the window's edges — derives from that signal as arithmetic
   * on cached values; nothing is re-measured, however long the list is. The
   * listener is capturing because scroll events do not bubble.
   *
   * @param {Event} event
   */
  const scrollCallback = (event) => {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    projectChanges(() => {
      mirror.scrolled(target);
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
    channel?.flush({ budget: Infinity });
    // Content has moved out from under a ray that did not move with it. The
    // manager only recasts when a hand moves or when it is told the scene
    // changed, and this is the second case.
    interactionManager.updateIntersections();
  };
  containerElement.addEventListener("scroll", scrollCallback, true);

  /**
   * A frame asked for to announce images that have arrived, and the way to
   * take the request back; null while nothing is waiting to be announced.
   *
   * @type {(() => void) | null}
   */
  let loadFrame = null;

  /**
   * The images waiting to be announced. Kept rather than counted, because
   * where a picture landed decides how far the news travels: one inside a
   * list moves that list's rows, and the panel around it only if the list
   * resized.
   *
   * @type {Set<Node>}
   */
  const loaded = new Set();

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
   */
  const announceLoads = () => {
    // The frame sources this can draw on — the renderer's loop and
    // `requestAnimationFrame` — both deliver asynchronously, so the handle is
    // always in place by the time this reads it.
    loadFrame?.();
    loadFrame = null;
    const arrived = [...loaded];
    loaded.clear();
    projectChanges(() => {
      mirror.contentLoaded(arrived);
    });
    interactionManager.updateIntersections();
  };

  /**
   * An image arriving is the other event the observer cannot see: nothing was
   * mutated and nothing restyled. Capturing, because `load` does not bubble.
   *
   * The picture itself does not come through here — the texture is fetched by
   * URL rather than read off this element, and `image.js` hears the same event
   * for itself. This is only the layout half.
   *
   * @param {Event} event
   */
  const loadCallback = (event) => {
    const target = event.target;
    if (!(target instanceof Node) || target.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    loaded.add(target);
    if (!loadFrame) {
      loadFrame = requestFrames(announceLoads);
    }
  };
  containerElement.addEventListener("load", loadCallback, true);

  function fontLoadingCallback() {
    // Fonts arriving restyle and re-measure everything at once; there is no
    // node to scope that to.
    projectChanges(() => {
      mirror.fontsLoaded();
    });
  }
  if (document.fonts) {
    document.fonts.addEventListener("loadingdone", fontLoadingCallback);
  }

  // The other event with no node to blame: the rules themselves changing. A
  // stylesheet lives in the head, which is nowhere near the subtree the
  // observer above watches, so a library that rewrites a rule while keeping
  // the class name it is behind mutates nothing this panel can see.
  const stopWatchingStyles = watchDocumentStyles(() => {
    projectChanges(() => {
      mirror.documentStylesChanged();
    });
  });

  objectToCleanup.set(containerObject, () => {
    pump?.dispose();
    // Nothing is waiting for a commit that is not going to come. An object
    // built for one is in the tree, where the walk below reaches it — unless
    // its node left in the meantime, in which case `detach` has already
    // cleaned it up. Taken down here regardless: `cleanup` is idempotent,
    // and an object in neither the tree nor the scene is otherwise nobody's.
    for (const [, object] of pendingAttachments) {
      const node = objectToNode.get(object);
      if (node) {
        cleanup(node);
      }
    }
    pendingAttachments.length = 0;
    pendingRemovals.clear();
    if (blocker) {
      // Removing is safe whether `markLoaded` ever added it.
      interactionManager.remove(blocker);
    }
    if (containerElement.parentNode) {
      containerElement.parentNode.removeChild(containerElement);
    }
    if (containerObject.parent) {
      containerObject.parent.remove(containerObject);
    }
    if (document.fonts) {
      document.fonts.removeEventListener("loadingdone", fontLoadingCallback);
    }
    stopWatchingStyles();
    containerElement.removeEventListener("scroll", scrollCallback, true);
    containerElement.removeEventListener("load", loadCallback, true);
    // A frame asked for by an image that landed just as the portal came down.
    loadFrame?.();
    resizeSubscription.unsubscribe();
    mutationObserver.disconnect();
    animationClock.dispose();
    // After the observer, so nothing can ask for a rebuild on the way out.
    stopFlushing();
    boxBatch.dispose();
    textBatch.dispose();
  });

  return {
    /**
     * @param {Object3D} parent
     */
    addTo(parent) {
      parent.add(containerObject);
    },
    /**
     * @param {Mountable} mountable
     */
    mount(mountable) {
      if (containerElement.firstChild && containerElement.lastChild) {
        mountable.replace([containerElement.firstChild, containerElement.lastChild]);
      } else {
        const placeholder = document.createComment("");
        containerElement.appendChild(placeholder);
        mountable.replace([placeholder, placeholder]);
      }
    },
    disconnect() {
      cleanup(containerElement);
    },
    /**
     * Whether the panel is still mounting its initial content. Reactive: a
     * computation that reads it re-runs when the answer changes, which it
     * does exactly once, true to false.
     */
    isLoading() {
      return loading.get();
    },
  };
}
