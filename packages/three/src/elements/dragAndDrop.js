import * as THREE from "three";
import { withComputation } from "@apendua/signal";
import { InteractionContext } from "../interactions.js";
import { initialDropEffect, PanelDataTransfer, resolveOperation } from "./dataTransfer.js";
import { createFrameRequester } from "./frameRequester.js";
import { RendererContext } from "../render.js";
import {
  getBorderBoxSize,
  getComputedStyleCached,
  getLocalClipBox,
  getParentElement,
  isPortalRoot,
  isVisibilityHidden,
} from "./mirror.js";
import { placeAndScale } from "./place.js";
import { frameFor, getPanelFrame, measureClientRect, probePanelFrame } from "./panelFrame.js";
import { isSvgRoot } from "./plugins.js";
import { DRAG_THRESHOLD, planeOf } from "./scroll.js";
import { createRectMaterial, rectGeometry } from "./sdfRect.js";
import { snapshotsFor } from "./ghostSnapshot.js";

/**
 * @import {DropEffect} from './dataTransfer.js';
 * @import {PanelFrame} from './panelFrame.js';
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
 * Toward the viewer is negative z under the container's half turn. Close to
 * the panel, so that perspective does not move it off the row it outlines;
 * it is drawn over every layer the panel stacks by `depthTest` being off,
 * not by its distance.
 */
const GHOST_Z = -2;

/** How much of the scene a pictured ghost lets through, as a browser's does. */
const GHOST_OPACITY = 0.7;

/** Drawn after everything else in the scene, so the panel never covers it. */
const GHOST_RENDER_ORDER = 1e9;

/**
 * What a ray needs of a panel: its container object, its root element, its
 * own record of which object draws which element, which is also what says
 * what is under the ray (see `elementAt`), and where and at what scale the
 * page last laid the root element out (see `probePanel`).
 *
 * @typedef {object} Panel
 * @property {THREE.Object3D} object
 * @property {HTMLElement} element
 * @property {(node: Node) => THREE.Object3D | undefined} objectOf
 * @property {PanelFrame} frame The root element's frame, as last probed:
 *   its client corner and the scale the page draws it at; the corner is
 *   0,0 until one of the events `probePanel` names has read it.
 */

/**
 * The panels in the scene, by the object at the top of each, so that a ray
 * that lands anywhere in one can ask it what it landed on.
 *
 * @type {WeakMap<THREE.Object3D, Panel>}
 */
const panels = new WeakMap();

/**
 * Let a drag ask this panel what is under the ray and which object draws an
 * element, and a press where the ray is on the page. The portal registers
 * each panel it builds, and unregisters it when it goes.
 *
 * @param {THREE.Object3D} object The panel's container object.
 * @param {HTMLElement} element The panel's root element.
 * @param {(node: Node) => THREE.Object3D | undefined} objectOf
 * @returns {{ panel: Panel, unregister: () => void }} The record, as
 *   `getPanel` would find it, and what unregisters it.
 */
