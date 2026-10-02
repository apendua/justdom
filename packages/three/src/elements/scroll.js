import * as THREE from "three";
import { InteractionContext } from "../interactions.js";
import { clipsOverflow, getComputedStyleCached, getParentElement, isPortalRoot } from "./mirror.js";
import { getParentObject } from "./contentGroup.js";
import { createFrameRequester } from "./frameRequester.js";
import { sampleRenderingUpdates, scrollElementBy } from "./renderingUpdates.js";

/**
 * Dragging a scrolling list with the controller ray.
 *
 * There is no wheel in a headset and nothing worth aiming a scrollbar thumb
 * at, so the gesture to mirror is the one every touchscreen already teaches:
 * take hold of the content and pull. Hold the trigger over a list that has
 * more in it than fits, move your hand, and the list follows.
 *
 * Two things make it feel like holding something rather than nudging it.
 *
 * The drag is measured in the scroller's *own* px — the ray is projected
 * onto the plane the list lies in, and that point converted through the
 * scroller's object — so a panel mounted at an angle, scaled down, or held
 * in the other hand needs no special case: a hand movement is worth however
 * much of that panel it covers.
 *
 * And it follows the ray rather than the thing the ray is touching. Hit
 * events only reach whatever the ray currently meets, so a drag driven by
 * them would stall the moment the hand slid off the row it grabbed — which
 * is precisely when a list is being dragged hardest. Sampling the ray
 * against the plane each frame means the list keeps up with the hand even
 * when the hand has left the panel entirely, and stops where the browser
 * clamps it.
 */

/**
 * How far a drag has to travel before it counts as scrolling rather than as
 * a slightly unsteady press. In px of the panel's own scale: a few px is a
 * fraction of a row, well under the tremor of an outstretched arm, and far
 * below the size of anything worth pressing. A press on something draggable
 * becomes a drag at the same distance (see `dragAndDrop.js`).
 */
export const DRAG_THRESHOLD = 6;

/**
 * How much of its speed a flick keeps per frame once released. Settles in
 * well under a second at 60Hz while still reading as a glide.
 */
const INERTIA_DECAY = 0.92;

/** Below this, in px per frame, the glide has arrived. */
const INERTIA_CUTOFF = 0.05;

/**
 * Whether an element scrolls: it clips what overflows, and there is more
 * inside it than fits.
 *
 * Both halves matter. A list styled `overflow: hidden` whose content happens
 * to fit is not something to take hold of — grabbing it should still press
 * the row under the ray — and it becomes draggable by itself once enough
 * rows are added, with nothing to tell it so.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isScrollable(element) {
  if (!clipsOverflow(getComputedStyleCached(element))) {
    return false;
  }
  return element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth;
}

/**
 * The scroller a gesture starting on this element should drive: the nearest
 * ancestor-or-self that can scroll, stopping at the portal's own container.
 *
 * @param {HTMLElement} element
 * @returns {HTMLElement | null}
 */
export function findScroller(element) {
  /** @type {HTMLElement | null} */
  let el = element;
  while (el && !isPortalRoot(el)) {
    if (isScrollable(el)) {
      return el;
    }
    el = getParentElement(el);
  }
  return null;
}

const planeOrigin = new THREE.Vector3();
const planeNormal = new THREE.Vector3();

/**
 * The plane a scroller's content lies in, in world space, taken from the
 * object's own orientation. Written into `target` and allocating nothing,
 * since a drag asks it of the panel under the ray every frame.
 *
 * @param {THREE.Object3D} space
 * @param {THREE.Plane} target
 * @returns {THREE.Plane}
 */
export function planeOf(space, target) {
  space.updateWorldMatrix(true, false);
  planeOrigin.setFromMatrixPosition(space.matrixWorld);
  planeNormal.set(0, 0, 1).transformDirection(space.matrixWorld);
  return target.setFromNormalAndCoplanarPoint(planeNormal, planeOrigin);
}

