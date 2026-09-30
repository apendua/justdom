import * as THREE from "three";
import { withComputation } from "@apendua/signal";
import { InteractionContext } from "../interactions.js";
import { getParentObject } from "./contentGroup.js";
import { initialDropEffect, PanelDataTransfer, resolveOperation } from "./dataTransfer.js";
import { createFrameRequester } from "./frameRequester.js";
import {
  getBorderBoxSize,
  getComputedStyleCached,
  getLocalClipBox,
  getParentElement,
  isVisibilityHidden,
  PORTAL_ATTRIBUTE,
} from "./mirror.js";
import { placeAndScale } from "./place.js";
import { isSvgRoot } from "./plugins.js";
import { DRAG_THRESHOLD, planeOf } from "./scroll.js";
import { createRectMaterial, rectGeometry } from "./sdfRect.js";

/**
 * @import {DropEffect} from './dataTransfer.js';
 */

/**
 * HTML drag and drop, done with a controller ray.
 *
 * A page that lets its elements be dragged says so with `draggable="true"`
 * and listens for the events the browser sends while a mouse carries one:
 * `dragstart` on what is picked up, `dragenter`, `dragover` and `dragleave`
 * on whatever it is carried over, `drop` where it is let go and `dragend`
 * back on what was picked up. A panel mirroring that page sends the same
 * events, in the same order, with the same rules for which of them may be
 * cancelled and what cancelling one means. So a list the page sorts by
 * dragging is sorted by the same handlers in the scene, and nothing about
 * the page has to know it is being pointed at rather than moused.
 *
 * The gesture is the mouse's. The trigger closes on a draggable element,
 * and while the hand has moved less than the scroll gesture's threshold it
 * is still a press, which becomes a click if it is let go. Past the
 * threshold it is a drag: `dragstart`, and from then on, once a frame,
 * `drag` on the source and `dragover` on the element under the ray. The
 * trigger opening is the drop. A drag, like a mouse drag, sends no
 * `mouseup` and no `click`, and from the press on the elements the ray
 * crosses hear no `mousemove` and take no hover flag, as a page's `:hover`
 * holds still under a drag.
 *
 * What is under the ray is worked out by the panel the ray is on, in its
 * own px, and it can be any element at all: a column that takes drops is
 * not a ray target, and does not have to be one to hear `dragover`. The
 * panel the drag started on and the panel it ends on need not be the same.
 * The events carry `clientX` and `clientY`, the point under the ray mapped
 * back onto the page's own layout, which is what a list asks to decide
 * whether a row goes above or below the one it is over.
 */

/**
 * How far in front of the panel the ghost is drawn, in the panel's px.
 * Toward the viewer is negative z under the container's half turn, and this
 * is well clear of any layer the panel stacks.
 */
const GHOST_Z = -64;

/** Drawn after everything else in the scene, so the panel never covers it. */
const GHOST_RENDER_ORDER = 1e9;

/**
 * What a panel answers when asked what is under a point: the deepest
 * element there and where on it the point is, or null.
 *
 * @callback ElementAt
 * @param {THREE.Vector3} point In world space.
 * @param {THREE.Vector2} local Written with the point in the returned
 *   element's own px.
 * @returns {HTMLElement | null}
 */

/**
 * The panels in the scene, by the object at the top of each, so that a ray
 * that lands anywhere in one can ask it what it landed on.
 *
 * @type {WeakMap<THREE.Object3D, ElementAt>}
 */
const panels = new WeakMap();

/**
 * Let a drag ask this panel what is under the ray. The portal registers
 * each panel it builds, and unregisters it when it goes.
 *
 * @param {THREE.Object3D} object The panel's container object.
 * @param {ElementAt} elementAt
 * @returns {() => void} Unregisters.
 */
export function registerPanel(object, elementAt) {
  panels.set(object, elementAt);
  return () => {
    panels.delete(object);
  };
}

/**
 * The container object of the panel an object is in, if it is in one.
 *
 * @param {THREE.Object3D | null} object
 * @returns {THREE.Object3D | null}
 */
function panelOf(object) {
  for (let node = object; node; node = node.parent) {
    if (panels.has(node)) {
      return node;
    }
  }
  return null;
}

