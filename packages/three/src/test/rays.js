/**
 * Ray events for a test that builds elements without a portal, sent as the
 * interaction manager sends them, to a panel set up as a portal sets one.
 * Importing this module installs nothing.
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
