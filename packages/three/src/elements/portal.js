import * as THREE from "three";
import {
  batch,
  makeNonReactive,
  observable,
  Derived,
  Signal,
  UpdateChannel,
  withChannel,
} from "@apendua/signal";
import { div, getContentGroup, PortalReadyContext } from "./div.js";
import { text } from "./text.js";
import { checkbox } from "./checkbox.js";
import { createMirror, getBorderBoxSize, PORTAL_ATTRIBUTE } from "./mirror.js";
import { createAnimationClock } from "./animationClock.js";
import { createBlocker, coverBox } from "./blocker.js";
import { BoxBatchContext, createBoxBatch } from "./boxBatch.js";
import { TextBatchContext, createTextBatch } from "./textBatch.js";
import { keepSubtreeMatrices, placeAndScale } from "./place.js";
import { createFrameRequester } from "./frameRequester.js";
import { animateLate, frames } from "../render.js";
import { InteractionContext } from "../interactions.js";

/**
 * @import {Observable, Unsubscribable} from 'rxjs';
 * @import {Mountable} from "@apendua/justdom";
 * @import {Object3D} from 'three';
 * @import {MutationBatch} from './animationClock.js';
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
 *   portal may spend mounting and settling content. It bounds when work stops
 *   being *started*, not how long a piece takes: at least one node is built
 *   and at least one update runs per frame, so a single expensive node
 *   overshoots the budget rather than stalling forever. 5 by default — a
 *   third of a 60 Hz frame, leaving room for the app and the renderer.
 *
 *   A getter is read at the top of every pump frame, which makes the
 *   time-versus-smoothness trade a live one: an app can spend generously
 *   while the player is looking at a loading panel, drop to a sliver the
 *   moment a hand is interacting, or say `Infinity` and have the current
 *   mount finish within the next frame. The same contract as
 *   `makeInteractive` — a value for a decision made once, a getter for one
 *   the app keeps making.
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
export function createPortal(ctx, { opaqueToRays = true, budget = 5, onLoadingChanged } = {}) {
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
    boxBatch.flush();
    textBatch.flush();
  };
  /** @type {() => void} */
  let stopFlushing = () => {};
  try {
    const subscription = animateLate(ctx, flushBatches).subscribe();
    stopFlushing = () => subscription.unsubscribe();
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
        maxStalePasses: Infinity,
      })
    : null;

  /**
   * The frame budget, asked for fresh at the top of every pump frame — that
   * is what lets a getter trade mounting speed against frame rate while a
   * mount is in flight. The channel above carries no budget of its own:
   * every flush the portal performs passes one explicitly.
   *
   * @type {() => number}
   */
  const budgetOf = typeof budget === "function" ? budget : () => budget;

  /**
   * Whether any content has arrived at all. `markLoaded` waits for it: a
   * portal created and left empty has mounted nothing, and declaring it
   * loaded would show a blank panel and register its blocker over whatever
   * is behind it.
   */
  let sawContent = false;

  /**
   * DOM roots waiting to be built, in arrival order. Roots rather than
   * nodes: the observer reports what was inserted, and one insertion may
   * carry a whole subtree, which is built as one piece when its turn comes.
   * The set is the same membership, kept so a node cannot be queued twice.
   *
   * @type {Node[]}
   */
  const pendingNodes = [];

  /** @type {Set<Node>} */
  const pendingSet = new Set();

  /** @type {(() => void) | null} */
  let stopPumpTicks = null;

  const stopPump = () => {
    stopPumpTicks?.();
    stopPumpTicks = null;
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
   * Attachment is the builder's job on this path: children are queued after
   * their parent, so by a child's turn the parent's object exists and the
   * content group — the group a scroll translates — is there to attach to.
   *
   * @param {Node} node
   */
  const buildPendingNode = (node) => {
    if (!containerElement.contains(node)) {
      return;
    }
    const object = nodeToObject.get(node) ?? createObjectForNode(node);
    if (object && !object.parent) {
      const parentObject = node.parentNode ? nodeToObject.get(node.parentNode) : undefined;
      if (parentObject) {
        getContentGroup(parentObject).add(object);
      }
    }
    node.childNodes.forEach((childNode) => {
      if (!nodeToObject.has(childNode) && !pendingSet.has(childNode)) {
        pendingSet.add(childNode);
        pendingNodes.push(childNode);
      }
    });
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
   * One frame's worth of mounting: build queued roots until the budget is
   * spent, hand what is left of it to the channel, and when both are empty,
   * declare the panel loaded. At least one root and at least one update per
   * frame regardless of the budget, so progress cannot stall however small
   * the number.
   */
  const pumpTick = () => {
    if (!channel) {
      return;
    }
    const now = channel.now;
    const deadline = now() + budgetOf();
    if (pendingNodes.length > 0) {
      batch(() => {
        withChannel(channel, () => {
          do {
            const node = pendingNodes.shift();
            if (node) {
              pendingSet.delete(node);
              buildPendingNode(node);
            }
          } while (pendingNodes.length > 0 && now() < deadline);
        });
      });
    }
    // In the channel, because draining can build: a node re-deriving its
    // layout constructs computations of its own, and those belong to the
    // panel's region like everything else here.
    withChannel(channel, () => {
      channel.flush({ budget: Math.max(deadline - now(), 0) });
    });
    // Content appeared or moved under whatever rays are resting on the panel.
    interactionManager.updateIntersections();
    if (pendingNodes.length === 0 && channel.pendingCount === 0) {
      stopPump();
      markLoaded();
      // Loading flipping to false is itself a change the graph answers —
      // the gated ray targets re-evaluate their conditions — and the answer
      // lands right back in this channel. Check directly rather than trust
      // the watcher below: the flip happened mid-tick, and a notification
      // collapsed by the queue's own bookkeeping must not strand the work.
      if (channel.pendingCount > 0) {
        schedulePump();
      }
    }
  };

  const schedulePump = () => {
    if (channel && !stopPumpTicks) {
      stopPumpTicks = requestFrames(pumpTick);
    }
  };

  /** @type {Unsubscribable | null} */
  let pendingWatchSubscription = null;
  if (channel) {
    // Work landing in the channel while no pump is running — a scroll, an
    // attribute flip, anything after the initial mount — must start one. The
    // watcher lives in the *default* channel, necessarily: a computation
    // inside the channel saying "the channel has work" would itself be the
    // work, waiting for the pump it exists to start.
    //
    // Never-equal, deliberately. The flag can go true and back mid-flush,
    // and the two announcements can collapse into one evaluation that finds
    // the cached value again; an equality gate would swallow exactly the
    // notification that carries "there is work now".
    const pendingWatch = withChannel(
      null,
      () =>
        new Derived(() => channel.hasPendingUpdates, {
          isEqual: () => false,
        }),
    );
    pendingWatchSubscription = pendingWatch.subscribe({
      next: () => {
        if (pendingWatch.get()) {
          schedulePump();
        }
      },
    });
    // Prime it: a Derived computes on first read, and the watcher must be
    // watching before the first mutation arrives. Non-reactively, and that
    // is load-bearing: `createPortal` is itself called inside a computation
    // — `dom()` builds the portal in an effect — and a bare read here would
    // make that computation depend on the never-equal watcher, tearing the
    // portal down and rebuilding it on every toggle of its own channel.
    makeNonReactive(() => pendingWatch.get())();
  }

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
        if (childNode) {
          cleanup(childNode);
        }
      }
    }
    node.childNodes.forEach((childNode) => {
      cleanup(childNode);
    });
  }

  /**
   * @param {Node} node
   * @returns {THREE.Object3D | undefined}
   */
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
    /** @type {Observable<THREE.Object3D> | undefined} */
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

  const containerElement = document.createElement("div");
  containerElement.setAttribute(PORTAL_ATTRIBUTE, "");
  containerElement.style.position = "absolute";
  containerElement.style.top = "0";
  containerElement.style.left = "0";
  containerElement.style.visibility = "hidden";
  document.body.appendChild(containerElement);
  mirror.adopt(containerElement);

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
   * that came and went. Wrapping the whole thing in `batch()` is what turns
   * a flush of many records into a single settling of the reactive graph.
   *
   * @param {MutationRecord[]} mutationList
   */
  const mutationCallback = (mutationList) => {
    // In the channel: the mirror's ingest reads and writes signals whose
    // dependents are the panel's own computations, and those must queue in
    // the channel rather than run at the end of this batch.
    withChannel(channel, () => {
      batch(() => {
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
            // reattaches on the spot.
            if (channel && !nodeToObject.has(node)) {
              if (!pendingSet.has(node)) {
                pendingSet.add(node);
                pendingNodes.push(node);
              }
              return;
            }
            const childObject = getOrCreateObjectForNode(node);
            if (childObject && parentObject) {
              getContentGroup(parentObject).add(childObject);
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
              // Un-queue it rather than build a ghost. The array keeps its
              // entry — `buildPendingNode` skips what left the tree — but the
              // membership must go, or a node removed and re-added would be
              // refused the queue the second time.
              pendingSet.delete(node);
              const childObject = nodeToObject.get(node);
              childObject?.removeFromParent();
              cleanup(node);
            }
          });
        }
      });
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
    if (channel) {
      if (pendingNodes.length > 0 || channel.pendingCount > 0) {
        schedulePump();
      }
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
    withChannel(channel, () => {
      batch(() => {
        for (const animationBatch of batches) {
          if (animationBatch.types.has("animated") && animationBatch.targets) {
            mirror.animatedStyles(animationBatch.targets);
          }
          if (animationBatch.types.has("reflow")) {
            mirror.reflowed(animationBatch.targets);
          }
        }
      });
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
    withChannel(channel, () => {
      batch(() => {
        mirror.scrolled(target);
      });
    });
    // A scroll settles synchronously, budget or no budget. Everything the
    // offset moves — the content group's translation, the clip boxes of the
    // scrolled subtree, the culling at the window's edges — is arithmetic on
    // cached values, cheap by the mirror's own design; what a budget would
    // buy here is not a smoother frame but a torn one, the content sliding
    // in this frame and its clipping catching up over the next several,
    // because the translation is one shallow task and the clipping is one
    // per row. An interaction has to land whole in the frame that carries
    // it; deferral is for content changes, which nobody's hand is resting
    // on. The flush drains whatever else the channel holds along with it —
    // the queue cannot take one signal's consequences and leave another's —
    // which is the accepted cost of a hand on the panel, and no more than
    // every scroll cost before the panel learned to defer at all.
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
    withChannel(channel, () => {
      batch(() => {
        mirror.contentLoaded(arrived);
      });
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
    withChannel(channel, () => {
      batch(() => {
        mirror.fontsLoaded();
      });
    });
  }
  if (document.fonts) {
    document.fonts.addEventListener("loadingdone", fontLoadingCallback);
  }

  objectToCleanup.set(containerObject, () => {
    stopPump();
    pendingWatchSubscription?.unsubscribe();
    pendingNodes.length = 0;
    pendingSet.clear();
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
  nodeToObject.set(containerElement, containerObject);
  objectToNode.set(containerObject, containerElement);

  return {
    /**
     * @param {Object3D} parent
     */
    addTo(parent) {
      parent.add(containerObject);
    },
    /**
     * @param {Mountable<Node>} mountable
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