/**
 * Whether the element asks to be dragged. Only `draggable="true"` counts.
 * Images and links are draggable on a page without saying so, but what a
 * browser drags out of them is a URL for another application, which a
 * headset has nowhere to put; counting them would only take scrolling away
 * from every list of links.
 *
 * `pointer-events: none` wins here as it does for `isClickable`: nothing
 * can pick up what cannot be pressed.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isDragSource(element) {
  // The style is read first, and always, for its invalidation: it is what
  // tells a reactive reader that an attribute changed, `draggable` included.
  const style = getComputedStyleCached(element);
  return (
    element.getAttribute("draggable") === "true" &&
    style.getPropertyValue("pointer-events") !== "none"
  );
}

/**
 * What a press on this element picks up: the element itself or its nearest
 * draggable ancestor within the panel, as on a page, where the label inside
 * a card drags the card.
 *
 * @param {HTMLElement} element
 * @returns {HTMLElement | null}
 */
export function findDragSource(element) {
  /** @type {HTMLElement | null} */
  let el = element;
  while (el) {
    if (isDragSource(el)) {
      return el;
    }
    if (el.hasAttribute(PORTAL_ATTRIBUTE)) {
      return null;
    }
    el = getParentElement(el);
  }
  return null;
}

/** @type {THREE.Vector3} */
const scratch = new THREE.Vector3();

/**
 * The deepest element under a point, among `element` and what is inside
 * it, found the way a page hit-tests: a later sibling is over an earlier
 * one, a child is over its parent, an element that `visibility` hides or
 * that says `pointer-events: none` is passed through to what is beneath,
 * and nothing is hit where an overflow-clipping ancestor cut it off.
 *
 * Asked in the same frames the mirror draws in: each element's object is
 * its own border box, top-left origin and y down, so the point is taken
 * into that frame and compared with the element's size and clip box. An
 * object the mirror has culled, a row scrolled out of its list, is not
 * visited and nor is anything in it. The walk visits every element in the
 * panel otherwise, since a child can overflow its parent, and it is only
 * asked while a drag is under way.
 *
 * @param {HTMLElement} element
 * @param {(node: Node) => THREE.Object3D | undefined} objectOf The panel's
 *   own record of which object draws which element.
 * @param {THREE.Vector3} point In world space.
 * @param {THREE.Vector2} local Written with the point in the found
 *   element's px.
 * @returns {HTMLElement | null}
 */
export function elementAt(element, objectOf, point, local) {
  const object = objectOf(element);
  if (!object || !object.visible) {
    return null;
  }
  // What is inside an `<svg>` is shapes in the picture's own coordinates,
  // not boxes; the `<svg>` is the target, as it is for a click.
  if (!isSvgRoot(element)) {
    for (let child = element.lastElementChild; child; child = child.previousElementSibling) {
      const hit = elementAt(/** @type {HTMLElement} */ (child), objectOf, point, local);
      if (hit) {
        return hit;
      }
    }
  }
  if (
    isVisibilityHidden(element) ||
    getComputedStyleCached(element).getPropertyValue("pointer-events") === "none"
  ) {
    return null;
  }
  object.worldToLocal(scratch.copy(point));
  const size = getBorderBoxSize(element);
  const clip = getLocalClipBox(element);
  if (
    scratch.x < 0 ||
    scratch.y < 0 ||
    scratch.x > size.width ||
    scratch.y > size.height ||
    scratch.x < clip.left ||
    scratch.y < clip.top ||
    scratch.x > clip.right ||
    scratch.y > clip.bottom
  ) {
    return null;
  }
  local.set(scratch.x, scratch.y);
  return element;
}

/**
 * The translucent card that follows the ray while a drag is under way, the
 * size of what is being dragged, drawn in the plane of the panel it came
 * from. A browser's drag image is a picture of the element; this is its
 * outline, which costs one quad in the material every box already uses.
 *
 * @param {HTMLElement} source
 * @param {number} width
 * @param {number} height
 */
function createGhost(source, width, height) {
  const material = createRectMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  const radius = Number.parseFloat(getComputedStyleCached(source).borderTopLeftRadius) || 0;
  const { uSize, uRadii, uBorder, uFillColor, uBorderColor } = material.uniforms;
  uSize.value.set(width, height);
  uRadii.value.set(radius, radius, radius, radius);
  uBorder.value.set(2, 2, 2, 2);
  uFillColor.value.set(1, 1, 1, 0.35);
  uBorderColor.value.set(0, 0, 0, 0.6);
  const mesh = new THREE.Mesh(rectGeometry, material);
  mesh.name = "drag-ghost";
  mesh.renderOrder = GHOST_RENDER_ORDER;
  // Never a ray target: it sits on the ray by construction, and would
  // otherwise be what every drag is over.
  mesh.raycast = () => {};
  return mesh;
}

