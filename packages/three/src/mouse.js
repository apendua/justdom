import * as THREE from "three";
import { effects } from "@apendua/signal";
import { $ } from "./operators.js";
import { InteractionContext } from "./interactions.js";
import { getCamera, getXRSession, onLateFrame, RendererContext } from "./render.js";

/**
 * @import { XREventMap } from './core.js';
 */

const FORWARD = new THREE.Vector3(0, 0, -1);

/**
 * Where a release is heard: the window, so a press let go off the canvas
 * still ends.
 *
 * @typedef {Pick<Window, "addEventListener" | "removeEventListener">} MouseView
 */

/**
 * Keep `pointer` on the mouse: hidden until the mouse first moves onto
 * `canvas`, aimed from `camera` through the point under the mouse whenever
 * an event is on the canvas, and hidden whenever one is anywhere else, so
 * that showing it and hiding it follow from one fact. A press of the left
 * button on the canvas and its release are the controller's `selectstart`
 * and `selectend`, followed by `select`; the release is heard on `view`, so
 * a press let go over a page's panel still ends, and since the release is
 * not on the canvas the group is hidden for it and the manager calls it a
 * miss.
 *
 * The pose is written as the group's own, so the group has to hang straight
 * off the scene.
 *
 * Returns the way to stop, which leaves the group hidden: the state it
 * starts in, so a later start (the one after a session ends) begins
 * pointing at nothing until the mouse moves onto the canvas again.
 *
 * @param {THREE.Object3D<XREventMap>} pointer
 * @param {THREE.Camera} camera
 * @param {HTMLElement} canvas
 * @param {MouseView} [view]
 * @returns {() => void}
 */
export function followMouse(pointer, camera, canvas, view = window) {
  pointer.visible = false;
  // Where the mouse is, in normalised device coordinates, until the next move.
  const at = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();

  /** @param {PointerEvent} event */
  const follow = (event) => {
    if (event.target !== canvas) {
      pointer.visible = false;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    at.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(at, camera);
    pointer.position.copy(raycaster.ray.origin);
    pointer.quaternion.setFromUnitVectors(FORWARD, raycaster.ray.direction);
    pointer.updateMatrixWorld(true);
    pointer.visible = true;
    pointer.dispatchEvent(/** @type {never} */ ({ type: "move" }));
  };
  const onLeave = () => {
    pointer.visible = false;
  };
  /** @param {PointerEvent} event */
  const onDown = (event) => {
    if (event.button !== 0) {
      return;
    }
    follow(event);
    pointer.dispatchEvent(/** @type {never} */ ({ type: "selectstart" }));
  };
  /** @param {PointerEvent} event */
  const onUp = (event) => {
    if (event.button !== 0) {
      return;
    }
    follow(event);
    // A controller's `selectend` is followed by `select`; the manager
    // turns the pair into a press or a miss.
    pointer.dispatchEvent(/** @type {never} */ ({ type: "selectend" }));
    pointer.dispatchEvent(/** @type {never} */ ({ type: "select" }));
  };

  canvas.addEventListener("pointermove", follow);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerdown", onDown);
  view.addEventListener("pointerup", /** @type {EventListener} */ (onUp));

  return () => {
    canvas.removeEventListener("pointermove", follow);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("pointerdown", onDown);
    view.removeEventListener("pointerup", /** @type {EventListener} */ (onUp));
    pointer.visible = false;
  };
}

/**
 * The mouse, as one more controller, for a scene that is also a page.
 *
 * The interaction manager routes a ray to the things it meets (hover,
 * press, release) but only ever casts from an XR controller. On a page there
 * is no controller and there is a mouse, so this stands an object in for
 * one: a group parked at the camera, turned to face where the mouse points,
 * registered with the manager exactly as a controller is. Every event a
 * controller gets, this gets, and what is pointed at cannot tell the two
 * apart. The cursor `cursors(ctx)` draws at a ray's hit lands on the page
 * too, which is the hover.
 *
 * The manager reads a controller's ray off its world matrix, so the group is
 * posed on every mouse move and the ray is cast in the late phase of the next
 * frame, as a controller's is, after everything that moves the scene has
 * moved it. While the mouse is off the canvas, and until it first moves onto
 * it, the group is hidden (`followMouse`), which is how the manager is told
 * the mouse points at nothing. The whole thing stands down for as long as a
 * session is presenting: the headset's canvas is the session's own, and a
 * click on it while the emulator is drawing a session is not a click in the
 * room.
 *
 * It goes straight into the scene's children, since its pose is written as
 * its own, and the camera is expected to stand still between sessions:
 * nothing but a mouse move re-aims the ray.
 *
 * @param {WeakKey} ctx
 */
export function mouse(ctx) {
  const pointer = /** @type {THREE.Group<XREventMap>} */ (new THREE.Group());
  pointer.name = "mouse";
  return $(pointer, [
    effects(() => {
      if (getXRSession(ctx)) {
        return;
      }
      const renderer = RendererContext.get(ctx);
      const camera = getCamera(ctx);
      const manager = InteractionContext.get(ctx);
      // The manager casts in the late phase, as it does for a controller
      // `render()` registers: after everything that moves the scene this
      // frame has moved it, so the hover and the cursor land on where things
      // are drawn rather than where they were a frame ago.
      const registration = manager
        .addController(
          /** @type {THREE.XRTargetRaySpace} */ (/** @type {unknown} */ (pointer)),
          (fn) => onLateFrame(ctx, fn),
        )
        .subscribe();
      const stop = followMouse(pointer, camera, renderer.domElement);
      return () => {
        stop();
        registration.unsubscribe();
      };
    }),
  ]);
}