/**
 * One hand's hold on one list.
 *
 * @typedef {object} Drag
 * @property {HTMLElement} scroller
 * @property {THREE.Object3D} space The scroller's object, whose local space
 *   is the scroller's px.
 * @property {THREE.XRTargetRaySpace} controller
 * @property {THREE.Plane} plane Where the list lies, in world space.
 * @property {THREE.Vector2 | null} last Where the ray last crossed it.
 * @property {number} travelled Distance since taking hold, which is what
 *   separates a drag from a press.
 * @property {THREE.Vector2} velocity Local px per frame, for the glide.
 * @property {boolean} released Whether this is now a glide rather than a hold.
 * @property {boolean} moving Whether it has gone past `DRAG_THRESHOLD` and
 *   moved the list, which is when it counts in the scene's `MovingHands`.
 */

/**
 * The hands moving a list anywhere in one scene, each with how many lists
 * it is moving: one it holds and has dragged past `DRAG_THRESHOLD`, and any
 * still gliding after it let go. Every panel's gesture writes to its
 * scene's, so a question about the hand rather than about a panel can be
 * asked of any of them (see `movesList`).
 *
 * @typedef {Map<THREE.XRTargetRaySpace, number>} MovingHands
 */

/**
 * @typedef {object} ScrollDrags
 * @property {(controller: THREE.XRTargetRaySpace, element: HTMLElement, object: THREE.Object3D) => void} begin
 * @property {(controller: THREE.XRTargetRaySpace) => void} end
 * @property {(controller: THREE.XRTargetRaySpace) => boolean} didScroll
 * @property {(controller: THREE.XRTargetRaySpace) => boolean} scrolling Whether
 *   the hand is moving a list right now: holding one, or gliding it after
 *   letting go, until the glide retires.
 * @property {() => void} dispose
 */

/**
 * @param {(tick: () => void) => () => void} requestFrames
 * @param {MovingHands} [moving] The scene's, which this gesture adds its
 *   hands to once they move a list; one of its own when it has no scene.
 * @returns {ScrollDrags}
 */
export function createScrollDrags(requestFrames, moving = new Map()) {
  /** @type {Map<THREE.XRTargetRaySpace, Drag>} */
  const drags = new Map();

  /**
   * Let go of a hand's drag, and of its place in the scene's `moving` if
   * the drag had one.
   *
   * @param {THREE.XRTargetRaySpace} controller
   * @returns {void}
   */
  function drop(controller) {
    const drag = drags.get(controller);
    if (!drag) {
      return;
    }
    drags.delete(controller);
    if (drag.moving) {
      const count = (moving.get(controller) ?? 1) - 1;
      if (count > 0) {
        moving.set(controller, count);
      } else {
        moving.delete(controller);
      }
    }
  }

  /** @type {WeakSet<THREE.XRTargetRaySpace>} */
  const scrolled = new WeakSet();

  /** @type {(() => void) | null} */
  let stopFrames = null;

  const raycaster = new THREE.Raycaster();
  const hit = new THREE.Vector3();

  /**
   * Where this hand's ray crosses the list's plane, in the list's own px, or
   * null when the ray is parallel to it or pointing away.
   *
   * @param {Drag} drag
   * @returns {THREE.Vector2 | null}
   */
  function sample(drag) {
    raycaster.setFromXRController(drag.controller);
    if (!raycaster.ray.intersectPlane(drag.plane, hit)) {
      return null;
    }
    drag.space.worldToLocal(hit);
    return new THREE.Vector2(hit.x, hit.y);
  }

  function tick() {
    // This loop is frame-driven, so it is in a position to notice whether the
    // document is keeping up with it — which decides whether the scrolls
    // below have to announce themselves.
    sampleRenderingUpdates();
    for (const [controller, drag] of drags) {
      if (drag.released) {
        drag.velocity.multiplyScalar(INERTIA_DECAY);
        if (drag.velocity.length() < INERTIA_CUTOFF) {
          drop(controller);
          continue;
        }
        scrollElementBy(drag.scroller, drag.velocity.x, drag.velocity.y);
        continue;
      }
      const now = sample(drag);
      if (!now) {
        continue;
      }
      if (!drag.last) {
        drag.last = now;
        continue;
      }
      const dx = now.x - drag.last.x;
      const dy = now.y - drag.last.y;
      drag.last = now;
      drag.travelled += Math.hypot(dx, dy);
      if (drag.travelled < DRAG_THRESHOLD) {
        // Still inside the wobble of holding a controller still, so the press
        // is allowed to become a click.
        continue;
      }
      scrolled.add(controller);
      if (!drag.moving) {
        drag.moving = true;
        moving.set(controller, (moving.get(controller) ?? 0) + 1);
      }
      // The content follows the hand, so the viewport goes the other way.
      drag.velocity.set(-dx, -dy);
      scrollElementBy(drag.scroller, -dx, -dy);
    }
    if (drags.size === 0 && stopFrames) {
      stopFrames();
      stopFrames = null;
    }
  }

  function ensureFrames() {
    if (!stopFrames) {
      stopFrames = requestFrames(tick);
    }
  }

  return {
    begin(controller, element, object) {
      drop(controller);
      scrolled.delete(controller);
      const scroller = findScroller(element);
      if (!scroller) {
        return;
      }
      // The gesture is measured in the scroller's space, so walk up one
      // parent object per element between the two. Under a box that step is
      // two objects. The first is the box's content group, which a scroll
      // translates. The second is the box's own object, whose frame is its
      // border box and does not move while its content slides. Under an SVG
      // `<g>`, which has no content group, the step is one object.
      /** @type {THREE.Object3D | null} */
      let space = object;
      for (
        let el = /** @type {HTMLElement | null} */ (element);
        el && el !== scroller;
        el = getParentElement(el)
      ) {
        space = space && getParentObject(space);
      }
      if (!space) {
        return;
      }
      const drag = {
        scroller,
        space,
        controller,
        plane: planeOf(space, new THREE.Plane()),
        last: /** @type {THREE.Vector2 | null} */ (null),
        travelled: 0,
        velocity: new THREE.Vector2(0, 0),
        released: false,
        moving: false,
      };
      drag.last = sample(drag);
      drags.set(controller, drag);
      ensureFrames();
    },
    end(controller) {
      const drag = drags.get(controller);
      if (!drag) {
        return;
      }
      if (!scrolled.has(controller) || drag.velocity.length() < INERTIA_CUTOFF) {
        drop(controller);
        return;
      }
      // Hand the speed it was let go at to the glide, which the same loop
      // carries and retires.
      drag.released = true;
    },
    didScroll(controller) {
      return scrolled.has(controller);
    },
    scrolling(controller) {
      return drags.has(controller);
    },
    dispose() {
      for (const controller of [...drags.keys()]) {
        drop(controller);
      }
      if (stopFrames) {
        stopFrames();
        stopFrames = null;
      }
    },
  };
}

