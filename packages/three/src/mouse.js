import * as THREE from "three";
import { effects } from "justdom-signal";
import { $ } from "./operators.js";
import { InteractionContext } from "./interactions.js";
import { getCamera, getXRSession, onLateFrame, RendererContext } from "./render.js";

/**
 * @import { XREventMap } from './core.js';
 */

const FORWARD = new THREE.Vector3(0, 0, -1);
// A line of a wheel that scrolls by lines, as Firefox's can, in pixels.
const LINE_PX = 16;
// `WheelEvent`'s modes, spelled out rather than read off the class, which
// not every environment a scene is built in defines.
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
// Scratch for the camera's turn, which runs on every move of a drag.
const _euler = new THREE.Euler();
const _around = new THREE.Vector3();
const _forward = new THREE.Vector3();

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
 * How far one pixel of the wheel moves a held thing along the ray, in
 * metres: a notch of a usual wheel, 100 px, is 20 cm.
 */
export const WHEEL_METRES_PER_PIXEL = 0.002;

/**
 * The nearest the wheel brings a held thing, in metres along the ray: short
 * of the camera's near plane, where it would vanish.
 */
export const MIN_REACH = 0.2;

/**
 * Where a release is heard: the window, so a press let go off the canvas
 * still ends.
 *
 * @typedef {Pick<Window, "addEventListener" | "removeEventListener">} MouseView
 */

/**
 * How far the camera may pitch up or down while a drag turns it, in
 * radians: short of straight up and straight down, where yaw stops meaning
 * anything.
 */
export const PITCH_LIMIT = 1.4;

/**
 * What a drag that starts on nothing does: `"orbit"` turns the camera about
 * `around`, or in place when `around` is not given. Without `look` such a
 * drag does nothing, which is the default.
 *
 * `around` is only taken beside `look: "orbit"`, since without it nothing
 * orbits.
 *
 * @typedef {{ look?: undefined } | { look: "orbit", around?: THREE.Vector3Like }} PointerOptions
 *   `around` is the point the camera orbits, in the scene's coordinates.
 */

/**
 * `followMouse`'s own options: the drag on nothing (`PointerOptions`), and
 * how to tell nothing from something.
 *
 * @typedef {PointerOptions & { pointsAtNothing?: () => boolean }} FollowOptions
 *   `pointsAtNothing` is asked as a press of the trigger begins, with the
 *   group already aimed where it begins: true makes the drag the camera's.
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
 * another that lands while the first is down is ignored, unless it starts
 * a pinch (below). What the first
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
 * The camera. With `look: "orbit"`, a press of the trigger that begins on
 * nothing (`pointsAtNothing`), from the left button or from a finger,
 * makes the drag that follows the camera's. Each move turns it by the angle
 * the screen shows over the distance moved: yaw about the scene's up, and
 * pitch clamped at `PITCH_LIMIT`. Without `around` it turns where it
 * stands, so what is under the pointer stays under it. With `around` it
 * keeps its distance from that point and swings about it the other way, so
 * what is at the point follows the pointer, as an orbit does. The group
 * is aimed on each move as usual, and the press is still sent: it began on
 * nothing, so nothing hears it. The drag ends with the press.
 *
 * The wheel. What the group holds (`drag` puts what it picks up among the
 * group's children) the wheel moves along the ray: rolled forward, towards
 * the screen (`deltaY > 0`), it brings it nearer, as a wheel zooms in;
 * rolled back, towards you, it pushes it further off. It moves it by
 * `WHEEL_METRES_PER_PIXEL`, and never nearer than `MIN_REACH`. A `carry`
 * pins what it holds at its own distance and is not among the children, so
 * the wheel leaves it alone.
 *
 * The pinch, the wheel of a touch screen. A second finger that lands while
 * the first holds a press and the group holds something starts one; at any
 * other time a second finger is ignored, as above. While it lasts, a move
 * of either finger moves what the group holds along the ray by the ratio
 * of the fingers' spread: spread them twice as far apart and it comes to
 * half the distance, as a pinch zooms in; close them and it goes further
 * off, never nearer than `MIN_REACH`. The first finger still aims the
 * group as it moves. The second finger's lift or cancel ends the pinch and
 * nothing else; the first's ends the press and the pinch with it. A hand reaches into the room and the
 * mouse cannot, so this is how a thing picked up with the mouse is put
 * down further off or nearer. While the group holds nothing the wheel is
 * the page's, and scrolls it as ever.
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
 * @param {FollowOptions} [options]
 * @returns {() => void}
 */
