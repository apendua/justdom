import * as THREE from "three";
import { batch, observable } from "@apendua/signal";
import { div, getContentGroup } from "./div.js";
import { text } from "./text.js";
import { checkbox } from "./checkbox.js";
import { createMirror, getBorderBoxSize, PORTAL_ATTRIBUTE } from "./mirror.js";
import { createAnimationClock } from "./animationClock.js";
import { createBlocker, coverBox } from "./blocker.js";
import { createFrameRequester } from "./frameRequester.js";
import { InteractionContext } from "../interactions.js";

/**
 * @import {Observable} from 'rxjs';
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
 */

/**
 * @param {WeakKey} ctx
 * @param {PortalOptions} [options]
 */
export function createPortal(ctx, { opaqueToRays = true } = {}) {
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
  function getOrCreateObjectForNode(node) {
    if (nodeToObject.has(node)) {
      return nodeToObject.get(node);
    }
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

  const containerObject = new THREE.Group();

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
    interactionManager.add(blocker);

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
    containerObject.scale.set(scale, scale, scale);
    containerObject.rotation.set(Math.PI, 0, 0);
    containerObject.position.set(-sizeX / 2, sizeY / 2, 0);
    // Container-local px units, y down; content sits at negative local z
    // (toward the viewer after the flip above), so +1 puts the blocker just
    // behind everything the portal draws.
    if (blocker) {
      coverBox(blocker, size.width, size.height, 1);
    }
  }

  const resizeSubscription = observable(resizeCallback).subscribe();

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
    batch(() => {
      mirror.ingest(mutationList);
      /** @type {Set<Node>} */
      const alreadySeen = new Set();
      for (const mutation of mutationList) {
        if (mutation.type !== "childList") {
          continue;
        }
        const parentObject = nodeToObject.get(mutation.target);
        mutation.addedNodes.forEach((node) => {
          alreadySeen.add(node);
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
            const childObject = nodeToObject.get(node);
            childObject?.removeFromParent();
            cleanup(node);
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

  // Shared by everything here that has to wait for a frame rather than be
  // told about something: the animation clock, which samples styles while
  // they move, and the images below, which have arrived and want announcing
  // once rather than each.
  const requestFrames = createFrameRequester(ctx);

  /**
   * What the animation clock's batches mean in the mirror's vocabulary:
   * `animated` is a style change stretched over time, `reflow` is rects
   * moving without a mutation — a settling transform for its own subtree,
   * an animating layout property for everyone.
   *
   * @param {MutationBatch[]} batches
   */
  const applyAnimationBatches = (batches) => {
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
    batch(() => {
      mirror.scrolled(target);
    });
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
   * Say that images have arrived — once for however many of them did.
   *
   * The announcement is portal-wide, and has to be: an `<img>` the author gave
   * no size to has just been handed one by the picture, and everything after
   * it in the flow has moved. That makes each one as expensive as a font
   * arriving, and unlike fonts they arrive one at a time — a panel of nine
   * icons announced nine reflows of everything, back to back, for a layout
   * that settled once. Coalescing them costs a frame nobody was waiting on,
   * because a picture that has just decoded cannot be on screen before the
   * next one anyway.
   */
  const announceLoads = () => {
    // The frame sources this can draw on — the renderer's loop and
    // `requestAnimationFrame` — both deliver asynchronously, so the handle is
    // always in place by the time this reads it.
    loadFrame?.();
    loadFrame = null;
    batch(() => {
      mirror.contentLoaded();
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
    if (!loadFrame) {
      loadFrame = requestFrames(announceLoads);
    }
  };
  containerElement.addEventListener("load", loadCallback, true);

  function fontLoadingCallback() {
    // Fonts arriving restyle and re-measure everything at once; there is no
    // node to scope that to.
    batch(() => {
      mirror.fontsLoaded();
    });
  }
  if (document.fonts) {
    document.fonts.addEventListener("loadingdone", fontLoadingCallback);
  }

  objectToCleanup.set(containerObject, () => {
    if (blocker) {
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
  };
}
