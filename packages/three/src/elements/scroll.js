import * as THREE from "three";
import {
  clipsOverflow,
  getComputedStyleCached,
  getParentElement,
  PORTAL_ATTRIBUTE,
} from "./cache.js";
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
 * below the size of anything worth pressing.
 */
const DRAG_THRESHOLD = 6;

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
  while (el && !el.hasAttribute(PORTAL_ATTRIBUTE)) {
    if (isScrollable(el)) {
      return el;
    }
    el = getParentElement(el);
  }
  return null;
}

/**
 * The plane a scroller's content lies in, in world space, taken from the
 * object's own orientation.
 *
 * @param {THREE.Object3D} space
 * @param {THREE.Plane} target
 * @returns {THREE.Plane}
 */
function planeOf(space, target) {
  space.updateWorldMatrix(true, false);
  const origin = new THREE.Vector3().setFromMatrixPosition(space.matrixWorld);
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(space.matrixWorld).normalize();
  return target.setFromNormalAndCoplanarPoint(normal, origin);
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
 */

/**
 * @typedef {object} ScrollDrags
 * @property {(controller: THREE.XRTargetRaySpace, element: HTMLElement, object: THREE.Object3D) => void} begin
 * @property {(controller: THREE.XRTargetRaySpace) => void} end
 * @property {(controller: THREE.XRTargetRaySpace) => boolean} didScroll
 * @property {() => void} dispose
 */

/**
 * @param {(tick: () => void) => () => void} requestFrames
 * @returns {ScrollDrags}
 */
export function createScrollDrags(requestFrames) {
  /** @type {Map<THREE.XRTargetRaySpace, Drag>} */
  const drags = new Map();

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
          drags.delete(controller);
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
      drags.delete(controller);
      scrolled.delete(controller);
      const scroller = findScroller(element);
      if (!scroller) {
        return;
      }
      // The gesture is measured in the scroller's space, so walk up as many
      // objects as there are elements between the two.
      /** @type {THREE.Object3D | null} */
      let space = object;
      for (
        let el = /** @type {HTMLElement | null} */ (element);
        el && el !== scroller;
        el = getParentElement(el)
      ) {
        space = space ? space.parent : null;
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
        drags.delete(controller);
        return;
      }
      // Hand the speed it was let go at to the glide, which the same loop
      // carries and retires.
      drag.released = true;
    },
    didScroll(controller) {
      return scrolled.has(controller);
    },
    dispose() {
      drags.clear();
      if (stopFrames) {
        stopFrames();
        stopFrames = null;
      }
    },
  };
}

/**
 * One set of drags per context, so that every element in a scene shares the
 * gesture state a hand carries between them — a drag begins on a row and
 * goes on being that hand's drag wherever the ray travels next.
 *
 * @type {WeakMap<WeakKey, ScrollDrags>}
 */
const perContext = new WeakMap();

/**
 * @param {WeakKey} ctx
 * @returns {ScrollDrags}
 */
export function scrollDrags(ctx) {
  let drags = perContext.get(ctx);
  if (!drags) {
    drags = createScrollDrags(createFrameRequester(ctx));
    perContext.set(ctx, drags);
  }
  return drags;
}
