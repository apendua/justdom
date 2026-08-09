import * as THREE from "three";
import { observable } from "@apendua/signal";
import { Subject } from "rxjs";
import { div } from "./div.js";
import { text } from "./text.js";
import { getBoundingClientRectCached, PORTAL_ATTRIBUTE, setSubject } from "./cache.js";
import { createAnimationClock } from "./animationClock.js";
import { createBlocker, coverBox } from "./blocker.js";
import { createFrameRequester } from "./frameRequester.js";
import { InteractionContext } from "../interactions.js";

/**
 * @import {Observable} from 'rxjs';
 * @import {Mountable} from "@apendua/justdom";
 * @import {Object3D} from 'three';
 * @import {MutationBatch, MutationType} from './cache.js';
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
 * @param {WeakKey} ctx
 */
export function createPortal(ctx) {
  /** @type {WeakMap<Node, Object3D>} */
  const nodeToObject = new WeakMap();

  /** @type {WeakMap<Object3D, Node>} */
  const objectToNode = new WeakMap();

  /** @type {WeakMap<Object3D, () => void>} */
  const objectToCleanup = new WeakMap();

  /** @type {Subject<MutationBatch>} */
  const subject = new Subject();

  /**
   * @param {MutationBatch} batch
   */
  function invalidateLayout(batch) {
    subject.next(batch);
  }

  /**
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
      object.children.forEach((child) => {
        const childNode = objectToNode.get(child);
        if (childNode) {
          cleanup(childNode);
        }
      });
      nodeToObject.delete(node);
      objectToNode.delete(object);
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
    setSubject(node, subject);
    /** @type {Observable<THREE.Object3D> | undefined} */
    let object$;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = /** @type {HTMLElement} */ (node);
      switch (element.tagName.toLowerCase()) {
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
    let childNode = node.firstChild;
    while (childNode) {
      const childObject = getOrCreateObjectForNode(childNode);
      if (childObject) {
        object.add(childObject);
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
  setSubject(containerElement, subject);

  const containerObject = new THREE.Group();

  // With only clickable elements as ray targets (see div.js), the portal
  // still has to be opaque to rays as a whole — a panel should block the
  // scene behind it, and a miss between two buttons should not click the
  // board. One invisible plane spanning the container does that, and doubles
  // as the single "background" hit target instead of dozens of divs.
  const blocker = createBlocker();
  containerObject.add(blocker);
  const interactionManager = InteractionContext.get(ctx);
  interactionManager.add(blocker);

  // Hitting the background is a fact the DOM inside the portal is entitled to
  // hear about: it is what "clicked outside" means to a menu that wants to
  // close itself, and there is no other way for it to learn that the ray
  // landed on the panel rather than on one of its buttons. The event bubbles
  // out of the container to `document` like any other.
  //
  // Deliberately without stopping propagation: a panel the scene made
  // grabbable is still grabbable by its background, which is how it behaved
  // before there was anything listening here at all.
  blocker.addEventListener("select", () => {
    containerElement.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  function resizeCallback() {
    const scale = 0.01;
    const boundingRect = getBoundingClientRectCached(containerElement);
    const sizeX = scale * boundingRect.width;
    const sizeY = scale * boundingRect.height;
    containerObject.scale.set(scale, scale, scale);
    containerObject.rotation.set(Math.PI, 0, 0);
    containerObject.position.set(-sizeX / 2, sizeY / 2, 0);
    // Container-local px units, y down; content sits at negative local z
    // (toward the viewer after the flip above), so +1 puts the blocker just
    // behind everything the portal draws.
    coverBox(blocker, boundingRect.width, boundingRect.height, 1);
  }

  const resizeSubscription = observable(resizeCallback).subscribe();

  /**
   * @param {MutationRecord[]} mutationList
   */
  const mutationCallback = (mutationList) => {
    /** @type {Set<Node>} */
    const alreadySeen = new Set();
    /** @type {Set<MutationType>} */
    const types = new Set();
    // The records already say where each mutation happened — the mutated
    // element for `attributes`, the parent for `childList`, the text node for
    // `characterData` — so pass that along and let each cache decide how far
    // a change at that node can reach, instead of treating every mutation as
    // portal-wide.
    /** @type {Set<Node>} */
    const targets = new Set();
    for (const mutation of mutationList) {
      const parentObject = nodeToObject.get(mutation.target);
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          alreadySeen.add(node);
          const childObject = getOrCreateObjectForNode(node);
          if (childObject && parentObject) {
            parentObject.add(childObject);
          }
        });
      }
      types.add(mutation.type);
      targets.add(mutation.target);
    }
    for (const mutation of mutationList) {
      const parentObject = nodeToObject.get(mutation.target);
      if (mutation.type === "childList") {
        mutation.removedNodes.forEach((node) => {
          // If this node was added somewhere else it does not make sense to clean it up,
          // so if we detect that it was already seen, we skip it.
          if (!alreadySeen.has(node)) {
            const childObject = nodeToObject.get(node);
            if (childObject && parentObject) {
              parentObject.remove(childObject);
            }
            cleanup(node);
          }
        });
      }
    }
    invalidateLayout({ types, targets });
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
    // `style` makes rAF-driven inline-style animation just work: each write
    // is a mutation scoped to the element that moved. Safe now that
    // invalidation is per-target — before that, every inline write would
    // have re-read the whole portal.
    attributeFilter: ["data-xr-hover", "data-xr-active", "class", "style"],
    characterData: true,
  });

  // Shared by everything here that has to wait for a frame rather than be
  // told about something: the animation clock, which samples styles while
  // they move, and the images below, which have arrived and want announcing
  // once rather than each.
  const requestFrames = createFrameRequester(ctx);

  // CSS transitions, keyframe animations and Web Animations mutate nothing —
  // the styles move while the DOM holds still — so the observer above never
  // hears about them. The clock samples the animating elements once per
  // frame instead, and requests no frames at all while nothing animates.
  const animationClock = createAnimationClock(
    containerElement,
    (batches) => {
      for (const batch of batches) {
        invalidateLayout(batch);
      }
      // Animated content moves under a stationary ray just like mutated
      // content does.
      interactionManager.updateIntersections();
    },
    requestFrames,
  );

  /**
   * A scroll mutates nothing — no attribute, no child, no character — so the
   * observer never hears about it, and the animation clock has no animation
   * to sample. What it does do is move every client rect inside the scroller,
   * which `scroll` says, scoped to the subtree that moved — the tightest
   * scope any batch in this file carries. The listener is capturing because
   * scroll events do not bubble.
   *
   * @param {Event} event
   */
  const scrollCallback = (event) => {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    invalidateLayout({ types: new Set(["scroll"]), targets: new Set([target]) });
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
    invalidateLayout({ types: new Set(["load"]), targets: null });
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
    // `nodeType` rather than `instanceof Element`, for the reason `cache.js`
    // gives: `Element` is not a global everywhere this runs, and reaching for
    // one that is missing throws inside an event listener, where nothing is
    // listening for the error either.
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
    invalidateLayout({ types: new Set(["fontLoaded"]), targets: null });
  }
  if (document.fonts) {
    document.fonts.addEventListener("loadingdone", fontLoadingCallback);
  }

  objectToCleanup.set(containerObject, () => {
    interactionManager.remove(blocker);
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