/**
 * One set of drags per context, so that the elements of a panel share the
 * gesture state a hand carries between them: a drag begins on a row and
 * goes on being that hand's drag wherever the ray travels next on the
 * panel. Each portal derives a context of its own, so this is one set per
 * panel, not per scene, and a list scrolled on one panel does not silence
 * the arrival pulses on another (drag and drop keeps its gesture per scene
 * for that reason; see `dragAndDrop`). What is per scene is `movesList`'s
 * answer, which every panel's set writes to.
 *
 * @type {WeakMap<WeakKey, ScrollDrags>}
 */
const perContext = new WeakMap();

/**
 * The hands moving a list in each scene, by the scene's interaction
 * manager, as drag and drop keeps its gesture.
 *
 * @type {WeakMap<object, MovingHands>}
 */
const perScene = new WeakMap();

/**
 * @param {WeakKey} ctx
 * @returns {MovingHands}
 */
function movingHands(ctx) {
  const manager = InteractionContext.get(ctx);
  let moving = perScene.get(manager);
  if (!moving) {
    moving = new Map();
    perScene.set(manager, moving);
  }
  return moving;
}

/**
 * @param {WeakKey} ctx
 * @returns {ScrollDrags}
 */
export function scrollDrags(ctx) {
  let drags = perContext.get(ctx);
  if (!drags) {
    drags = createScrollDrags(createFrameRequester(ctx), movingHands(ctx));
    perContext.set(ctx, drags);
  }
  return drags;
}

/**
 * Whether the hand is moving a list right now, on any panel of the scene:
 * holding one it has dragged past `DRAG_THRESHOLD`, or one still gliding
 * after it let go. Not a press resting on a list that has not moved yet,
 * which may still become a click. Where `scrolling` asks about one panel
 * and counts that pending press, this asks about the hand.
 *
 * @param {WeakKey} ctx
 * @param {THREE.XRTargetRaySpace} controller
 * @returns {boolean}
 */
export function movesList(ctx, controller) {
  return movingHands(ctx).has(controller);
}