/**
 * One hand's hold on one draggable element, from the press to the drop.
 *
 * @typedef {object} Session
 * @property {THREE.XRTargetRaySpace} controller
 * @property {HTMLElement} source
 * @property {THREE.Object3D} panel The container object of the source's
 *   panel, whose plane the hand is measured in and the ghost is drawn in.
 * @property {THREE.Plane} plane
 * @property {THREE.Vector2} start Where the press was, in the panel's px.
 * @property {THREE.Vector2} grab Where the press was, in the source's px.
 * @property {THREE.Vector2} client The last point under the ray, in the
 *   page's client coordinates.
 * @property {PanelDataTransfer | null} dataTransfer Null until the press
 *   has become a drag.
 * @property {THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null} ghost
 * @property {THREE.Vector2} hold Where the ghost is held, in its own px.
 * @property {Element | null} immediate The element under the ray.
 * @property {Element | null} current The element the drag is over, which
 *   hears `dragover` and `drop`.
 * @property {DropEffect} operation
 * @property {() => void} unlisten
 */

/**
 * @typedef {object} DragAndDrop
 * @property {(controller: THREE.XRTargetRaySpace, element: HTMLElement, object: THREE.Object3D) => boolean} begin
 *   Offer a press to the gesture. Taken, and true, when there is something
 *   draggable at or above the element; the press then belongs to it until
 *   the controller's own `selectend`.
 * @property {(controller: THREE.XRTargetRaySpace) => boolean} holding
 *   Whether the hand is holding something draggable: carrying it, or
 *   pressing it and not yet far enough from where it started for that to
 *   be a drag. The elements a ray crosses meanwhile are not hovered; the
 *   frame the press becomes a drag is one the ray has already moved in.
 * @property {(controller: THREE.XRTargetRaySpace) => boolean} didDrag
 *   Whether the hand's last press became a drag, which is what keeps the
 *   release from being a `mouseup` and a `click` as well.
 */

/**
 * @param {(tick: () => void) => () => void} requestFrames
 * @param {(controller: THREE.XRTargetRaySpace) => THREE.Intersection | undefined} readHit
 *   Where the controller's ray lands this frame.
 * @returns {DragAndDrop}
 */