export function followMouse(pointer, camera, canvas, view = window, options = {}) {
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

  /**
   * The drag that turns the camera, while one is under way: where the
   * pointer was at the last move, and the camera's heading.
   *
   * @type {{ x: number, y: number, yaw: number, pitch: number } | null}
   */
  let turning = null;

  /**
   * Make the drag about to begin the camera's, if `look` asks for that and
   * the pointer is on nothing.
   *
   * @param {PointerEvent} event
   */
  const startTurning = (event) => {
    if (options.look !== "orbit" || !options.pointsAtNothing?.()) {
      return;
    }
    _euler.setFromQuaternion(camera.quaternion, "YXZ");
    turning = { x: event.clientX, y: event.clientY, yaw: _euler.y, pitch: _euler.x };
  };

  /** @param {PointerEvent} event */
  const turn = (event) => {
    if (!turning) {
      return;
    }
    // The angle one pixel shows, from the vertical field of view the
    // projection holds.
    const perPixel =
      (2 * Math.atan(1 / camera.projectionMatrix.elements[5])) /
      canvas.getBoundingClientRect().height;
    const around = options.look === "orbit" ? options.around : undefined;
    // Turning in place, the camera turns against the drag, so the room
    // follows the pointer. Swinging about a point, it moves against the
    // drag, and so turns with it: what is at the point follows the pointer,
    // the table rather than the room behind it.
    const sign = around ? -1 : 1;
    turning.yaw += sign * (event.clientX - turning.x) * perPixel;
    turning.pitch = THREE.MathUtils.clamp(
      turning.pitch + sign * (event.clientY - turning.y) * perPixel,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
    turning.x = event.clientX;
    turning.y = event.clientY;
    const distance = around ? camera.position.distanceTo(_around.copy(around)) : 0;
    camera.quaternion.setFromEuler(_euler.set(turning.pitch, turning.yaw, 0, "YXZ"));
    if (around) {
      // Back from the point along the new heading, as far as it was.
      camera.position
        .copy(_around)
        .addScaledVector(_forward.copy(FORWARD).applyQuaternion(camera.quaternion), -distance);
    }
    camera.updateMatrixWorld(true);
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
   *   landing: PointerEvent,
   *   now: { x: number, y: number },
   *   button: "select" | "squeeze" | null,
   *   hold: ReturnType<typeof setTimeout>,
   * } | null}
   */
  let finger = null;

  /**
   * The second finger of a pinch, while one is under way: where it is, and
   * how far apart the two fingers were at the last move.
   *
   * @type {{ id: number, x: number, y: number, spread: number } | null}
   */
  let pinch = null;

  /**
   * Move everything the group holds along the ray, to the reach `to` gives
   * for the reach it is at, and never nearer than `MIN_REACH`.
   *
   * @param {(reach: number) => number} to
   */
  const reachOut = (to) => {
    for (const child of pointer.children) {
      // The ray is the group's -Z, so how far out a thing is held is the
      // negative of its z, and moving it along the ray changes z alone.
      child.position.z = -Math.max(MIN_REACH, to(-child.position.z));
      // Into the matrix by hand, for a thing that keeps its own (what a
      // portal draws does): `drag` writes those directly too.
      child.updateMatrix();
      child.updateMatrixWorld(true);
    }
  };

  /** How far apart the two fingers of the pinch are, in CSS pixels. */
  const spread = () =>
    finger && pinch ? Math.hypot(pinch.x - finger.now.x, pinch.y - finger.now.y) : 0;

  /** Bring the held things nearer by as much as the fingers spread. */
  const squeezeReach = () => {
    if (!pinch) {
      return;
    }
    const now = spread();
    if (now > 0 && pinch.spread > 0) {
      const ratio = pinch.spread / now;
      reachOut((reach) => reach * ratio);
    }
    pinch.spread = now;
  };

  /** @param {"select" | "squeeze"} button */
  const press = (button, /** @type {PointerEvent} */ event) => {
    if (finger) {
      clearTimeout(finger.hold);
      finger.button = button;
      if (button === "select") {
        startTurning(event);
      }
      send(`${button}start`);
    }
  };

  const lift = () => {
    if (finger) {
      clearTimeout(finger.hold);
      finger = null;
    }
    turning = null;
    pinch = null;
    pointer.visible = false;
  };

  /** @param {PointerEvent} event */
  const onMove = (event) => {
    if (event.pointerType !== "touch") {
      turn(event);
      follow(event);
      return;
    }
    if (pinch && event.pointerId === pinch.id) {
      pinch.x = event.clientX;
      pinch.y = event.clientY;
      squeezeReach();
      return;
    }
    if (!finger || event.pointerId !== finger.id) {
      return;
    }
    finger.now = { x: event.clientX, y: event.clientY };
    if (finger.button === null) {
      const dx = event.clientX - finger.x;
      const dy = event.clientY - finger.y;
      if (dx * dx + dy * dy <= SLOP_PX * SLOP_PX) {
        return;
      }
      // Pressed where it landed, which is where the group still points.
      press("select", finger.landing);
    }
    turn(event);
    aim(event);
    squeezeReach();
  };
  const onLeave = (/** @type {PointerEvent} */ event) => {
    if (event.pointerType !== "touch") {
      pointer.visible = false;
    }
  };
  /** @param {PointerEvent} event */
  const onDown = (event) => {
    if (event.pointerType === "touch") {
      if (finger && finger.button !== null && !pinch && pointer.children.length > 0) {
        // A second finger while the first holds something: a pinch.
        canvas.setPointerCapture(event.pointerId);
        pinch = { id: event.pointerId, x: event.clientX, y: event.clientY, spread: 0 };
        pinch.spread = spread();
        return;
      }
      if (finger || !event.isPrimary) {
        return;
      }
      canvas.setPointerCapture(event.pointerId);
      aim(event);
      finger = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        landing: event,
        now: { x: event.clientX, y: event.clientY },
        button: null,
        hold: setTimeout(() => press("squeeze", event), HOLD_MS),
      };
      return;
    }
    const button = buttonOf(event);
    if (button) {
      follow(event);
      if (button === "select") {
        startTurning(event);
      }
      send(`${button}start`);
    }
  };
  /** @param {PointerEvent} event */
  const onUp = (event) => {
    if (event.pointerType === "touch") {
      if (pinch && event.pointerId === pinch.id) {
        pinch = null;
        return;
      }
      if (!finger || event.pointerId !== finger.id) {
        return;
      }
      const button = finger.button ?? "select";
      if (finger.button === null) {
        press(button, event);
      } else {
        turn(event);
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
      if (button === "select") {
        turning = null;
      }
    }
  };
  /** @param {PointerEvent} event */
  const onCancel = (event) => {
    if (pinch && event.pointerId === pinch.id) {
      pinch = null;
      return;
    }
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
  /** @param {WheelEvent} event */
  const onWheel = (event) => {
    if (pointer.children.length === 0) {
      return;
    }
    event.preventDefault();
    const pixels =
      event.deltaMode === DOM_DELTA_LINE
        ? event.deltaY * LINE_PX
        : event.deltaMode === DOM_DELTA_PAGE
          ? event.deltaY * canvas.getBoundingClientRect().height
          : event.deltaY;
    reachOut((reach) => reach - pixels * WHEEL_METRES_PER_PIXEL);
  };

  const touchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  view.addEventListener("pointerup", /** @type {EventListener} */ (onUp));

  return () => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointercancel", onCancel);
    canvas.removeEventListener("contextmenu", onContextMenu);
    canvas.removeEventListener("wheel", onWheel);
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
 * its own, and the camera is expected to stand still between sessions but
 * for the turn `look: "orbit"` gives it: nothing but a mouse move re-aims
 * the ray, and that turn is made by a mouse move.
 *
 * `render(fn, { pointer: true })` mounts one for the whole scene. A scene
 * rendered that way does not mount another, or the page has two mice.
 *
 * `options` says what a drag that starts on nothing does (`PointerOptions`);
 * by default nothing.
 *
 * @param {WeakKey} ctx
 * @param {PointerOptions} [options]
 */
export function mouse(ctx, options = {}) {
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
      const stop = followMouse(pointer, camera, renderer.domElement, window, {
        ...options,
        pointsAtNothing: () =>
          !manager.getIntersection(
            /** @type {THREE.XRTargetRaySpace} */ (/** @type {unknown} */ (pointer)),
          ),
      });
      return () => {
        stop();
        registration.unsubscribe();
      };
    }),
  ]);
}
