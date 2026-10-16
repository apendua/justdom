/**
 * Ray events for a test that builds elements without a portal, sent as the
 * interaction manager sends them, to a panel set up as a portal sets one;
 * and `withStart`, the start every release carries, for any test that sends
 * a release by hand. Importing this module installs nothing.
 */
import * as THREE from "three";
import { createPanelForwarder, PointerForwarderContext } from "../elements/pointerForwarding.js";
import { createPanelScrollDrags, ScrollDragsContext } from "../elements/scroll.js";

/**
 * A panel's container and the context its elements are built with: the
 * panel's own scroll gesture, and a forwarder listening on the container,
 * as `createPortal` sets them. Put the elements' objects under `container`.
 *
 * @param {WeakKey} ctx A context with the interaction manager, and the
 *   panel's haptics if it has any.
 * @returns {{ ctx: WeakKey, container: THREE.Object3D }}
 */
export function forwardedPanel(ctx) {
  const container = new THREE.Object3D();
  const panel = ScrollDragsContext.set(ctx, createPanelScrollDrags(ctx));
  return {
    ctx: PointerForwarderContext.set(panel, createPanelForwarder(panel, container)),
    container,
  };
}

/**
 * A ray event sent the way the manager sends one: to the object the ray
 * met, and up through its parents, each told what the ray met. For a test
 * whose manager is a recording stand-in; with a real one, `dispatch`.
 *
 * @param {THREE.Object3D} object
 * @param {object} event
 */
export function bubble(object, event) {
  const sent = /** @type {never} */ ({ ...event, target: object, originalTarget: object });
  for (let node = /** @type {THREE.Object3D | null} */ (object); node; node = node.parent) {
    node.dispatchEvent(sent);
  }
}

/** @type {WeakMap<object, object>} Each hand's last `selectstart`. */
const starts = new WeakMap();

/**
 * A ray event as the manager sends it: a press's `selectstart` is kept for
 * the hand, and the events that end the press carry it as `start`.
 *
 * @template {{ type: string, controller: object }} E
 * @param {E} event
 * @returns {E}
 */
export function withStart(event) {
  if (event.type === "selectstart") {
    starts.set(event.controller, event);
  } else if (event.type === "select" || event.type === "selectend") {
    return { ...event, start: starts.get(event.controller) };
  }
  return event;
}

/**
 * Whether an object hangs anywhere under another: drawn in a panel rather
 * than detached from it, or under a group that hides it.
 *
 * @param {THREE.Object3D} object
 * @param {THREE.Object3D} ancestor
 * @returns {boolean}
 */
export function isUnder(object, ancestor) {
  for (let node = object.parent; node; node = node.parent) {
    if (node === ancestor) {
      return true;
    }
  }
  return false;
}