export function createDragAndDrop(requestFrames, readHit) {
  /** @type {Map<THREE.XRTargetRaySpace, Session>} */
  const sessions = new Map();

  /** @type {WeakSet<THREE.XRTargetRaySpace>} */
  const dragged = new WeakSet();

  /** @type {(() => void) | null} */
  let stopFrames = null;

  const raycaster = new THREE.Raycaster();
  const onPlane = new THREE.Vector3();
  const inPanel = new THREE.Vector2();
  const local = new THREE.Vector2();

  /**
   * Where the hand's ray crosses the source panel's plane, in the panel's
   * px, written into `inPanel`; false when it points away from it.
   *
   * @param {Session} session
   * @returns {boolean}
   */
  function sample(session) {
    raycaster.setFromXRController(session.controller);
    if (!raycaster.ray.intersectPlane(session.plane, onPlane)) {
      return false;
    }
    session.panel.worldToLocal(onPlane);
    inPanel.set(onPlane.x, onPlane.y);
    return true;
  }

  /**
   * Send a drag event, with the drag's data store in the mode the event
   * allows and its `dropEffect` as the event starts with it.
   *
   * @param {Session} session
   * @param {string} type
   * @param {Element} target
   * @param {object} init
   * @param {boolean} init.cancelable
   * @param {"readwrite" | "protected" | "readonly"} [init.mode]
   * @param {DropEffect} [init.dropEffect]
   * @param {Element | null} [init.relatedTarget]
   * @returns {boolean} Whether a listener cancelled it.
   */
  function fire(
    session,
    type,
    target,
    { cancelable, mode = "protected", dropEffect = "none", relatedTarget = null },
  ) {
    const dataTransfer = /** @type {PanelDataTransfer} */ (session.dataTransfer);
    dataTransfer.setMode(mode);
    dataTransfer.dropEffect = dropEffect;
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable,
      composed: true,
      clientX: session.client.x,
      clientY: session.client.y,
      screenX: session.client.x,
      screenY: session.client.y,
      relatedTarget,
    });
    // A browser's own `dataTransfer` cannot carry an effect; see
    // `PanelDataTransfer`. The event is the browser's, the store is ours.
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    const proceed = target.dispatchEvent(event);
    dataTransfer.setMode("protected");
    return !proceed;
  }

  /**
   * The press has travelled far enough to be a drag: ask the page whether
   * it is one, and put the ghost up if it is.
   *
   * @param {Session} session
   * @returns {boolean} Whether the drag is on.
   */
  function start(session) {
    const { source, grab } = session;
    const rect = source.getBoundingClientRect();
    session.client.set(rect.left + grab.x, rect.top + grab.y);
    const dataTransfer = new PanelDataTransfer();
    session.dataTransfer = dataTransfer;
    if (fire(session, "dragstart", source, { cancelable: true, mode: "readwrite" })) {
      // The page said no. What follows is an ordinary press, as it is under
      // a mouse whose `dragstart` was cancelled.
      return false;
    }
    dragged.add(session.controller);
    const image = dataTransfer.getDragImage();
    let width;
    let height;
    if (image) {
      const imageRect = image.element.getBoundingClientRect();
      width = imageRect.width;
      height = imageRect.height;
      session.hold.set(image.x, image.y);
    } else {
      const size = getBorderBoxSize(source);
      width = size.width;
      height = size.height;
      session.hold.copy(grab);
    }
    const ghost = createGhost(source, width, height);
    placeAndScale(ghost, 0, 0, GHOST_Z, Math.max(width, 1e-6), Math.max(height, 1e-6), 1);
    session.panel.add(ghost);
    session.ghost = ghost;
    return true;
  }

  /**
   * One frame of a drag. It sends `drag` to the source and moves the target
   * to whatever is under the ray, in the order of the specification's
   * processing model: `dragenter` on the new target, `dragleave` on the old
   * one, `dragover` on the new one. The target is the element under the ray
   * whether or not it cancelled its `dragenter`, as in browsers. Cancelling
   * `dragover` is what says it takes the drop.
   *
   * @param {Session} session
   * @returns {void}
   */
  function step(session) {
    const dataTransfer = /** @type {PanelDataTransfer} */ (session.dataTransfer);
    /** @type {HTMLElement | null} */
    let under = null;
    const hit = readHit(session.controller);
    const panel = hit ? panelOf(hit.object) : null;
    if (hit && panel) {
      under = /** @type {ElementAt} */ (panels.get(panel))(hit.point, local);
      if (under) {
        const rect = under.getBoundingClientRect();
        session.client.set(rect.left + local.x, rect.top + local.y);
      }
    }
    if (fire(session, "drag", session.source, { cancelable: true })) {
      session.operation = "none";
      return;
    }
    if (under !== session.immediate) {
      session.immediate = under;
      const previous = session.current;
      if (under) {
        fire(session, "dragenter", under, {
          cancelable: true,
          dropEffect: initialDropEffect(dataTransfer.effectAllowed),
          relatedTarget: previous,
        });
      }
      session.current = under;
      if (previous && previous !== under) {
        fire(session, "dragleave", previous, { cancelable: false, relatedTarget: under });
      }
    }
    const current = session.current;
    if (!current) {
      session.operation = "none";
      return;
    }
    const accepted = fire(session, "dragover", current, {
      cancelable: true,
      dropEffect: initialDropEffect(dataTransfer.effectAllowed),
    });
    session.operation = accepted
      ? resolveOperation(dataTransfer.effectAllowed, dataTransfer.dropEffect)
      : "none";
  }

  /**
   * Let go: `drop` where the drag is over if the last `dragover` there took
   * it, `dragleave` there if not, and `dragend` on the source either way.
   *
   * @param {Session} session
   * @returns {void}
   */
  function finish(session) {
    sessions.delete(session.controller);
    if (!panels.has(session.panel)) {
      // The panel it came from was taken down, a portal disconnected or a
      // session ended, and the release it is waiting for may never come. A
      // browser cancels a drag it can no longer finish, and so does this.
      session.operation = "none";
    }
    session.unlisten();
    const { dataTransfer, current, ghost } = session;
    if (ghost) {
      ghost.removeFromParent();
      ghost.material.dispose();
    }
    if (!dataTransfer) {
      return;
    }
    if (current && session.operation !== "none") {
      const taken = fire(session, "drop", current, {
        cancelable: true,
        mode: "readonly",
        dropEffect: session.operation,
      });
      session.operation = taken
        ? resolveOperation(dataTransfer.effectAllowed, dataTransfer.dropEffect)
        : "none";
    } else {
      session.operation = "none";
      if (current) {
        fire(session, "dragleave", current, { cancelable: false });
      }
    }
    fire(session, "dragend", session.source, {
      cancelable: false,
      dropEffect: session.operation,
    });
  }

  function tick() {
    for (const session of sessions.values()) {
      if (!panels.has(session.panel)) {
        finish(session);
        continue;
      }
      if (!sample(session)) {
        if (session.ghost) {
          session.ghost.visible = false;
        }
        continue;
      }
      if (!session.dataTransfer) {
        if (inPanel.distanceTo(session.start) < DRAG_THRESHOLD) {
          continue;
        }
        if (!start(session)) {
          // Refused: the press carries on as a press, and the gesture lets
          // go of it.
          session.unlisten();
          sessions.delete(session.controller);
          continue;
        }
      }
      const ghost = /** @type {THREE.Mesh} */ (session.ghost);
      ghost.visible = true;
      placeAndScale(
        ghost,
        inPanel.x - session.hold.x,
        inPanel.y - session.hold.y,
        GHOST_Z,
        ghost.scale.x,
        ghost.scale.y,
        1,
      );
      step(session);
    }
    if (sessions.size === 0 && stopFrames) {
      stopFrames();
      stopFrames = null;
    }
  }

  return {
    begin(controller, element, object) {
      dragged.delete(controller);
      const previous = sessions.get(controller);
      if (previous) {
        finish(previous);
      }
      const source = findDragSource(element);
      const panel = panelOf(object);
      if (!source || !panel) {
        return false;
      }
      // The source's object is one parent object up per element between the
      // press and the source, as the scroll gesture walks to its scroller.
      /** @type {THREE.Object3D | null} */
      let sourceObject = object;
      for (
        let el = /** @type {HTMLElement | null} */ (element);
        el && el !== source;
        el = getParentElement(el)
      ) {
        sourceObject = sourceObject && getParentObject(sourceObject);
      }
      if (!sourceObject) {
        return false;
      }
      /** @type {Session} */
      const session = {
        controller,
        source,
        panel,
        plane: planeOf(panel, new THREE.Plane()),
        start: new THREE.Vector2(),
        grab: new THREE.Vector2(),
        client: new THREE.Vector2(),
        dataTransfer: null,
        ghost: null,
        hold: new THREE.Vector2(),
        immediate: null,
        current: null,
        operation: "none",
        unlisten: () => {},
      };
      if (!sample(session)) {
        return false;
      }
      session.start.copy(inPanel);
      sourceObject.worldToLocal(scratch.copy(onPlane));
      session.grab.set(scratch.x, scratch.y);
      // The release is the controller's own, heard here rather than through
      // the source's object: a page that moves the source while it is
      // dragged, which is how a list shows where the row will land, may
      // take its object down and the listeners on it with it.
      const onSelectEnd = () => finish(session);
      controller.addEventListener("selectend", onSelectEnd);
      session.unlisten = () => controller.removeEventListener("selectend", onSelectEnd);
      sessions.set(controller, session);
      if (!stopFrames) {
        stopFrames = requestFrames(tick);
      }
      return true;
    },
    holding(controller) {
      return sessions.has(controller);
    },
    didDrag(controller) {
      return dragged.has(controller);
    },
  };
}

/**
 * One drag-and-drop gesture per context, shared by every panel in the
 * scene, so a drag that starts in one panel can end in another.
 *
 * @type {WeakMap<WeakKey, DragAndDrop>}
 */
const perContext = new WeakMap();

/**
 * @param {WeakKey} ctx
 * @returns {DragAndDrop}
 */
export function dragAndDrop(ctx) {
  let gesture = perContext.get(ctx);
  if (!gesture) {
    const manager = InteractionContext.get(ctx);
    gesture = createDragAndDrop(createFrameRequester(ctx), (controller) =>
      // Read from a frame, which may be inside somebody else's computation;
      // the hit is a fact about this frame, not a dependency.
      withComputation(null, () => manager.pointers.get(controller)?.get()),
    );
    perContext.set(ctx, gesture);
  }
  return gesture;
}
