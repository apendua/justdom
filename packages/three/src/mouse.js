import * as THREE from "three";
import { Derived, effects, Signal } from "justdom-signal";
import { $ } from "./operators.js";
import { InteractionContext } from "./interactions.js";
import { getCamera, getXRSession, onLateFrame, RendererContext } from "./scene.js";
import { HOLD_MS, MIN_FOVY, PITCH_LIMIT, SLOP_PX } from "./limits.js";

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
 * What a drag that starts on nothing does: `"orbit"` turns the camera about
 * `around`, or in place when `around` is not given. Without `look` such a
 * drag does nothing, which is the default.
 *
 * `around` is only taken beside `look: "orbit"`, since without it nothing
 * orbits.
 *
 * `touch: false` leaves fingers to the page: the canvas keeps its own
 * `touch-action`, so a finger on it scrolls and zooms the page as it would
 * without this, and every pointer event a finger makes, and the context
 * menu a long press raises, passes by untouched. The mouse works as ever,
 * and so does a pen, but for one thing: the canvas's `touch-action` governs
 * a pen too, so where it lets the browser pan, a pen's drag can be taken
 * for a scroll. The browser then cancels the pen, and its press ends as a
 * hand that went, a miss that says `lost`. By default fingers are taken, as
 * `followMouse` says.
 *
 * @typedef {({ look?: undefined } | { look: "orbit", around?: THREE.Vector3Like }) & { touch?: boolean }} PointerOptions
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
 * a pinch (below). What the first one presses is decided by how it moves
 * after landing, and until that is decided the group stays aimed where it
 * landed:
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
 * hold as it became a grip. A long press is also how a phone starts
 * selecting text, and on a canvas with nothing to select it selects the
 * whole page, so while a finger is down no selection may start (the
 * `selectstart` the page hears is cancelled). All of this is
 * for `touch` on, the default;
 * with `touch: false` none of it happens, and a finger is the page's.
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
 * the wheel leaves it alone. A hand reaches into the room and the mouse
 * cannot, so this is how a thing picked up with the mouse is put down
 * further off or nearer. While the group holds nothing the wheel is the
 * page's, and scrolls it as ever.
 *
 * The pinch. Holding something, a pinch moves it nearer or further off;
 * holding nothing, it zooms. Which of the two it is, is settled as the
 * second finger lands, and a pinch stays what it started as:
 *
 * - A second finger that lands while the first holds a press and the group
 *   holds something starts a reach. While it lasts, a move of either finger
 *   moves what the group holds along the ray by the ratio of the fingers'
 *   spread: spread them twice as far apart and it comes to half the
 *   distance, as a pinch zooms in; close them and it goes further off,
 *   never nearer than `MIN_REACH`. The first finger still aims the group as
 *   it moves.
 * - A second finger that lands while the group holds nothing, and the first
 *   has pressed nothing (it is undecided, or its trigger began on nothing,
 *   as `pointsAtNothing` says, whether or not it turns the camera), starts
 *   a zoom, if the camera is a perspective one. A press that began on a
 *   thing, a button or a slider, refuses it, and so does a grip on
 *   anything, as a grab refuses a pinch on `justdom-xr`'s touch layer.
 *   The first finger's tap and hold are cancelled and its turn stops, the
 *   group is hidden, and from then on that finger aims, turns and presses
 *   nothing until it lifts, and starts no pinch: a second finger that
 *   lands after the zoom ended is ignored. While the zoom lasts, the
 *   camera's `zoom` goes as the fingers' spread: spread them twice as far
 *   apart and what is on the screen is drawn twice as large. It never
 *   zooms out past the camera's `zoom` as this started, nor in past a
 *   vertical field of view of `MIN_FOVY`.
 * - At any other time a second finger is ignored, and a third always is.
 * - The second finger's lift or cancel ends the pinch and nothing else. The
 *   first finger's ends the pinch and its own press, if it made one (a
 *   zoom's first finger lets go of a press that began on nothing, and a
 *   hidden group's release is a miss).
 * - The zoom stays where the last pinch left it until this stops, which
 *   puts the camera's `zoom` back. A turn and a ray follow the zoom, so
 *   both work the same at any zoom.
 *
 * The canvas. It has nothing to select, so while this runs it has
 * `user-select: none`, with `touch` or without: a long press on it, or a
 * mouse's drag that starts on it, selects none of the page.
 *
 * The pose is written as the group's own, so the group has to hang straight
 * off the scene.
 *
 * Returns the way to stop, which leaves the group hidden: the state it
 * starts in, so a later start (the one after a session ends) begins
 * pointing at nothing until the mouse moves onto the canvas again. The
 * canvas gets back the `touch-action` and `user-select` it had, and the
 * camera its `zoom`.
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
   * Whether the pointer is on nothing, as a press begins: never, for a
   * caller that cannot tell.
   */
  const onNothing = () => options.pointsAtNothing?.() ?? false;

  /**
   * Make the drag about to begin the camera's, if `look` asks for that and
   * the press began on nothing.
   *
   * @param {PointerEvent} event
   * @param {boolean} nothing
   */
  const startTurning = (event, nothing) => {
    if (options.look !== "orbit" || !nothing) {
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
   * `button` is null while what it presses is undecided, and `onNothing`
   * says whether its press began on nothing. `zoomed` says a zoom has
   * started on it, after which it drives nothing.
   *
   * @type {{
   *   id: number,
   *   x: number,
   *   y: number,
   *   landing: PointerEvent,
   *   now: { x: number, y: number },
   *   button: "select" | "squeeze" | null,
   *   hold: ReturnType<typeof setTimeout>,
   *   onNothing: boolean,
   *   zoomed: boolean,
   * } | null}
   */
  let finger = null;

  /**
   * The second finger of a pinch, while one is under way: where it is, how
   * far apart the two fingers were at the last move, and the camera it
   * zooms, or null for a pinch that moves what is held.
   *
   * @type {{
   *   id: number,
   *   x: number,
   *   y: number,
   *   spread: number,
   *   zoom: THREE.PerspectiveCamera | null,
   * } | null}
   */
  let pinch = null;

  // The camera's lens, if a pinch can zoom it: its `zoom` as this starts is
  // the widest, and the narrowest is the one that shows `MIN_FOVY`.
  const lens = /** @type {THREE.PerspectiveCamera} */ (camera).isPerspectiveCamera
    ? /** @type {THREE.PerspectiveCamera} */ (camera)
    : null;
  const wideZoom = lens?.zoom ?? 1;
  const maxZoom = lens
    ? Math.max(wideZoom, Math.tan(THREE.MathUtils.degToRad(lens.fov) / 2) / Math.tan(MIN_FOVY / 2))
    : 1;

  /** @param {number} zoom */
  const zoomTo = (zoom) => {
    if (lens && lens.zoom !== zoom) {
      lens.zoom = zoom;
      lens.updateProjectionMatrix();
    }
  };

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

  /**
   * Zoom in, or bring the held things nearer, by as much as the fingers
   * spread.
   */
  const pinchMove = () => {
    if (!pinch) {
      return;
    }
    const now = spread();
    if (now > 0 && pinch.spread > 0) {
      const ratio = pinch.spread / now;
      if (pinch.zoom) {
        zoomTo(THREE.MathUtils.clamp(pinch.zoom.zoom / ratio, wideZoom, maxZoom));
      } else {
        reachOut((reach) => reach * ratio);
      }
    }
    pinch.spread = now;
  };

  /** @param {"select" | "squeeze"} button */
  const press = (button, /** @type {PointerEvent} */ event) => {
    if (finger) {
      clearTimeout(finger.hold);
      finger.button = button;
      finger.onNothing = onNothing();
      if (button === "select") {
        startTurning(event, finger.onNothing);
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
      pinchMove();
      return;
    }
    if (!finger || event.pointerId !== finger.id) {
      return;
    }
    finger.now = { x: event.clientX, y: event.clientY };
    if (finger.zoomed) {
      pinchMove();
      return;
    }
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
    pinchMove();
  };
  const onLeave = (/** @type {PointerEvent} */ event) => {
    if (event.pointerType !== "touch") {
      pointer.visible = false;
    }
  };
  /** @param {PointerEvent} event */
  const onDown = (event) => {
    if (event.pointerType === "touch") {
      if (finger && !pinch && !finger.zoomed) {
        const holding = pointer.children.length > 0;
        const reach = holding && finger.button !== null;
        const zoom =
          !holding && (finger.button === null || (finger.button === "select" && finger.onNothing))
            ? lens
            : null;
        if (reach || zoom) {
          canvas.setPointerCapture(event.pointerId);
          pinch = { id: event.pointerId, x: event.clientX, y: event.clientY, spread: 0, zoom };
          pinch.spread = spread();
          if (zoom) {
            clearTimeout(finger.hold);
            finger.zoomed = true;
            turning = null;
            pointer.visible = false;
          }
          return;
        }
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
        onNothing: false,
        zoomed: false,
      };
      return;
    }
    const button = buttonOf(event);
    if (button) {
      follow(event);
      if (button === "select") {
        startTurning(event, onNothing());
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
      if (finger.zoomed) {
        if (finger.button !== null) {
          send(`${finger.button}end`);
          send(finger.button);
        }
        lift();
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
    if (event.pointerType !== "touch") {
      // A mouse is never cancelled. A pen is, where the canvas's
      // `touch-action` lets the browser take its drag for a scroll, as it
      // does under `touch: false`: no release is coming, so it ends as a
      // hand that went, and stops any turn it began. `disconnected` ends
      // every press the group holds, a finger's among them, so the finger
      // is let go here too and its lift is not heard.
      lift();
      send("disconnected");
      return;
    }
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

  const takesTouch = options.touch ?? true;
  /**
   * The listener itself, or with `touch: false` one that lets a finger's
   * events by. A context menu is a `PointerEvent` where the browser says
   * which pointer raised it; where it does not, it is kept off as a mouse's.
   *
   * @template {Event} E
   * @param {(event: E) => void} listener
   * @returns {(event: E) => void}
   */
  const unlessTouch = (listener) =>
    takesTouch
      ? listener
      : (event) => {
          if (/** @type {Partial<PointerEvent>} */ (event).pointerType !== "touch") {
            listener(event);
          }
        };
  const listeners = {
    move: unlessTouch(onMove),
    leave: unlessTouch(onLeave),
    down: unlessTouch(onDown),
    cancel: unlessTouch(onCancel),
    contextMenu: unlessTouch(onContextMenu),
    up: /** @type {EventListener} */ (unlessTouch(onUp)),
  };

  /** @param {Event} event */
  const onSelectStart = (event) => {
    if (finger) {
      event.preventDefault();
    }
  };

  // What the canvas had of the styles set here, to put back on stop. A
  // canvas has nothing to select, fingers or not, so it is unselectable
  // whenever this runs: a mouse's drag from it selects none of the page
  // either. Only the finger's `touch-action` waits for `touch`.
  const { style } = canvas;
  /** @type {("touchAction" | "userSelect" | "webkitUserSelect")[]} */
  const ownStyles = ["touchAction", "userSelect", "webkitUserSelect"];
  const hadStyles = ownStyles.map((name) => style[name]);
  style.userSelect = "none";
  style.webkitUserSelect = "none";
  if (takesTouch) {
    style.touchAction = "none";
    view.addEventListener("selectstart", onSelectStart);
  }
  canvas.addEventListener("pointermove", listeners.move);
  canvas.addEventListener("pointerleave", listeners.leave);
  canvas.addEventListener("pointerdown", listeners.down);
  canvas.addEventListener("pointercancel", listeners.cancel);
  canvas.addEventListener("contextmenu", listeners.contextMenu);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  view.addEventListener("pointerup", listeners.up);

  return () => {
    canvas.removeEventListener("pointermove", listeners.move);
    canvas.removeEventListener("pointerleave", listeners.leave);
    canvas.removeEventListener("pointerdown", listeners.down);
    canvas.removeEventListener("pointercancel", listeners.cancel);
    canvas.removeEventListener("contextmenu", listeners.contextMenu);
    canvas.removeEventListener("wheel", onWheel);
    view.removeEventListener("pointerup", listeners.up);
    view.removeEventListener("selectstart", onSelectStart);
    ownStyles.forEach((name, i) => {
      style[name] = hadStyles[i] ?? "";
    });
    lift();
    zoomTo(wideZoom);
  };
}

/**
 * The options `render()` mounts its mouse with, from its `pointer` option,
 * or `null` for no mouse. Left out, it is on with fingers left to the page
 * (`touch: false`), so a page that never asked for a pointer gets the mouse
 * and keeps its scrolling over the canvas. `true` is on with fingers taken,
 * an object is on as it says, and `false` is off.
 *
 * @param {boolean | PointerOptions | undefined} option
 * @returns {PointerOptions | null}
 */
export function renderPointer(option) {
  if (option === undefined) {
    return { touch: false };
  }
  if (option === true) {
    return {};
  }
  return option || null;
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
 * One canvas has one mouse: the one mounted on it last. It is the one
 * registered with the manager and the one listening to the canvas. Every
 * other `mouse(ctx)` on that canvas stands by, registered with nothing and
 * listening to nothing, and when the one driving unmounts, the one mounted
 * before it takes over again with its own options. So a scene can mount its
 * own beside the one `render(fn, { pointer })` gives it, whenever it
 * likes, and its own drives, with its options, for as long as it is
 * mounted.
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
      const renderer = RendererContext.get(ctx);
      if (miceOn(renderer.domElement).driver.get() !== pointer || getXRSession(ctx)) {
        return;
      }
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
    // Joining the stack reads nothing, so it is undone only on unmount. It
    // comes after the driving above, so that a handover always stops one
    // mouse before it starts the next: on mount this one is not driving yet
    // when it joins, and on unmount it has stopped before it leaves.
    effects(() => {
      const { mounted } = miceOn(RendererContext.get(ctx).domElement);
      mounted.set([...mounted.peek(), pointer]);
      return () => mounted.set(mounted.peek().filter((other) => other !== pointer));
    }),
  ]);
}

/**
 * The mice mounted on each canvas, in the order they mounted, and the one
 * of them that drives the canvas (`mouse`): the last. A mouse reads only
 * `driver`, so another joining or leaving behind it does not stop it and
 * start it again, which would let go of a press and put back the zoom.
 *
 * @typedef {{ mounted: Signal<THREE.Group[]>, driver: Derived<THREE.Group | undefined> }} Mice
 * @type {WeakMap<HTMLCanvasElement, Mice>}
 */
const mice = new WeakMap();

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Mice}
 */
function miceOn(canvas) {
  let found = mice.get(canvas);
  if (!found) {
    const mounted = Signal.of(/** @type {THREE.Group[]} */ ([]));
    found = { mounted, driver: Derived.of(() => mounted.get().at(-1)) };
    mice.set(canvas, found);
  }
  return found;
}
