import * as THREE from "three";
import { effects } from "justdom-signal";
import { $ } from "./operators.js";
import { InteractionContext } from "./interactions.js";
import { getCamera, getXRSession, onLateFrame, RendererContext } from "./render.js";

/**
 * @import { XREventMap } from './core.js';
 */

const FORWARD = new THREE.Vector3(0, 0, -1);

/**
 * How long a finger has to stay still on the canvas before its press is the
 * grip's rather than the trigger's, in milliseconds.
 */
export const HOLD_MS = 400;

/**
 * How far a finger may wander, in CSS pixels, and still be a tap or a hold.
 * Further, and it is a drag with the trigger.
 */
export const SLOP_PX = 10;

/**
 * Where a release is heard: the window, so a press let go off the canvas
 * still ends.
 *
 * @typedef {Pick<Window, "addEventListener" | "removeEventListener">} MouseView
 */

/**
 * Keep `pointer` on the mouse, or on a finger: aimed from `camera` through
 * the point under it, and hidden whenever it is not on `canvas`, so that
 * showing it and hiding it follow from one fact.
 *
 * The mouse. Hidden until it first moves onto the canvas, and from then on
 * aimed on every move over it and hidden off it. The left button is the
 * trigger: a press on the canvas is `selectstart`, and the release is
 * `selectend` followed by `select`. The right button is the grip, in the
 * same way: `squeezestart`, then `squeezeend` and `squeeze`, and the
 * canvas's context menu is kept out of its way. A release is heard on
 * `view`, so a press let go over a page's panel still ends, and since the
 * release is not on the canvas the group is hidden for it and the manager
 * calls it a miss.
 *
 * A finger. It has no hover, so the group is shown from the moment it
 * lands and hidden again when it lifts. One finger drives it at a time:
 * another that lands while the first is down is ignored. What the first
 * one presses is decided by how it moves after landing, and until that is
 * decided the group stays aimed where it landed:
 *
 * - moving more than `SLOP_PX` makes it the trigger, pressed where it
 *   landed and then dragged with the finger;
 * - staying within `SLOP_PX` for `HOLD_MS` makes it the grip, pressed where
 *   it landed and then dragged with the finger;
 * - lifting within `SLOP_PX` before `HOLD_MS` is a tap, the trigger pressed
 *   and let go.
 *
 * The finger's lift ends the press it made. The browser cancelling it (a
 * system gesture, a palm) ends it too, as a hand that went rather than let
 * go: the group sends `disconnected`, which the manager turns into a miss
 * that says `lost`. While this runs the canvas has `touch-action: none`, so
 * the browser does not take a drag for a scroll or a zoom, and the finger is
 * captured, so it stays the canvas's when it slides off. The context menu
 * kept off the canvas matters to the finger as well: Android raises one on
 * a long press and, left to open, cancels the touch, which would end every
 * hold as it became a grip.
 *
 * The pose is written as the group's own, so the group has to hang straight
 * off the scene.
 *
 * Returns the way to stop, which leaves the group hidden: the state it
 * starts in, so a later start (the one after a session ends) begins
 * pointing at nothing until the mouse moves onto the canvas again. The
 * canvas gets back the `touch-action` it had.
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

  /** @param {string} type */
  const send = (type) => {
    pointer.dispatchEvent(/** @type {never} */ ({ type }));
  };

  /** @param {PointerEvent} event */
  const aim = (event) => {
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
    send("move");
  };

  /** @param {PointerEvent} event */
  const follow = (event) => {
    if (event.target !== canvas) {
      pointer.visible = false;
      return;
    }
    aim(event);
  };

  /**
   * The finger that drives the group, from its landing to its lift.
   * `button` is null while what it presses is undecided.
   *
   * @type {{
   *   id: number,
   *   x: number,
   *   y: number,
   *   button: "select" | "squeeze" | null,
   *   hold: ReturnType<typeof setTimeout>,
   * } | null}
   */
  let finger = null;

  /** @param {"select" | "squeeze"} button */
  const press = (button) => {
    if (finger) {
      clearTimeout(finger.hold);
      finger.button = button;
      send(`${button}start`);
    }
  };

  const lift = () => {
    if (finger) {
      clearTimeout(finger.hold);
      finger = null;
    }
    pointer.visible = false;
  };

  /** @param {PointerEvent} event */
  const onMove = (event) => {
    if (event.pointerType !== "touch") {
      follow(event);
      return;
    }
    if (!finger || event.pointerId !== finger.id) {
      return;
    }
    if (finger.button === null) {
      const dx = event.clientX - finger.x;
      const dy = event.clientY - finger.y;
      if (dx * dx + dy * dy <= SLOP_PX * SLOP_PX) {
        return;
      }
      // Pressed where it landed, which is where the group still points.
      press("select");
    }
    aim(event);
  };
  const onLeave = (/** @type {PointerEvent} */ event) => {
    if (event.pointerType !== "touch") {
      pointer.visible = false;
    }
  };
  /** @param {PointerEvent} event */
  const onDown = (event) => {
    if (event.pointerType === "touch") {
      if (finger || !event.isPrimary) {
        return;
      }
      canvas.setPointerCapture(event.pointerId);
      aim(event);
      finger = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        button: null,
        hold: setTimeout(() => press("squeeze"), HOLD_MS),
      };
      return;
    }
    const button = buttonOf(event);
    if (button) {
      follow(event);
      send(`${button}start`);
    }
  };
  /** @param {PointerEvent} event */
  const onUp = (event) => {
    if (event.pointerType === "touch") {
      if (!finger || event.pointerId !== finger.id) {
        return;
      }
      const button = finger.button ?? "select";
      if (finger.button === null) {
        press(button);
      } else {
        aim(event);
      }
      // Ended while the group is still shown: the manager casts the
      // release, and a hidden group would make every tap a miss.
      send(`${button}end`);
      send(button);
      lift();
      return;
    }
    const button = buttonOf(event);
    if (button) {
      follow(event);
      // A controller's `…end` is followed by the button's own event; the
      // manager turns the pair into a press or a miss.
      send(`${button}end`);
      send(button);
    }
  };
  /** @param {PointerEvent} event */
  const onCancel = (event) => {
    if (!finger || event.pointerId !== finger.id) {
      return;
    }
    const pressed = finger.button !== null;
    lift();
    if (pressed) {
      send("disconnected");
    }
  };
  /** @param {Event} event */
  const onContextMenu = (event) => {
    event.preventDefault();
  };

  const touchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("contextmenu", onContextMenu);
  view.addEventListener("pointerup", /** @type {EventListener} */ (onUp));

  return () => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointercancel", onCancel);
    canvas.removeEventListener("contextmenu", onContextMenu);
    view.removeEventListener("pointerup", /** @type {EventListener} */ (onUp));
    canvas.style.touchAction = touchAction;
    lift();
  };
}

/**
 * Which of a controller's buttons a mouse button is: the left the trigger,
 * the right the grip, any other none.
 *
 * @param {PointerEvent} event
 * @returns {"select" | "squeeze" | null}
 */
function buttonOf(event) {
  return event.button === 0 ? "select" : event.button === 2 ? "squeeze" : null;
}

/**
 * The mouse, as one more controller, for a scene that is also a page. A
 * finger on a touch screen drives it too (`followMouse` says how).
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
 * `render(fn, { pointer: true })` mounts one for the whole scene. A scene
 * rendered that way does not mount another, or the page has two mice.
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
