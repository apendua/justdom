import * as THREE from "three";
import { fakeFrameLoop } from "./frameLoop.js";
import { flushFrame } from "./portalHarness.js";

/**
 * @import { InteractionManager } from "../interactions.js";
 */

/**
 * A controller in the scene, registered with a real interaction manager, and
 * the things a test does with it. Its ray points straight down -z from where
 * it is put, so aimed at a spot on a panel it lands on exactly that spot.
 *
 * Every move is a frame: the manager's, which casts the ray and sends what it
 * met its events, and then the page's, in which the portal answers them.
 *
 * @param {InteractionManager} manager
 */
export function rayHand(manager) {
  const controller = /** @type {THREE.XRTargetRaySpace} */ (
    /** @type {unknown} */ (new THREE.Object3D())
  );
  const loop = fakeFrameLoop();
  const subscription = manager.addController(controller, loop.onAnimationFrame).subscribe();

  /** The hand moved: the manager's frame, and then the page's. */
  const moved = () => {
    controller.updateMatrixWorld(true);
    controller.dispatchEvent(/** @type {never} */ ({ type: "move" }));
    loop.run();
    flushFrame();
  };

  return {
    controller,
    /**
     * Point the ray at a spot on a panel, in its px, and let a frame go by.
     *
     * @param {THREE.Object3D} panel The portal's panel object, whose frame
     *   is the page's px.
     * @param {number} x
     * @param {number} y
     */
    aim(panel, x, y) {
      panel.updateWorldMatrix(true, true);
      const point = panel.localToWorld(new THREE.Vector3(x, y, 0));
      controller.position.set(point.x, point.y, point.z + 1);
      controller.rotation.set(0, 0, 0);
      moved();
    },
    /** Turn the hand round, so that its ray points away from every panel. */
    turnAway() {
      controller.rotation.set(0, Math.PI, 0);
      moved();
    },
    /**
     * Let a frame go by with the hand where it is.
     */
    frame() {
      loop.run();
      flushFrame();
    },
    /**
     * A button closing or opening, as three reports it from the session.
     *
     * @param {"selectstart" | "selectend" | "squeezestart" | "squeezeend"} type
     */
    trigger(type) {
      controller.dispatchEvent(/** @type {never} */ ({ type, data: null }));
    },
    /**
     * The hand going away, as three reports it: the space hidden, and
     * `disconnected` sent, as at the end of a session. Then a frame.
     */
    disconnect() {
      controller.visible = false;
      controller.dispatchEvent(/** @type {never} */ ({ type: "disconnected", data: null }));
      moved();
    },
    /** Take the controller off the manager. */
    remove() {
      subscription.unsubscribe();
    },
  };
}