export function registerPanel(object, element, objectOf) {
  /** @type {Panel} */
  const panel = {
    object,
    element,
    objectOf,
    frame: getPanelFrame(element),
  };
  panels.set(object, panel);
  return {
    panel,
    unregister: () => {
      panels.delete(object);
    },
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
    if (isPortalRoot(el)) {
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
 * @returns {HTMLElement | null}
 */
function elementAt(element, objectOf, point) {
  const object = objectOf(element);
  if (!object || !object.visible) {
    return null;
  }
  // What is inside an `<svg>` is shapes in the picture's own coordinates,
  // not boxes; the `<svg>` is the target, as it is for a click.
  if (!isSvgRoot(element)) {
    for (let child = element.lastElementChild; child; child = child.previousElementSibling) {
      const hit = elementAt(/** @type {HTMLElement} */ (child), objectOf, point);
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
  return element;
}

/**
 * Where a point on a panel is on the page, in client coordinates: the point
 * taken into the frame of the element at the panel's top, its border box
 * with the origin at the top left and y down, scaled as the page scales
 * that element, and moved by where the page lays it out. The panel draws
 * what is inside the element where the page lays it out, scrolls included
 * and the transforms of what is inside, so the point is where a mouse over
 * the same spot on the page would be. A scale on the root element or above
 * it is in the mapping, as it is divided out of every rect the panel is
 * measured from (see `panelFrame.js`); a rotation, a skew, a flip or a
 * perspective is not, and the root warns about it, so on a root the page
 * turns the point is where the page would have it with the root unturned.
 *
 * It is what the mouse events a ray sends carry as `clientX` and `clientY`
 * (see `pressInit` and the others below), so that a page which works out
 * what was pressed from where it was pressed, a board drawn as one `<svg>`
 * path or a canvas, reads the place the ray met; and what a drag's events
 * carry. One matrix, a corner of the root element's client rect and a
 * scale, whatever the panel holds. The corner and the scale are the ones
 * last read by `probePanel`, so a caller asking for a point that has to be
 * exact probes first.
 *
 * The point is in the page's layout, so it is right for arithmetic against
 * the page's own rects, which is what a page that hit-tests by position
 * does. It is on screen only where the page shows the panel's element. A
 * panel built from a tree lives in a container the portal parks off
 * screen, so its points are off the viewport, and `elementFromPoint` finds
 * nothing at them.
 *
 * @param {Panel} panel As `getPanel` finds it.
 * @param {THREE.Vector3} point In world space, on the panel.
 * @param {THREE.Vector2} client Written with the point.
 * @returns {void}
 */
function clientPointOf(panel, point, client) {
  panel.object.worldToLocal(scratch.copy(point));
  clientPointAt(panel, scratch.x, scratch.y, client);
}

/**
 * Read where the page lays the panel's root element out, and at what scale,
 * for the points taken from then on. A client rect is a layout read, and a
 * forced one whenever the page has touched the DOM since the last, so it is
 * not taken for every point: a ray moving over a panel sends a point every
 * frame, and reads the corner it was last given. The events that are one
 * each probe first, and are exact however the page has moved since: a
 * press, its release and its click, a press on a scrolling list, the ray's
 * arrival on a control by the rule the hover pulse follows (see `arrived`
 * in `createPanelForwarder`), a drag's start, its arrival on another panel,
 * and its drop. A move, and a drag's other frames, are as exact as the
 * last of them, so a hover starts exact and drifts only by what the page
 * moves while the ray stays.
 *
 * @param {Panel} panel
 * @returns {void}
 */
export function probePanel(panel) {
  probePanelFrame(panel.element);
}

/**
 * `clientPointOf` for a point already in the panel's own px.
 *
 * @param {Panel} panel
 * @param {number} x
 * @param {number} y
 * @param {THREE.Vector2} client
 * @returns {void}
 */
function clientPointAt(panel, x, y, client) {
  const { frame } = panel;
  client.set(frame.left + x * frame.sx, frame.top + y * frame.sy);
}

/**
 * The panel an object is in, if it is in one.
 *
 * @param {THREE.Object3D | null} object
 * @returns {Panel | null}
 */
export function getPanel(object) {
  const panel = panelOf(object);
  return panel ? (panels.get(panel) ?? null) : null;
}

/**
 * `getPanel` for an object whose panel is asked for on every event: the
 * panel an object is in does not change over its life, so it is found
 * once, on the first ask rather than up front, since the portal registers
 * the panel after the object is built.
 *
 * @param {THREE.Object3D} object
 * @returns {() => Panel | null}
 */
export function lazyPanel(object) {
  /** @type {Panel | null} */
  let panel = null;
  return () => (panel ??= getPanel(object));
}

/** Scratch for where a ray event is on the page. */
const client = new THREE.Vector2();

/**
 * The init every mouse event a ray sends is made from, written in place for
 * each, and the pointer event a browser sends ahead of it. `MouseEvent` and
 * `PointerEvent` copy what they are given, so one object serves them all,
 * and a ray resting on a button, sending `pointermove` and `mousemove`
 * every frame, allocates nothing for it.
 *
 * A ray's pointer events say it is a mouse, which is what the mouse events
 * after them say too, and each hand is a pointer of its own, its
 * `pointerId` and the `buttons` it holds written in for each event by the
 * panel's forwarder (see `sendPointerAndMouse` in `pointerForwarding.js`);
 * each init below says none, for an event sent on no hand's behalf.
 *
 * @type {PointerEventInit}
 */
const init = {
  bubbles: false,
  cancelable: false,
  button: 0,
  buttons: 0,
  clientX: 0,
  clientY: 0,
  screenX: 0,
  screenY: 0,
  pointerId: 0,
  pointerType: "mouse",
  isPrimary: true,
};

/**
 * Write where on the page a ray event happened into `init`: the point the
 * ray met, in client coordinates, as `clientX` and `clientY`, and as
 * `screenX` and `screenY` too, since a panel has no screen of its own. A
 * page that finds what was pressed from where it was pressed, rather than
 * from the event's target, reads them.
 *
 * Only a point on the element's own panel is anywhere on its page. An
 * event whose ray is off it, onto nothing, onto another panel or onto the
 * scene, leaves them at 0, as they are on any event a script dispatches.
 * The point is in the page's layout, which is on screen only for a panel
 * mirroring an element the page shows; `clientPointOf` says what that
 * means for a panel built from a tree.
 *
 * @param {Panel | null} panel The panel the element is in, if it is in
 *   one; an object mounted under a test without a portal is in none.
 * @param {{ intersection?: THREE.Intersection }} e
 * @param {boolean} on Whether the ray is on the panel, which the events
 *   sent from what the ray met say by construction, and a release has to
 *   be asked.
 * @returns {void}
 */
function writePoint(panel, e, on) {
  let x = 0;
  let y = 0;
  if (e.intersection && panel && on) {
    clientPointOf(panel, e.intersection.point, client);
    x = client.x;
    y = client.y;
  }
  init.clientX = x;
  init.clientY = y;
  init.screenX = x;
  init.screenY = y;
}

/**
 * The init for the `mousedown` or `click` sent for a press on an element,
 * for the `contextmenu` the grip sends, or for the `click` a press on a
 * background sends, the panel's, an overlay's or a scrolling list's own.
 * One event each, so the panel is probed first and the point is taken
 * against where the page lays it out now. Valid until the next call: the
 * event is to be made from it at once.
 *
 * @param {Panel | null} panel The panel the element is in, as `getPanel`
 *   finds it.
 * @param {{ intersection?: THREE.Intersection }} e The `selectstart`,
 *   `select` or `squeeze`, whose intersection is on the element.
 * @param {boolean} cancelable
 * @param {number} [button] The mouse button the event says was pressed: the
 *   main one unless said otherwise, the secondary one (2) for the grip.
 * @returns {PointerEventInit}
 */
export function pressInit(panel, e, cancelable, button = 0) {
  init.bubbles = true;
  init.cancelable = cancelable;
  init.button = button;
  init.buttons = 0;
  if (panel) {
    probePanel(panel);
  }
  writePoint(panel, e, true);
  return init;
}

/**
 * The init for the `mouseup` sent for a press's release. One event, probed
 * like a press; but the ray may have wandered since the press, and only a
 * release on the element's own panel has a point on its page.
 *
 * @param {Panel | null} panel
 * @param {{ intersection?: THREE.Intersection }} e The `selectend`.
 * @returns {PointerEventInit}
 */
export function releaseInit(panel, e) {
  init.bubbles = true;
  init.cancelable = false;
  init.button = 0;
  init.buttons = 0;
  const on = !!e.intersection && getPanel(e.intersection.object) === panel;
  if (panel && on) {
    probePanel(panel);
  }
  writePoint(panel, e, on);
  return init;
}

/**
 * The init for the `mousemove` sent for a ray moving over an element: one
 * a frame, so the point is taken against where the panel was last probed,
 * and reads no layout. Sent once per move, from the innermost element the
 * ray is over, and it bubbles from there, as a mouse's does. Valid until
 * the next call.
 *
 * @param {Panel | null} panel
 * @param {{ intersection?: THREE.Intersection }} e The `pointermove`.
 * @returns {PointerEventInit}
 */
export function moveInit(panel, e) {
  init.bubbles = true;
  init.cancelable = false;
  init.button = 0;
  init.buttons = 0;
  writePoint(panel, e, true);
  return init;
}

/**
 * The translucent card that follows the ray while a drag is under way, the
 * size of the element it shows, the source or its drag image, drawn in the
 * plane of the panel the ray is on (see `placeGhost`). With a snapshot it is
 * a picture of the element, as a browser's drag image is (see
 * `ghostSnapshot.js`); without one, where there is no renderer to take it
 * with or the panel does not draw the element, it is the element's outline,
 * one quad in the material every box already uses.
 *
 * @param {Element} shown
 * @param {number} width
 * @param {number} height
 * @param {THREE.WebGLRenderTarget | null} snapshot
 * @returns {THREE.Mesh}
 */
function createGhost(shown, width, height, snapshot) {
  const mesh = snapshot ? picturedGhost(snapshot) : outlineGhost(shown, width, height);
  mesh.name = "drag-ghost";
  mesh.renderOrder = GHOST_RENDER_ORDER;
  // Never a ray target: it sits on the ray by construction, and would
  // otherwise be what every drag is over.
  mesh.raycast = () => {};
  return mesh;
}

/**
 * @param {THREE.WebGLRenderTarget} snapshot
 * @returns {THREE.Mesh}
 */
function picturedGhost(snapshot) {
  const material = new THREE.MeshBasicMaterial({
    map: snapshot.texture,
    // What the panel blends into a transparent target is premultiplied, so
    // it is composited once, as it is, with the opacity scaling colour and
    // alpha alike: the colour is the opacity as a grey.
    color: new THREE.Color(GHOST_OPACITY, GHOST_OPACITY, GHOST_OPACITY),
    opacity: GHOST_OPACITY,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    // The panel's shaders are not tone-mapped, so its picture must not be.
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(rectGeometry, material);
}

/**
 * @param {Element} shown
 * @param {number} width
 * @param {number} height
 * @returns {THREE.Mesh}
 */
function outlineGhost(shown, width, height) {
  const material = createRectMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  const radius = Number.parseFloat(getComputedStyleCached(shown).borderTopLeftRadius) || 0;
  const { uSize, uRadii, uBorder, uFillColor, uBorderColor } = material.uniforms;
  uSize.value.set(width, height);
  uRadii.value.set(radius, radius, radius, radius);
  uBorder.value.set(2, 2, 2, 2);
  uFillColor.value.set(1, 1, 1, 0.35);
  uBorderColor.value.set(0, 0, 0, 0.6);
  return new THREE.Mesh(rectGeometry, material);
}

/**
 * One hand's hold on one draggable element, from the press to the drop.
 *
 * @typedef {object} Session
 * @property {THREE.XRTargetRaySpace} controller
 * @property {HTMLElement} source
 * @property {THREE.Object3D} panel The container object of the source's
 *   panel, whose plane a press is measured in until it becomes a drag.
 * @property {THREE.Object3D} ghostPanel The panel the ghost is drawn in:
 *   the last one the ray was on, and the source's until it has been on
 *   another or when that one is taken down.
 * @property {THREE.Vector2} start Where the press was, in the panel's px.
 * @property {THREE.Vector2} grab Where the press was, in the source's px.
 * @property {THREE.Vector2} client The last point under the ray, in the
 *   page's client coordinates: `lastPoint` as last mapped.
 * @property {THREE.Object3D} lastPanel The panel the ray was last on, the
 *   source's until it has been on another: where `lastPoint` is.
 * @property {THREE.Vector2} lastPoint The last point under the ray, in
 *   `lastPanel`'s px, which the drop maps again once the page has been
 *   asked where that panel is.
 * @property {PanelDataTransfer | null} dataTransfer Null until the press
 *   has become a drag.
 * @property {THREE.Mesh | null} ghost
 * @property {THREE.WebGLRenderTarget | null} snapshot The picture the ghost
 *   carries, until the drag ends.
 * @property {THREE.Vector2} hold Where the ghost is held, in its own px.
 * @property {Element | null} immediate The element under the ray.
 * @property {Element | null} current The element the drag is over, which
 *   hears `dragover` and `drop`.
 * @property {DropEffect} operation
 * @property {() => void} unlisten
 */

/**
 * @typedef {object} DragAndDrop
 * @property {(controller: THREE.XRTargetRaySpace, element: HTMLElement, object: THREE.Object3D, allowed: boolean) => boolean} begin
 *   Tell the gesture about a press, every press, since a new press is what
 *   ends the last one's say over `didDrag`. Taken, and true, when the page
 *   allowed it, which is `false` when it cancelled the press's `mousedown`,
 *   and there is something draggable at or above the element; the press
 *   then belongs to it until the controller's own `selectend`.
 * @property {(controller: THREE.XRTargetRaySpace) => boolean} holding
 *   Whether the hand is holding something draggable: carrying it, or
 *   pressing it and not yet far enough from where it started for that to
 *   be a drag. The elements a ray crosses meanwhile are not hovered; the
 *   frame the press becomes a drag is one the ray has already moved in.
 * @property {(controller: THREE.XRTargetRaySpace) => boolean} didDrag
 *   Whether the hand's last press became a drag, which is what keeps the
 *   release from being a `mouseup` and a `click` as well.
 * @property {(controller: THREE.XRTargetRaySpace) => boolean} carrying
 *   Whether the hand is carrying something right now: its press became a
 *   drag, with a `dragstart` the page let through, and has not dropped.
 *   Not a press still short of being a drag, which `holding` counts.
 */

/**
 * @param {(tick: () => void) => () => void} requestFrames
 * @param {(controller: THREE.XRTargetRaySpace) => THREE.Intersection | undefined} readHit
 *   Where the controller's ray lands this frame.
 * @param {import('./ghostSnapshot.js').Snapshots} snapshots Pictures of
 *   what is dragged, for the ghost.
 * @returns {DragAndDrop}
 */
export function createDragAndDrop(requestFrames, readHit, snapshots) {
  /** @type {Map<THREE.XRTargetRaySpace, Session>} */
  const sessions = new Map();

  /** @type {WeakSet<THREE.XRTargetRaySpace>} */
  const dragged = new WeakSet();

  /** @type {(() => void) | null} */
  let stopFrames = null;

  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane();
  const onPlane = new THREE.Vector3();
  const inPanel = new THREE.Vector2();

  /**
   * Where the hand's ray crosses the source panel's plane, in world space in
   * `onPlane` and in the panel's px in `inPanel`; false when it points away
   * from it.
   *
   * @param {Session} session
   * @returns {boolean}
   */
  function sample(session) {
    raycaster.setFromXRController(session.controller);
    // Where the panel is now, not where it was at the press: a panel the
    // scene lets a hand carry can move while it is pressed.
    if (!raycaster.ray.intersectPlane(planeOf(session.panel, plane), onPlane)) {
      return false;
    }
    session.panel.worldToLocal(scratch.copy(onPlane));
    inPanel.set(scratch.x, scratch.y);
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
    // Still up: `tick` finishes a session whose panel has gone before it
    // gets here.
    const panel = /** @type {Panel} */ (panels.get(session.panel));
    probePanel(panel);
    session.lastPoint.copy(session.start);
    clientPointAt(panel, session.start.x, session.start.y, session.client);
    const dataTransfer = new PanelDataTransfer();
    session.dataTransfer = dataTransfer;
    if (fire(session, "dragstart", source, { cancelable: true, mode: "readwrite" })) {
      // The page said no. What follows is an ordinary press, as it is under
      // a mouse whose `dragstart` was cancelled.
      return false;
    }
    dragged.add(session.controller);
    // What the ghost shows: what `setDragImage` named, at its size, or the
    // source. An image with no size, a detached `<img>`, is no image.
    const image = dataTransfer.getDragImage();
    const imageRect = image && measureClientRect(image.element, frameFor(image.element));
    /** @type {Element} */
    let shown = source;
    let width = 0;
    let height = 0;
    if (image && imageRect && imageRect.width > 0 && imageRect.height > 0) {
      shown = image.element;
      width = imageRect.width;
      height = imageRect.height;
      session.hold.set(image.x, image.y);
    } else {
      ({ width, height } = getBorderBoxSize(source));
      session.hold.copy(grab);
    }
    // A picture of it as the panel draws it now, through the object the
    // panel has for it now: the page may have re-rendered it since the
    // press, and the mirror taken down the object it had then. Only of an
    // element the panel draws; one in another panel, culled or hidden would
    // be a picture of nothing, and is the outline instead.
    const object = panel.objectOf(shown);
    session.snapshot =
      object?.visible && !isVisibilityHidden(/** @type {HTMLElement} */ (shown))
        ? snapshots.take(session.panel, object, { x: 0, y: 0, width, height })
        : null;
    const ghost = createGhost(shown, width, height, session.snapshot);
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
   * @param {THREE.Intersection | undefined} hit Where the ray lands this
   *   frame.
   * @param {THREE.Object3D | null} panel The panel `hit` is in, if any.
   * @returns {void}
   */
  function step(session, hit, panel) {
    const dataTransfer = /** @type {PanelDataTransfer} */ (session.dataTransfer);
    /** @type {HTMLElement | null} */
    let under = null;
    if (hit && panel) {
      const registered = /** @type {Panel} */ (panels.get(panel));
      under = elementAt(registered.element, registered.objectOf, hit.point);
      if (panel !== session.lastPanel) {
        // Arriving on a panel probes it, as a ray arriving on an element
        // does (see `pointerForwarding.js`): this panel's own ray targets
        // may have had no arrival, since a column that takes drops is
        // rarely one, and the first frame on it would otherwise take a
        // corner nothing has read.
        probePanel(registered);
        session.lastPanel = panel;
      }
      panel.worldToLocal(scratch.copy(hit.point));
      session.lastPoint.set(scratch.x, scratch.y);
      // Once a frame, as a move is, so against the corner last probed.
      clientPointAt(registered, scratch.x, scratch.y, session.client);
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
      /** @type {THREE.Material} */ (ghost.material).dispose();
    }
    session.snapshot?.dispose();
    session.snapshot = null;
    if (!dataTransfer) {
      return;
    }
    // The release is one event, as the start was: the panel the ray was
    // last on is asked where the page lays it out now, so that `drop` and
    // `dragend` carry an exact point, whatever the page has moved since the
    // last frame. Not when that panel has been taken down since; the last
    // frame's point then stands.
    const last = panels.get(session.lastPanel);
    if (last) {
      probePanel(last);
      clientPointAt(last, session.lastPoint.x, session.lastPoint.y, session.client);
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

  /**
   * Put the ghost under the ray, in the panel the ray is on, so that it is
   * under the ray on whatever panel the drag is over, however that one is
   * turned. There it is where the ray landed, the point the drag's target
   * is found at too. Where the ray is on no panel, between the controls of
   * a panel that stops no rays or past a panel's edge, the ghost stays in
   * the last panel the ray was on, the source's until it has been on
   * another or once that one is taken down, where the ray crosses that
   * panel's plane. Hidden when the ray
   * points away from it.
   *
   * @param {Session} session
   * @param {THREE.Intersection | undefined} hit
   * @param {THREE.Object3D | null} panel The panel `hit` is in, if any.
   * @returns {void}
   */
  function placeGhost(session, hit, panel) {
    const ghost = /** @type {THREE.Mesh} */ (session.ghost);
    if (panel) {
      session.ghostPanel = panel;
    } else if (!panels.has(session.ghostPanel)) {
      // That panel was taken down, and nothing draws it any more.
      session.ghostPanel = session.panel;
    }
    const target = session.ghostPanel;
    if (ghost.parent !== target) {
      target.add(ghost);
    }
    if (hit && panel) {
      scratch.copy(hit.point);
    } else {
      raycaster.setFromXRController(session.controller);
      if (!raycaster.ray.intersectPlane(planeOf(target, plane), onPlane)) {
        ghost.visible = false;
        return;
      }
      scratch.copy(onPlane);
    }
    target.worldToLocal(scratch);
    ghost.visible = true;
    placeAndScale(
      ghost,
      scratch.x - session.hold.x,
      scratch.y - session.hold.y,
      GHOST_Z,
      ghost.scale.x,
      ghost.scale.y,
      1,
    );
  }

  function tick() {
    for (const session of sessions.values()) {
      if (!panels.has(session.panel)) {
        finish(session);
        continue;
      }
      if (!session.dataTransfer) {
        // Still a press, measured in the plane of the panel it is on.
        if (!sample(session) || inPanel.distanceTo(session.start) < DRAG_THRESHOLD) {
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
      const hit = readHit(session.controller);
      const panel = hit ? panelOf(hit.object) : null;
      placeGhost(session, hit, panel);
      step(session, hit, panel);
    }
    if (sessions.size === 0 && stopFrames) {
      stopFrames();
      stopFrames = null;
    }
  }

  return {
    begin(controller, element, object, allowed) {
      dragged.delete(controller);
      const previous = sessions.get(controller);
      if (previous) {
        finish(previous);
      }
      if (!allowed) {
        return false;
      }
      const source = findDragSource(element);
      const panel = panelOf(object);
      if (!source || !panel) {
        return false;
      }
      const sourceObject = /** @type {Panel} */ (panels.get(panel)).objectOf(source);
      if (!sourceObject) {
        return false;
      }
      /** @type {Session} */
      const session = {
        controller,
        source,
        panel,
        ghostPanel: panel,
        start: new THREE.Vector2(),
        grab: new THREE.Vector2(),
        client: new THREE.Vector2(),
        lastPanel: panel,
        lastPoint: new THREE.Vector2(),
        dataTransfer: null,
        ghost: null,
        snapshot: null,
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
      // take its object down and the listeners on it with it. A controller
      // lost, at the end of a session, sends no release: the drag is
      // cancelled, as a browser cancels one it can no longer finish.
      const onSelectEnd = () => finish(session);
      const onDisconnected = () => {
        session.operation = "none";
        finish(session);
      };
      controller.addEventListener("selectend", onSelectEnd);
      controller.addEventListener("disconnected", onDisconnected);
      session.unlisten = () => {
        controller.removeEventListener("selectend", onSelectEnd);
        controller.removeEventListener("disconnected", onDisconnected);
      };
      sessions.set(controller, session);
      snapshots.prepare(panel);
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
    carrying(controller) {
      return sessions.has(controller) && dragged.has(controller);
    },
  };
}

/**
 * One drag-and-drop gesture per scene, shared by every panel in it, so a
 * drag that starts in one panel can end in another and every panel knows a
 * hand is carrying something. Keyed by the scene's interaction manager,
 * not by the context: each portal derives a context of its own, and a
 * gesture per context was a gesture per panel, whose controls went on
 * being hovered under a drag from any other.
 *
 * @type {WeakMap<object, DragAndDrop>}
 */
const perScene = new WeakMap();

/**
 * The scene's renderer, or null where there is none, as under a test runner.
 *
 * @param {WeakKey} ctx
 * @returns {THREE.WebGLRenderer | null}
 */
function rendererOf(ctx) {
  try {
    return RendererContext.get(ctx);
  } catch {
    return null;
  }
}

/**
 * @param {WeakKey} ctx
 * @returns {DragAndDrop}
 */
export function dragAndDrop(ctx) {
  const manager = InteractionContext.get(ctx);
  let gesture = perScene.get(manager);
  if (!gesture) {
    // The gesture lives as long as the scene, and `ctx` is the context of
    // whichever portal asked first, with its batches, haptics and the rest
    // on it; held for the scene's life, they would outlive the portal. What
    // the gesture keeps is the renderer alone: frames are asked with a
    // context that carries it and nothing else, and without one fall back to
    // the browser's.
    const renderer = rendererOf(ctx);
    gesture = createDragAndDrop(
      createFrameRequester(renderer ? RendererContext.set({}, renderer) : {}),
      (controller) =>
        // Read from a frame, which may be inside somebody else's computation;
        // the hit is a fact about this frame, not a dependency.
        withComputation(null, () => manager.pointers.get(controller)?.get()),
      snapshotsFor(renderer),
    );
    perScene.set(manager, gesture);
  }
  return gesture;
}
